# Deploying on Coolify (or any container PaaS)

The other guides assume `docker compose` on a host you control, where volumes
outlive containers by default. A PaaS — Coolify, Dokku, Render, Fly, App Service —
**recreates the container on every deploy**. That changes exactly one thing, and
getting it wrong silently destroys your configuration:

> **Declare a named volume on `/data` before your first deploy.** The image
> declares `VOLUME /data`, so without an explicit mount Docker creates an
> *anonymous* volume — which the platform discards along with the old container.
> Every deploy then starts from an empty database.

Everything else (auth, secret store, upstreams) works exactly as in
[Standalone with secrets](standalone-secrets.md) or
[Standalone with OAuth](standalone-oauth-entra.md); pick one of those for the
auth/secrets half and use this guide for the hosting half.

## What lives on `/data`

SQLite at `/data/gateway.db` holds everything you configure at runtime:
upstreams, roles, per-upstream grants, per-tool overrides and settings, users,
and group mappings. The optional `/data/mspstack.config.json` sits beside it.
Both paths are already baked into the image (`DB_PATH`, `MSPSTACK_CONFIG`) — do
not override them unless you deliberately mount somewhere else.

Nothing secret is stored there: upstream credentials are `bao:`/`kv:`/`${ENV}`
references resolved at connect time. Losing `/data` costs you configuration, not
credentials — but reconstructing a populated gateway by hand is tedious enough
to be worth avoiding.

## 1. Create the application

Two ways to get an image:

**Build from the repository.** Point the platform at your fork/clone and set:

| Setting | Value |
| --- | --- |
| Build pack | `Dockerfile` |
| Dockerfile location | `docker/Dockerfile` — **not** the repository root |
| Base directory / context | `/` |
| Branch | `main` |
| Exposed port | `3100` |

The default "look for a `Dockerfile` in the root" behaviour fails here: the
Dockerfile lives under `docker/`, and it needs the repository root as its build
context (it copies `package.json`, the lockfile, and `packages/gateway/`).

**Or deploy the prebuilt image** — `ghcr.io/mspstack/mcp-gateway:latest`, published
on every push to `main`, also tagged `sha-<commit>`. Cheaper on the host than an
`npm ci` across workspaces on every deploy. Note it is **amd64 only**.

## 2. Add the persistent volume

Do this *before* the first deploy. In Coolify: **Storages → Add → Volume Mount**.

| Field | Value |
| --- | --- |
| Name | `gateway-data` |
| Destination path | `/data` |

**Use a named volume, not a host bind mount.** The container runs as `USER node`
(uid 1000). A fresh named volume inherits `/data`'s ownership from the image
(`node:node`), so SQLite can write immediately. A host directory arrives
root-owned, and the gateway dies on startup unable to open the database.

If you must bind-mount a host path, `chown 1000:1000` it first.

## 3. Environment

Minimum viable set:

```bash
PUBLIC_URL=https://mcp.example.com    # external URL — PRM metadata, redirect URIs, token issuer
MCP_TOKENS_ADMIN="me:<random>"        # or the OIDC set, see the OAuth guide
BAO_ADDR=https://openbao.internal:8200
BAO_ROLE_ID=… BAO_SECRET_ID=…         # or KEY_VAULT_URI instead of BAO_*
```

`PUBLIC_URL` must be the address clients actually reach, not the internal one —
it is echoed in discovery metadata and used to build redirect URIs.

With no auth configured the gateway **refuses to start**. That is deliberate: a
misconfigured deploy fails loudly instead of coming up wide open.

If your secret store is a sibling app on the same platform, point `BAO_ADDR` at
its internal hostname and keep it off the public network. Note that a dev-mode
OpenBao (`server -dev`) is in-memory — it needs its own persistent storage, or
your secrets vanish on *its* next restart, independently of the gateway's volume.

## 4. Deploy and verify

A healthy first boot logs:

```
[gateway] mcp-gateway v0.9.x
[auth] static tokens: admin(admin)
[secrets] OpenBao connected to https://… (mount "mspstack")
[gateway] serving 0 tool(s) from 0 upstream(s)
[gateway] MCP endpoint  http://localhost:3100/mcp
[gateway] admin UI      http://localhost:3100/admin
```

`0 upstream(s)` is correct on a fresh database. Open `/admin`, sign in with the
admin token, and add your first server.

## 5. Prove the volume works

Worth doing once, immediately — it is the whole point of this guide:

1. Add an upstream in `/admin`.
2. Trigger a redeploy.
3. Read the startup logs again.

If the volume is wired correctly the upstream connects **during boot**, before
the summary line:

```
[upstream:itglue] connected (http)
[gateway] serving 16 tool(s) from 1 upstream(s)
```

A non-zero upstream count on a fresh container is the proof. If you still see
`0 tool(s) from 0 upstream(s)`, the mount is not taking effect — recheck step 2
before configuring anything else.

## Deploying from the API

Useful for CI or scripted rollouts. Coolify's v1 API, with an API token from
`/security/api-tokens`:

```bash
# trigger
curl -s -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$COOLIFY_URL/api/v1/deploy?uuid=$APP_UUID&force=false"
# → {"deployments":[{"deployment_uuid":"…"}]}

# poll until finished / failed
curl -s -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$COOLIFY_URL/api/v1/deployments/<deployment_uuid>"

# container logs
curl -s -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$COOLIFY_URL/api/v1/applications/$APP_UUID/logs?lines=100"
```

The application UUID is the one in the app's own URL — a project or server UUID
returns `404` from these endpoints.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Configuration gone after every deploy | No named volume on `/data` — see step 2 |
| Container exits at startup, cannot open the database | Host bind mount owned by root; the process is uid 1000 |
| Build fails, `Dockerfile` not found | Dockerfile location must be `docker/Dockerfile`, context `/` |
| `Cannot GET /auth/login` after opening `/me` | Interactive login is not configured, so the route is not mounted. Static tokens carry a role, not an identity, and `/me` is per-user by design — it needs an OIDC issuer plus `AUTH_CLIENT_ID`/`AUTH_CLIENT_SECRET`/`SESSION_SECRET`. See [Standalone with OAuth](standalone-oauth-entra.md). `/admin` works with the token in the meantime. |
| Gateway refuses to start | No auth configured — set `MCP_TOKENS_<ROLE>` or the OIDC set |
| Upstream receives the literal string `bao:…` instead of the secret | An older build: secret refs used to resolve only when the ref was the *entire* value, so `Bearer bao:path#field` passed through verbatim. Update to a build where refs resolve anywhere inside the value. |
| Upstream rejects the credential with 401 | The stored secret probably includes the scheme. Keep the bare key in the store and the word `Bearer` in the header template, or you send `Bearer Bearer …`. |
| `Invalid upstream: … namespace must match [a-z0-9]+` | Namespaces are lowercase alphanumeric only — no underscores, hyphens, or capitals. Tools are exposed as `${namespace}_${tool}`, so a separator inside the namespace would make the name ambiguous. `id` must also be non-empty. |
