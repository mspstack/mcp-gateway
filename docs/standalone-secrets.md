# Standalone with secrets (static tokens + OpenBao)

The simplest production-shaped deployment: no identity provider required. Access is
controlled by **per-role bearer tokens**, and upstream API keys live in **OpenBao**
(or HashiCorp Vault — same KV v2 API), referenced as `bao:path#field` and resolved
only at connect time. Nothing secret is ever stored in SQLite or client config files.

Use this when:

- you don't have (or don't want to wire up) an OIDC provider,
- a small, known set of humans/agents connect and a shared token per role is acceptable,
- you want upstream credentials centralized and rotatable in one place.

> Secret stores are pluggable: if your infrastructure is Azure-based you can swap
> OpenBao for **Azure Key Vault** (`KEY_VAULT_URI`, `kv:secret-name` refs) with no
> other changes — see [Integrated mode](integrated-mode.md#azure-key-vault) for the
> Key Vault specifics. One store at a time (`BAO_ADDR` xor `KEY_VAULT_URI`).

## 1. Start the stack

The bundled compose file runs the gateway plus a **dev-mode** OpenBao on a private
network. Only the gateway is exposed; upstream MCP servers can join the same
internal network without ever being reachable from outside.

```bash
cp .env.example docker/.env
# edit docker/.env — at minimum set MCP_TOKENS_ADMIN (see below)
docker compose -f docker/docker-compose.yml up -d
```

The gateway listens on `http://localhost:3100`; the admin UI is at `/admin`.

> **Dev-mode OpenBao is in-memory and for evaluation only** — every restart wipes
> stored secrets. For production, run a sealed/unsealed OpenBao with persistent
> storage and switch the gateway to AppRole auth (step 4).

## 2. Create role tokens

Each `MCP_TOKENS_<ROLE>` env var carries a comma-separated `label:token` list for
that role. The role name is the (lowercased) suffix — the seeded roles are
`admin`, `editor`, `viewer`, and any custom role you create in the UI works the
same way (`MCP_TOKENS_ONCALL=…` → role `oncall`).

```bash
# one token per human/agent, labeled so you can tell them apart in logs
MCP_TOKENS_ADMIN="alice:$(openssl rand -hex 24)"
MCP_TOKENS_EDITOR="bob:$(openssl rand -hex 24),ci:$(openssl rand -hex 24)"
MCP_TOKENS_VIEWER="dashboard:$(openssl rand -hex 24)"
```

Rotation = change the value and restart. Tokens are compared timing-safely and
only logged as sha256 prefixes.

## 3. Store upstream secrets and reference them

Write secrets either from the **admin UI** (Servers → the upstream's secret
fields, or the dedicated secret-write form) or with the `bao` CLI:

```bash
bao kv put -mount=mspstack upstreams/itglue token="ITG.XXXXXXXX"
```

Then reference them from an upstream's headers/env — in the admin UI or in
`mspstack.config.json`:

```json
{
  "upstreams": [
    {
      "id": "itglue", "namespace": "itglue", "transport": "http",
      "url": "http://mcp-itglue:3000/mcp",
      "headers": { "Authorization": "Bearer bao:upstreams/itglue#token" }
    }
  ]
}
```

`bao:upstreams/itglue#token` = KV v2 path `upstreams/itglue`, field `token`, under
the mount from `BAO_MOUNT` (default `mspstack`). Values are fetched at upstream
connect time (with a 5-minute cache) and injected server-side — the connecting
client never sees them, and the client's own bearer token is **never** forwarded
upstream. Plain `${ENV_VAR}` references work too if you'd rather keep a secret in
the gateway's environment.

## 4. Production OpenBao: AppRole instead of a root token

Dev mode hands the gateway a root token (`BAO_TOKEN`). In production, run a real
OpenBao (raft storage, unsealed) and give the gateway a scoped AppRole:

```hcl
# policy: read-write on the gateway's mount only
path "mspstack/data/*"     { capabilities = ["create", "update", "read"] }
path "mspstack/metadata/*" { capabilities = ["list", "read"] }
```

```bash
bao auth enable approle
bao write auth/approle/role/mcp-gateway token_policies=mcp-gateway token_ttl=1h
bao read auth/approle/role/mcp-gateway/role-id          # → BAO_ROLE_ID
bao write -f auth/approle/role/mcp-gateway/secret-id    # → BAO_SECRET_ID
```

Gateway env (instead of `BAO_TOKEN`):

```bash
BAO_ADDR=https://openbao.internal:8200
BAO_MOUNT=mspstack
BAO_ROLE_ID=…
BAO_SECRET_ID=…
```

The gateway logs into AppRole on demand and re-authenticates when the lease
expires. `BAO_TOKEN` and AppRole are mutually exclusive alternatives — configure
exactly one.

## 5. Connect clients

```bash
claude mcp add --transport http mspstack http://localhost:3100/mcp \
  --header "Authorization: Bearer <token>"
```

Any MCP client that can send an `Authorization` header works the same way. The
token's role decides which tools the client sees and may call (viewer → read
tier, editor → write, admin → everything; tune per-upstream grants and per-tool
overrides in the admin UI — enforcement is re-checked on every call, not just at
list time).

## Minimal env recap

```bash
MCP_TOKENS_ADMIN="alice:<random>"        # + _EDITOR/_VIEWER/_<ROLE> as needed
BAO_ADDR=http://openbao:8200
BAO_TOKEN=<dev only>                     # or BAO_ROLE_ID + BAO_SECRET_ID (production)
BAO_MOUNT=mspstack                       # optional, this is the default
```

Want browser sign-in, per-user identity, and URL-only client connect instead of
shared tokens? Add an identity provider on top — see
[Standalone with OAuth (Entra ID)](standalone-oauth-entra.md). Static tokens and
OIDC coexist fine; tokens remain useful as break-glass and for non-OAuth clients.
