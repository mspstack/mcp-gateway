/**
 * The MCP server gateway clients talk to. Uses the SDK's low-level Server
 * (not McpServer) because the tool list is dynamic: it changes with admin
 * toggles, upstream availability, and the caller's role.
 *
 * Two-layer enforcement: tools/list filtering is UX; the call-time policy
 * re-check is the security boundary. Both use the same PolicyService.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { prefsIdentity, type Principal } from "../auth/principal.js";
import type { UpstreamSpec } from "../config.js";
import type { PolicyService } from "../domain/policy.js";
import type { UpstreamManager } from "../upstream/manager.js";
import { callSelfTool, SELF_TOOLS, type SelfToolDeps } from "./self-tools.js";

import { SERVER_NAME, SERVER_VERSION } from "../version.js";

export { SERVER_NAME, SERVER_VERSION };

/** Field→secretRef map of the principal's registered creds for an upstream. */
export type PersonalCredsLookup = (upstreamId: string) => Record<string, string>;

/**
 * The spec's identityHeaders resolved for one principal. Values are literals
 * (not secret refs) and pass through connect-time injection untouched. "email"
 * falls back to the subject so the value is never absent — a per-user call
 * must never silently degrade to an identity-less one, or a downstream actor
 * gate would fall back to trusting the shared service account. Pure —
 * exported for tests.
 */
export function identityHeaderValues(
  spec: UpstreamSpec | undefined,
  principal: Principal,
  email: string | null
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, source] of Object.entries(spec?.identityHeaders ?? {})) {
    const value =
      source === "email"
        ? (email ?? principal.subject)
        : source === "subject"
          ? principal.subject
          : principal.label;
    if (value) out[field] = value;
  }
  return out;
}

export function createGatewayServer(
  manager: UpstreamManager,
  policy: PolicyService,
  principal: Principal,
  personalCredsFor?: PersonalCredsLookup,
  /** Admin-only self-management tools; omit to serve federated tools only. */
  selfTools?: SelfToolDeps,
  /** Public /me URL, so a self-inflicted denial can point at the switch. */
  meUrl?: string,
  /** The principal's email on file (users table), for identityHeaders. */
  principalEmail: string | null = null
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } }
  );

  // Envelope ∧ personal prefs — the same allowsFor gates list AND call, so
  // a user's own narrowing is enforced at the boundary, not just hidden in UX.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      // Self-management is offered to admins only; for everyone else these
      // names simply don't exist (the call handler re-checks anyway).
      ...(selfTools && principal.isAdmin ? SELF_TOOLS : []),
      ...policy
        .visibleEntriesFor(principal, manager.catalogEntries())
        .map((entry) => ({ ...entry.tool, name: entry.exposedName })),
    ];
    // Logged because "did the client ever re-read the list?" was otherwise
    // unanswerable, and that question cost a whole afternoon once.
    console.error(`[mcp] ${principal.label} tools/list -> ${tools.length} tool(s)`);
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // The `gw` namespace is reserved (config.ts refuses it for upstreams), so
    // this can never shadow a federated tool or be shadowed by one.
    if (selfTools) {
      const handled = await callSelfTool(
        selfTools,
        principal,
        request.params.name,
        request.params.arguments ?? {}
      );
      if (handled) return handled;
    }
    const entry = manager.entryFor(request.params.name);
    if (!entry || !policy.allowsFor(principal, entry)) {
      // A tool the caller closed themselves is already listed on their own /me
      // page, so saying so leaks nothing — and saves them asking an admin about
      // their own switch. Every other case keeps the no-oracle wording: unknown,
      // globally disabled and role-denied tools stay indistinguishable.
      const reason = entry ? policy.denialReason(principal, entry) : "envelope";
      // Names and decisions only — never arguments, which carry customer data.
      console.error(
        `[mcp] ${principal.label} tools/call ${request.params.name} -> denied (${entry ? reason : "unknown"})`
      );
      const where = meUrl ? ` (${meUrl})` : "";
      const text =
        reason === "personal"
          ? `Tool "${request.params.name}" is switched off in your personal settings — turn it back on from your MCP access page${where}, then reconnect this client.`
          : reason === "optIn"
            ? `Tool "${request.params.name}" is available to you but not enabled yet — this server is off by default, so enable what you need on your MCP access page${where}, then reconnect this client.`
            : `Tool "${request.params.name}" is not available to this session — it may not exist, be disabled, or require a higher role than "${principal.roleName}".`;
      return { isError: true, content: [{ type: "text" as const, text }] };
    }
    // Network ACL (orthogonal to the role/personal layers): per-REQUEST source
    // address, carried in by the HTTP layer via authInfo — a session id must
    // not pin an address any more than it carries privilege. The caller can
    // already see this tool (allowsFor passed), so naming the restriction
    // reveals nothing and saves a support round-trip.
    const callerIp = ((extra?.authInfo?.extra as Record<string, unknown> | undefined)?.ip as string | undefined) ?? null;
    const blockingAcl = policy.networkDenial(entry, callerIp);
    if (blockingAcl !== null) {
      console.error(
        `[acl] ${principal.label} tools/call ${request.params.name} -> denied from ${callerIp ?? "unknown"} (ACL "${blockingAcl}")`
      );
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Tool "${request.params.name}" cannot be called from your current network — calls of its class are restricted by the gateway's "${blockingAcl}" ACL. Retry from an allowed network, or ask a gateway admin.`,
          },
        ],
      };
    }
    const args = request.params.arguments ?? {};
    console.error(`[mcp] ${principal.label} tools/call ${request.params.name} -> allowed`);

    // sessionMode:"per-user" — route the call over the caller's own
    // connection, with their registered credential refs layered onto the
    // spec (resolved server-side; the inbound token is never forwarded).
    const spec = manager.specFor(entry.upstreamId);
    if (spec?.sessionMode === "per-user") {
      const credentialRefs = personalCredsFor?.(entry.upstreamId) ?? {};
      if (Object.keys(credentialRefs).length === 0 && spec.requirePersonalCredentials) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Upstream "${entry.upstreamId}" requires personal credentials — register yours via the gateway's self-service (PUT /api/me/credentials/${entry.upstreamId}) and retry.`,
            },
          ],
        };
      }
      // Identity values are computed from the AUTHENTICATED principal and
      // layered last, so a user-registered field of the same name can never
      // override who the gateway says the caller is (/me also refuses to
      // store one). They alone are enough to route the call over a personal
      // link — that is the whole point for service-account upstreams.
      const overlay = {
        ...credentialRefs,
        ...identityHeaderValues(spec, principal, principalEmail),
      };
      if (Object.keys(overlay).length > 0) {
        return manager.callTool(entry, args, {
          sessionKey: prefsIdentity(principal),
          credentialRefs: overlay,
        });
      }
      // No personal creds and fallback allowed → shared connection.
    }

    return manager.callTool(entry, args);
  });

  return server;
}
