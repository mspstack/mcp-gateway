# MSPStack Gateway

A self-hosted **MCP manager**: one Model Context Protocol endpoint that federates all your MCP servers — with OAuth/token authentication, role-based tool access, per-tool enable/disable, OpenBao-backed secret storage, and an admin UI to install and manage servers.

Point Claude (Code, Desktop, or any MCP client) at a single URL; the gateway connects to your MCP servers — IT Glue, ConnectWise, Planner, or anything else — and exposes their tools under one roof. Credentials for upstream services live in the gateway's secret store (never in client config files), and what each user can see and call is centrally controlled.

## Features

- **One endpoint, many servers** — aggregates HTTP and stdio MCP servers with namespaced tools (`itglue_*`, `cw_*`, …) and live `tools/list_changed` propagation
- **OAuth 2.1 + static tokens** — resource-server auth per the MCP spec (Entra ID or any OIDC provider; RFC 9728 discovery, audience-bound tokens) plus `MCP_TOKENS_<ROLE>` bearer tokens for non-OAuth clients
- **Zero-config client connect (DCR)** — the gateway hosts its own OAuth authorization server facade (RFC 8414 metadata + RFC 7591 dynamic client registration + rotating refresh tokens), brokering user sign-in to your IdP; `claude mcp add <url>` connects with no pre-provisioned client id — URL only. Registered clients are managed (and revocable) from the admin UI
- **Roles & policy** — viewer/editor/admin (plus custom roles) gate tools by annotation-derived tiers (read/write/destructive), with per-upstream grants and per-tool allow/deny overrides; enforcement is re-checked at call time
- **Secrets stay server-side** — upstream API keys live in OpenBao (`bao:path#field` refs), Azure Key Vault (`kv:` refs), or env vars, injected at connect time; the inbound client token is never passed through to upstreams
- **Install from the UI** — one-click **presets** for the MSPStack family (IT Glue, ConnectWise PSA, Planner) that fill BYOK headers, per-user session mode, Connect wiring, and apply recommended role grants (extend with your own via `mspstack.presets.json`); or add any MCP server by URL, npm package (npx), or Docker image; search the official MCP registry; preflight-test before saving; crashed stdio servers restart with backoff
- **Guided user setup** — upstreams declare their personal-credential fields, so `/me` renders labeled forms (not raw header names), plus ready-to-copy connect snippets: Claude Code CLI (user-scope by default) and JSON config for Desktop/Cursor/VS Code
- **Admin UI** at `/admin` — status, server management, tool toggles, role matrix, users & group mappings (with live Entra group search when the login app holds the directory-read Graph roles), OAuth client management, secret writes

## Quick start

```bash
npm install && npm run build

export MCP_TOKENS_ADMIN="me:$(openssl rand -hex 24)"
npm run dev            # gateway on http://localhost:3100
```

Open `http://localhost:3100/admin`, sign in with the admin token, and add your first MCP server. Then connect Claude Code:

```bash
claude mcp add --transport http mspstack http://localhost:3100/mcp \
  --header "Authorization: Bearer <your token>"
```

For a real deployment, pick a scenario below.

## Choose your deployment

Auth and secret storage are independent axes: static tokens or OAuth on one side, OpenBao or Azure Key Vault on the other — any combination works in standalone mode. These are the three configurations we document end to end:

| Scenario | Auth | Secret store | Best for |
| --- | --- | --- | --- |
| [Standalone with secrets](docs/standalone-secrets.md) | static role tokens | OpenBao (or Key Vault) | no IdP; small known set of users/agents |
| [Standalone with OAuth](docs/standalone-oauth-entra.md) | Entra ID / OIDC (+ tokens as break-glass) | OpenBao **or** Key Vault | per-user identity, browser sign-in, URL-only connect |
| [Integrated (MSPStack)](docs/integrated-mode.md) | Entra ID (enforced) | Key Vault (enforced) | gateway as a native MSPStack platform app |

### Standalone with secrets

Per-role bearer tokens + OpenBao. No identity provider required; docker compose brings up the gateway and a dev OpenBao on a private network:

```bash
cp .env.example docker/.env   # set MCP_TOKENS_ADMIN
docker compose -f docker/docker-compose.yml up -d
```

```bash
MCP_TOKENS_ADMIN="alice:<random>"      # label:token,… per role
BAO_ADDR=http://openbao:8200
BAO_TOKEN=…                            # dev; production uses BAO_ROLE_ID/BAO_SECRET_ID
```

Upstream credentials are stored in OpenBao and referenced as `bao:path#field` — resolved server-side at connect time, never visible to clients. **Guide: [docs/standalone-secrets.md](docs/standalone-secrets.md)** — compose walkthrough, token management, writing secrets, production AppRole setup.

### Standalone with OAuth (Entra ID)

Users sign in with Microsoft to `/admin` and `/me`; MCP clients connect with the URL alone via the gateway's DCR facade; roles map from Entra groups. One confidential Entra app registration covers token validation, browser login, and the AS facade:

```bash
PUBLIC_URL=https://mcp.example.com
ENTRA_TENANT_ID=<tenant id>            # or OIDC_ISSUER for any OIDC provider
OIDC_AUDIENCE=api://<client-id>        # required with an issuer
AUTH_CLIENT_ID=… AUTH_CLIENT_SECRET=… SESSION_SECRET=…   # all three together
ADMIN_BOOTSTRAP_SUBJECTS=alice@example.com
```

Pair it with either secret store — OpenBao, or Azure Key Vault (`KEY_VAULT_URI`) if you're already an Entra shop; standalone + Entra + Key Vault is a first-class combination. **Guide: [docs/standalone-oauth-entra.md](docs/standalone-oauth-entra.md)** — step-by-step Entra app registration (audience, redirect URI, groups claim, Graph permissions), DCR client connect, per-user Connect app, troubleshooting.

### Integrated (MSPStack)

The gateway as a native MSPStack app: `GATEWAY_MODE=integrated` *enforces* Key Vault + Entra (refuses to start without them), guaranteeing real principals for `/me` self-service — personal credentials in Key Vault, narrow-only tool prefs, and `sessionMode: "per-user"` upstreams that run each caller's calls over their own credentials:

```bash
GATEWAY_MODE=integrated
KEY_VAULT_URI=https://<vault>.vault.azure.net
ENTRA_TENANT_ID=… OIDC_AUDIENCE=…      # + AUTH_CLIENT_ID/SECRET, SESSION_SECRET
```

**Guide: [docs/integrated-mode.md](docs/integrated-mode.md)** — Key Vault auth (managed identity), `kv:` refs, the `/me` surface, per-user upstream sessions.

## Configuration reference

| Env | Purpose |
| --- | --- |
| `MCP_TOKENS_ADMIN` / `_EDITOR` / `_VIEWER` / `_<ROLE>` | static bearer tokens, `label:token,…` |
| `ENTRA_TENANT_ID` or `OIDC_ISSUER` + `OIDC_AUDIENCE` | OAuth 2.1 resource-server mode (`OIDC_AUDIENCE` required with an issuer) |
| `OIDC_GROUPS_CLAIM` | token claim holding group ids (default `groups`) |
| `ADMIN_BOOTSTRAP_SUBJECTS` | emails/subs that get admin on first OIDC login |
| `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` / `SESSION_SECRET` (+ optional `AUTH_REDIRECT_URI`) | interactive login (cookie + PKCE) — browser sign-in for `/admin` and `/me`, and enables the OAuth AS facade (DCR); all-or-nothing, requires an issuer |
| `GATEWAY_JWT_SECRET` | HS256 key for gateway-issued access tokens; optional — defaults to a key derived from `SESSION_SECRET` |
| `BAO_ADDR` + `BAO_TOKEN` or `BAO_ROLE_ID`/`BAO_SECRET_ID`, `BAO_MOUNT` | OpenBao secret store (`bao:path#field` refs) |
| `KEY_VAULT_URI` | Azure Key Vault via `DefaultAzureCredential` (`kv:secret-name` refs; one store at a time) |
| `GATEWAY_MODE` | `standalone` (default) or `integrated` — integrated requires `KEY_VAULT_URI` + OIDC |
| `PORT`, `PUBLIC_URL`, `DB_PATH`, `ALLOWED_ORIGINS` | plumbing |
| `DEV_ALLOW_UNAUTHENTICATED=true` | localhost-dev only; without any auth configured the gateway refuses to start |

All knobs are documented inline in [`.env.example`](.env.example).

Upstreams are managed in the admin UI (stored in SQLite) and/or declared in `mspstack.config.json` (upserted at boot; see `mspstack.config.example.json`). Header/env values accept `${ENV_VAR}`, `bao:path#field`, and `kv:secret-name` references — resolved at connect time, never stored:

```json
{
  "upstreams": [
    {
      "id": "itglue", "namespace": "itglue", "transport": "http",
      "url": "http://mcp-itglue:3000/mcp",
      "headers": { "Authorization": "Bearer bao:upstreams/itglue#token" }
    },
    {
      "id": "everything", "namespace": "demo", "transport": "stdio",
      "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"]
    }
  ]
}
```

## Security model

- The gateway is an **OAuth 2.1 resource server** (MCP authorization spec 2025-11-25): RFC 9728 metadata at `/.well-known/oauth-protected-resource`, `WWW-Authenticate` discovery on 401, and strict audience validation — tokens minted for other resources are rejected.
- With interactive login configured it is also an **authorization server facade** for MCP clients (IdPs like Entra have no anonymous DCR): RFC 7591 registration (public clients, PKCE S256 mandatory, exact `redirect_uri` match, loopback-http/https only, rate-limited), single-use 60-second authorization codes stored hashed, and short-lived HS256 access tokens that carry **identity only** — the role is re-resolved from the database on every request. User authentication is brokered to your IdP; the gateway never sees passwords.
- **Rotating refresh tokens** (OAuth 2.1): every refresh burns the old token and issues a successor; replaying a rotated token revokes its whole family, cutting off whoever holds the stolen descendant. Deleting a client from the admin UI revokes its refresh tokens immediately.
- **Anti-passthrough:** inbound client tokens are used only to resolve identity; upstream credentials come exclusively from the secret store / env and are injected server-side.
- Tool authorization is two-layer: `tools/list` filtering is UX; the call-time policy check is the boundary. Sessions are principal-bound — a session id alone grants nothing.

Requires **Node ≥ 24** (built-in `node:sqlite` — no native dependencies).

Part of **MSPStack** — a family of MCP tooling for MSPs: [mcp-itglue](https://github.com/mspstack/mcp-itglue), [mcp-connectwise-psa](https://github.com/mspstack/mcp-connectwise-psa), [mcp-planner](https://github.com/mspstack/mcp-planner).

## Roadmap

CIMD client registration (`https://` client ids) · resources/prompts federation · npm pre-install pool.

Shipped from the MSPStack integrated-mode plan (`docs/plans/gateway-integrated-mode.md` in the MSPStack repo): Azure Key Vault secret store (`kv:` refs), `GATEWAY_MODE`, `/api/me` self-service (narrow-only tool prefs + personal upstream credentials), and `sessionMode: "per-user"` — per-principal upstream sessions running each caller's calls over their own registered credentials (PSA write attribution).

## Author

Built by **Eugene Samotija** ([@selic](https://github.com/selic)) — [defency.net](https://defency.net).
More projects: [github.com/selic](https://github.com/selic) · [LinkedIn](https://www.linkedin.com/in/evghenii-samotiia)

## License

MIT
