# Standalone with OAuth — Entra ID setup guide

This guide wires the gateway to **Microsoft Entra ID** end to end. When you're
done:

- users sign in to `/admin` and `/me` with their Microsoft account (no token paste),
- `claude mcp add <url>` connects with the **URL alone** — the gateway hosts its
  own OAuth authorization-server facade (RFC 8414 metadata + RFC 7591 dynamic
  client registration) and brokers the actual user sign-in to Entra,
- roles come from Entra group membership (or per-user assignment in the admin UI),
- direct Entra-issued bearer tokens (for service/daemon clients) are accepted too.

Any other OIDC provider works for the resource-server and login parts
(`OIDC_ISSUER` instead of `ENTRA_TENANT_ID`); the directory search and per-user
Connect features are Entra-only and degrade gracefully elsewhere.

## How the pieces fit

One **confidential** Entra app registration does triple duty:

| Function | What it uses |
| --- | --- |
| Resource server — validate Entra-issued access tokens on `/mcp` | Application ID URI → `OIDC_AUDIENCE` |
| Interactive login — browser cookie session for `/admin` and `/me` | client id + secret, auth-code + PKCE, `${PUBLIC_URL}/auth/callback` |
| Directory search — live user/group typeahead in the admin UI | Graph *application* permissions (optional) |

The OAuth facade for MCP clients needs **no extra Entra configuration** — MCP
clients register with the *gateway* (DCR), and the gateway reuses the login app
for the Entra leg. A second, *public* app registration is only needed for the
optional per-user upstream Connect flow (step 6).

## 1. Register the app

Entra admin center → **Identity → Applications → App registrations → New registration**:

1. Name: e.g. `MCP Gateway`.
2. Supported account types: *Accounts in this organizational directory only* (single tenant).
3. Skip the redirect URI for now → **Register**.
4. From the Overview page note:
   - **Application (client) ID** → `AUTH_CLIENT_ID`
   - **Directory (tenant) ID** → `ENTRA_TENANT_ID`

### 1a. Expose an API (audience)

**Expose an API → Add** next to *Application ID URI* — accept the default
`api://<client-id>`. This exact string is your `OIDC_AUDIENCE`: the gateway
rejects any access token whose `aud` doesn't match it (RFC 8707 audience
binding), so tokens minted for other resources (e.g. Graph) can never be
replayed against the gateway.

Then **Add a scope** so clients can request tokens *for* the gateway:

- Scope name: `gateway.access`
- Who can consent: *Admins and users*
- Display name/description: anything (e.g. "Access the MCP gateway")

Daemon/service clients in your tenant can then request
`scope=api://<client-id>/.default` (client credentials) or
`api://<client-id>/gateway.access` (delegated) and hit `/mcp` with the resulting
Entra bearer token directly.

### 1b. Redirect URI (interactive login)

**Authentication → Add a platform → Web**, redirect URI:

```
https://<your-gateway-host>/auth/callback
```

This must be `${PUBLIC_URL}/auth/callback` (the default `AUTH_REDIRECT_URI`).
For local testing add `http://localhost:3100/auth/callback` as well. Leave the
implicit-grant checkboxes off — the gateway uses authorization code + PKCE.

### 1c. Client secret

**Certificates & secrets → New client secret**. Copy the **Value** immediately
(shown once) → `AUTH_CLIENT_SECRET`. Put a rotation reminder on the expiry date.

### 1d. Groups claim (optional, for group → role mapping)

To map Entra groups to gateway roles, tokens must carry group ids:

**Token configuration → Add groups claim** → select *Security groups* (and
*Groups assigned to the application* if you prefer app-assigned groups) for both
**ID** and **Access** token types. The claim name stays `groups`, which matches
the gateway default (`OIDC_GROUPS_CLAIM=groups`).

> Users in 200+ groups get a "group overage" pointer instead of the list — if
> that's your tenant, prefer *Groups assigned to the application* or assign
> roles per-user in the admin UI.

### 1e. Graph permissions (optional, for the admin-UI directory typeahead)

The admin UI's group-mapping screen can search your directory live ("type a
group name, pick from the list"). That runs app-only Graph queries using this
same app's credentials and needs **Application** (not Delegated) permissions:

**API permissions → Add a permission → Microsoft Graph → Application permissions**:

- `User.ReadBasic.All`
- `Group.Read.All`

Then **Grant admin consent**. Skip this entirely if you don't mind pasting group
object ids by hand — the UI degrades to a paste-an-id field.

## 2. Configure the gateway

```bash
PUBLIC_URL=https://mcp.example.com        # the URL clients actually use

# resource server
ENTRA_TENANT_ID=<directory (tenant) id>
OIDC_AUDIENCE=api://<application (client) id>

# interactive login + AS facade (all three required together)
AUTH_CLIENT_ID=<application (client) id>
AUTH_CLIENT_SECRET=<client secret value>
SESSION_SECRET=$(openssl rand -hex 32)    # ≥16 chars; HMAC key for session cookies

# who becomes admin on first sign-in
ADMIN_BOOTSTRAP_SUBJECTS=alice@example.com
```

Notes:

- `ENTRA_TENANT_ID` is shorthand for
  `OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0`.
- `OIDC_AUDIENCE` is **mandatory** whenever an issuer is configured — the
  gateway refuses to start without it.
- `AUTH_REDIRECT_URI` defaults to `${PUBLIC_URL}/auth/callback`; set it only if
  yours differs (it must match step 1b exactly).
- `GATEWAY_JWT_SECRET` (HS256 key for gateway-issued access tokens) defaults to
  a key derived from `SESSION_SECRET`; set it explicitly if you want to rotate
  the two independently.
- `ADMIN_BOOTSTRAP_SUBJECTS` matches the signing-in user's email or subject.
  The gateway keys Entra users by the stable `oid` claim, so email is the
  practical choice here.
- `PUBLIC_URL` must be the externally visible URL — issuer, audience and
  redirect for the AS facade all derive from it.

Static `MCP_TOKENS_*` can stay configured alongside OAuth — handy as break-glass
admin access and for clients that can't do OAuth.

## 3. First sign-in and roles

1. Browse to `https://mcp.example.com/admin` → **Sign in with Microsoft**.
2. A user listed in `ADMIN_BOOTSTRAP_SUBJECTS` lands as **admin**; everyone else
   gets the default role until mapped.
3. Admin UI → **Users** tab: map Entra **groups → roles** (with live search if
   you granted the Graph permissions in 1e), or set roles per user.

Role resolution happens on **every request** — the session cookie and
gateway-issued tokens carry identity only, never privilege, so role changes and
revocations take effect immediately.

## 4. Connect MCP clients (zero-config DCR)

```bash
claude mcp add --transport http mspstack https://mcp.example.com/mcp
```

No client id, no secrets. What happens under the hood:

1. The client gets `401` + RFC 9728 protected-resource metadata pointing at the
   gateway's own authorization server.
2. The client self-registers via RFC 7591 DCR and starts an authorization-code +
   PKCE flow against the gateway.
3. The gateway brokers the user-authentication leg to Entra (the same
   confidential login app), then issues its own short-lived HS256 access token
   plus a rotating refresh token.

Registered clients appear on the admin **Users** tab and can be revoked there —
deleting a client kills its refresh tokens immediately.

Direct Entra bearers keep working in parallel: a daemon that acquires
`api://<client-id>/.default` from Entra can call `/mcp` without touching the
DCR facade.

## 5. Secret store

Auth and secret storage are independent — pair this OAuth setup with either
store (one at a time):

- **OpenBao** — `BAO_ADDR` + `BAO_TOKEN` (dev) or `BAO_ROLE_ID`/`BAO_SECRET_ID`
  (production AppRole); `bao:path#field` refs. Setup:
  [Standalone with secrets](standalone-secrets.md).
- **Azure Key Vault** — a natural fit if you're already in Entra:
  `KEY_VAULT_URI=https://<vault>.vault.azure.net`, auth via
  `DefaultAzureCredential` (managed identity in Azure, `az login` locally);
  `kv:secret-name` refs. No `GATEWAY_MODE` change needed — Key Vault in
  standalone is a first-class combination. Details:
  [Integrated mode](integrated-mode.md#azure-key-vault).

## 6. Optional: per-user upstream Connect (second app, public)

Upstreams with a `userConnect` block (e.g. the Planner preset) offer users a
one-click **Connect** on `/me`: the gateway runs a delegated auth-code + PKCE
flow and stores the resulting *refresh token* in the secret store as that user's
personal credential. This flow uses a **separate public** app registration
(PKCE is the proof — no secret):

1. **New registration** — e.g. `MCP Gateway – User Connect`, single tenant.
2. **Authentication → Add a platform → Mobile and desktop applications** (or
   Web without a secret), redirect URI:

   ```
   https://<your-gateway-host>/me/connect/callback
   ```

3. Still under **Authentication**: set **Allow public client flows** to **Yes**.
4. **API permissions → Delegated**: whatever the upstream needs (for Planner:
   `Tasks.ReadWrite`, `Group.Read.All`) plus `offline_access` (the gateway
   force-adds it to the request, but consent must cover it) → grant admin
   consent if your tenant requires it.
5. Put the app's client id and scopes into the upstream's `userConnect` config
   (the built-in presets prompt for exactly this).

If the token exchange returns no refresh token, the error points at the two
usual causes: public client flows disabled, or `offline_access` missing.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Gateway refuses to start: "OIDC_AUDIENCE is required" | An issuer is set without an audience — set `OIDC_AUDIENCE=api://<client-id>` (step 1a). |
| Gateway refuses to start: login vars | `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `SESSION_SECRET` are all-or-nothing, and `SESSION_SECRET` must be ≥16 chars. |
| `401 invalid audience` on `/mcp` with an Entra token | The token's `aud` isn't your `OIDC_AUDIENCE` — the client requested the wrong scope (e.g. a Graph token). Request `api://<client-id>/.default` or `…/gateway.access`. |
| Entra error `AADSTS50011` (redirect URI mismatch) | The redirect URI on the app doesn't exactly match `${PUBLIC_URL}/auth/callback` — check scheme/host/port and `PUBLIC_URL`. |
| Signed in but no admin | Your email/sub isn't in `ADMIN_BOOTSTRAP_SUBJECTS` (only applied on first login), and no group mapping grants admin. Fix the mapping or have an existing admin set your role. |
| Group mappings never match | Tokens don't carry the groups claim (step 1d), or the claim name differs from `OIDC_GROUPS_CLAIM`, or the user hit the 200-group overage. |
| Directory search shows a paste-an-id field | Graph application permissions missing/unconsented (step 1e), or the issuer isn't Entra. |
| Connect returns "no refresh token returned" | The public app has *Allow public client flows* off, or `offline_access` isn't consented (step 6). |
