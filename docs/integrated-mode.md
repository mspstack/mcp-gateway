# Integrated mode (MSPStack platform)

`GATEWAY_MODE=integrated` runs the gateway as a **native MSPStack app**: Azure
Key Vault as the secret store, Entra ID as the identity provider, and the
`/me` self-service surface as the way users manage their own access and
credentials. Functionally it is the same gateway — integrated mode *enforces*
the combination rather than enabling hidden features:

- starts only with `KEY_VAULT_URI` **and** OIDC configured (refuses otherwise —
  same "no silent misconfig" posture as auth),
- which guarantees every user is a real Entra principal and personal
  credentials have a real vault to live in.

> The same Key Vault + Entra stack also runs fine in **standalone** mode — see
> [Standalone with OAuth (Entra ID)](standalone-oauth-entra.md). Choose
> `integrated` when the gateway is part of an MSPStack deployment and the
> platform expects the guarantees above to be load-bearing.

## Configuration

```bash
GATEWAY_MODE=integrated
PUBLIC_URL=https://mcp.example.com

# identity — full setup: docs/standalone-oauth-entra.md (steps 1–3)
ENTRA_TENANT_ID=<tenant id>
OIDC_AUDIENCE=api://<client-id>
AUTH_CLIENT_ID=<client id>
AUTH_CLIENT_SECRET=<secret>
SESSION_SECRET=<random ≥16 chars>
ADMIN_BOOTSTRAP_SUBJECTS=alice@example.com

# secret store
KEY_VAULT_URI=https://<vault>.vault.azure.net
```

The Entra app registration is identical to the standalone OAuth guide — follow
it and come back; nothing extra is registered for integrated mode.

## Azure Key Vault

Activated by `KEY_VAULT_URI` (must be `https://…`; mutually exclusive with
`BAO_ADDR` — one ref scheme at a time). Authentication uses
[`DefaultAzureCredential`](https://learn.microsoft.com/azure/developer/javascript/sdk/authentication/credential-chains):

- **in Azure** — give the gateway's managed identity the *Key Vault Secrets
  Officer* role on the vault (Officer, not just User: the gateway also writes
  secrets from the admin UI and `/me` credential forms),
- **locally** — `az login` or the `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/
  `AZURE_CLIENT_SECRET` env triple.

Upstream headers/env then use `kv:` refs, resolved at connect time with a
5-minute cache:

```json
{ "headers": { "Authorization": "Bearer kv:upstreams-itglue-token" } }
```

Key Vault secret names are flat (`[a-zA-Z0-9-]`), so where OpenBao uses
`path#field` the gateway writes `<path>-<field>` — the admin UI's secret-write
form and the `/me` credential forms do this mapping for you.

## What users get: `/me` self-service

Every signed-in principal (not just admins) gets:

- **My servers & tools** — their effective access, with personal enable/disable
  toggles that can only *narrow* the admin-granted envelope, never widen it
  (deny-only prefs, enforced at list *and* call time),
- **Personal credentials** — guided forms (labeled fields declared by the
  upstream, not raw header names) whose values go straight to Key Vault under
  `gw-user-<principal>-<upstream>-<field>`; SQLite keeps only the refs,
- **One-click Connect** — for upstreams with a `userConnect` block, a delegated
  Entra PKCE flow that stores the user's refresh token as their personal
  credential (setup: [standalone-oauth-entra.md, step 6](standalone-oauth-entra.md#6-optional-per-user-upstream-connect-second-app-public)),
- ready-to-copy connect snippets for Claude Code / Desktop / Cursor / VS Code.

Upstreams with `sessionMode: "per-user"` then run each caller's tool calls over
a **per-principal upstream session** carrying that user's own credentials —
e.g. PSA time entries and ticket notes are attributed to the actual technician,
not a service account. Credential *references* are layered per user and still
resolved through the secret store at connect time — the anti-passthrough rule
(inbound tokens never forwarded) holds unchanged. `requirePersonalCredentials`
on an upstream refuses the shared fallback outright for users who haven't
connected yet.

## Roadmap

The remaining integrated-mode piece is the MSPStack Toolbox "My MCP Access"
app (lives in the MSPStack hub repo); the gateway side — Key Vault store,
mode gate, `/api/me/*`, per-user sessions — is shipped and is what this page
describes.
