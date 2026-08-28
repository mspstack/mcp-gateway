# Network ACLs

Named IP/CIDR allowlists, bound to a scope and enforced on every request. Two
kinds of scope exist:

| Scope | What it gates |
| --- | --- |
| `tier:read`, `tier:write`, `tier:destructive` | `tools/call` for tools of that **effective** tier |
| `surface:browser` | `/admin`, `/me`, `/api`, `/auth/login`, `/auth/callback`, `/oauth/authorize` |

With no bindings there is no network layer at all — the gateway behaves exactly
as it did before the feature existed. Manage both the lists and the bindings on
the admin UI's **Roles** tab, or via `/api/acls` and `/api/acl-bindings`.

## The part that surprises people

**An IP ACL can only see the address a request actually arrives from, and that
depends on how the client connects — not on where the person is sitting.**

MCP clients fall into two groups, and the difference decides whether a
tool-class binding does what you want or breaks everything.

### Direct connections — tool-class ACLs work

Claude Code with a locally configured server, a script, anything running on a
workstation:

```bash
claude mcp add --transport http mspstack https://gateway.example/mcp
```

The process runs on the user's machine and opens its own connection to the
gateway, so every request — the OAuth dance and each later `tools/call` — comes
from that machine's address. Such a client registers with a **loopback**
redirect URI (`http://localhost:<port>/…`), because the browser has to hand the
authorization code back to a program on the same machine. That loopback
redirect is the reliable signal that a client is direct.

For these clients an ACL means what you'd expect: "destructive tools only from
the jump host" is enforceable, and a call from anywhere else fails.

### OAuth cloud connectors — tool-class ACLs break them

claude.ai (web and mobile), ChatGPT, ClickUp and other hosted integrations:
the connector runs on the **vendor's** servers. The user's browser participates
only in the sign-in redirect; afterwards the vendor's backend holds the tokens
and makes every call itself.

So the address the gateway sees on `tools/call` is a vendor data-centre
address. It is not your office, it is not stable, and it is not something the
vendor publishes as an allowlistable range. These clients register with a
**hosted** redirect URI, e.g. `https://claude.ai/api/mcp/auth_callback`.

Binding a tool class while such clients are in use blocks **all** their calls of
that tier, for **every** user, no matter where they are — including someone
sitting in the office on the corporate network. There is no allowlist entry
that fixes it, because the traffic genuinely does not originate from your
network.

The admin UI checks the registered OAuth clients and warns, by name, which ones
a tool-class binding would break; binding a tier while any exist requires
confirming a dialog that spells this out.

### Why the browser surface is different

`surface:browser` is unaffected by any of this. Those endpoints are only ever
driven by a real browser on a real person's machine, so pinning them to
corporate networks works no matter which kind of client the person uses for
MCP. That makes it the useful binding on a gateway serving cloud connectors:
interactive sign-in — and therefore issuing *new* tokens to anyone — becomes
possible only from your networks, and a stolen admin cookie is useless outside
them. What it costs is working from an unmanaged network without VPN.

The machine endpoints — `/mcp` itself, `/oauth/token`, `/oauth/register`, the
discovery documents — are **never** restricted by any binding. They carry their
own authentication, and every client needs them reachable to function at all.

### If you want "destructive only from the secure workstation"

Two honest options:

1. **Move users to direct connections.** Configure Claude Code locally on the
   machines that should have the privilege, then bind `tier:destructive`. The
   trade-off is losing claude.ai and mobile access to the gateway.
2. **Express the limit by role, not by network.** Give the destructive ceiling
   to a role held by named people (roles, grants, and tool sets already do
   this). With cloud connectors this is the more truthful control: you are
   really saying "these people may do this", and the network was only ever a
   proxy for that.

## How the address is determined

Behind a reverse proxy (Azure App Service, nginx) the socket address is the
proxy's, so the client address has to come from `X-Forwarded-For`. That header
is trusted **only** when `TRUST_PROXY=true`, and then only its **last** entry —
the one the fronting proxy appended. Everything earlier in the list arrived
over the wire and is attacker-supplied, so a client cannot spoof its way into
an ACL by sending its own header. Ports (App Service appends `ip:port`) are
stripped.

Set `TRUST_PROXY=true` **before** binding anything if the gateway runs behind a
proxy. Without it every request looks like it comes from the load balancer, and
since a request with no usable address is denied when a binding exists (fail
closed), you would lock out everyone at once.

Matching is family-strict: an IPv4 address is never inside an IPv6 subnet.
(Node's `BlockList` treats IPv4-mapped addresses as inside `::/0`, which for an
allowlist would silently admit every IPv4 client.) A prefix must be present and
in range — `1.2.3.4/` is rejected rather than read as `/0`.

## Break-glass

Deleting an ACL cascades its bindings, so the scopes it guarded become
unrestricted immediately — that is the fastest fix if you still have access.

If a binding has locked you out of the admin UI itself, set the app setting
`ACL_ENFORCEMENT=off` and restart. The gateway logs a warning at boot while it
is off, and every ACL check short-circuits to "allow". Fix the list, then turn
enforcement back on.

Prefer making binding changes from inside an allowed network, so a mistake
leaves you a way back in.
