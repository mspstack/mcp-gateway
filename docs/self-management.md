# Administering the gateway over MCP

The gateway exposes its own administration as an **admin-only** MCP toolset
(`gw_*`), so routine changes are a sentence in Claude Code instead of a browser
trip:

> "which CIPP groups are enabled?" · "turn off everything destructive in cwpsa"
> · "raise ExecGetRecoveryKey to destructive" · "close cipp for techs-ro"

## Access model

- Tools are listed **only** for principals whose role has `is_admin` — for
  everyone else the names simply do not appear.
- Hiding is UX; every call re-checks `isAdmin` and a non-admin gets the same
  "not available" text an unknown tool gets, so the toolset is not an oracle
  for what exists.
- The `gw` namespace is reserved: `parseUpstreamSpec` refuses it, so a
  federated server can never shadow these tools or be shadowed by them.
- Turn the whole thing off with `GATEWAY_SELF_TOOLS=off`.

## What it will not do

- **No secret reads.** `gw_list_servers` redacts header/env values: you see the
  keys and whether each value is a `kv:`/`bao:` reference, a `${VAR}` env
  reference, or a literal — never the literal itself.
- **No credential writes and no impersonation.** Personal credentials, secret
  writes, and user/role administration stay on the HTTP surface where the
  browser session gates them.
- **No silent destruction.** `gw_remove_server` requires `confirm: true`.

## The tools

| Tool | What it does |
| --- | --- |
| `gw_status` | version/mode, upstreams with tool counts and last errors, catalog size, secret-store scheme, auth mode, backup settings |
| `gw_list_servers` | configured upstreams and their mode flags, credential values redacted |
| `gw_list_tools` | catalog rows with effective tier, group and enabled state; filter by upstream/tier/group/enabled/name, or `groupsOnly` for a per-category summary |
| `gw_set_tools_enabled` | enable/disable for everyone — scope by tier and/or group, one tool, or the whole upstream |
| `gw_set_tool_tier` | set or clear a tier override (how a read-only tool that hands out secrets is kept away from low roles) |
| `gw_set_grant` | a role's ceiling on one upstream, by role name |
| `gw_list_presets` / `gw_install_preset` | the preset catalog and one-shot installs (`dryRun` renders without saving) |
| `gw_set_server_enabled` | enable/disable a whole upstream |
| `gw_remove_server` | remove an upstream and its settings/grants/overrides (`confirm: true`) |
| `gw_refresh_catalog` | re-read every upstream's tool list now |
| `gw_backup_now` | snapshot the database, prune to retention, ship off-instance when configured |

Changes broadcast `tools/list_changed` to live sessions, exactly like the same
change made from `/admin`.

## Secrets in preset installs

`gw_install_preset` takes parameters as strings, and a secret parameter must be
a **reference** — `kv:cipp-mcp-secret`, `bao:upstreams/itglue#token`, or
`${SOME_ENV}`. Pasting a raw secret would store it literally in the upstream
spec; write it with `PUT /api/secrets` (or the Secrets tab) first and pass the
ref you get back.
