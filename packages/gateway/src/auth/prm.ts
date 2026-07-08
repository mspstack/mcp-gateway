/**
 * RFC 9728 Protected Resource Metadata + WWW-Authenticate discovery, per the
 * MCP authorization spec: clients hitting 401 read the WWW-Authenticate
 * header, fetch the PRM document, and run the OAuth flow against the listed
 * authorization server.
 */

import type { OidcConfig } from "../config.js";

export const PRM_PATH = "/.well-known/oauth-protected-resource";

export interface PrmDocument {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
}

export function prmDocument(publicUrl: string, oidc: OidcConfig): PrmDocument {
  return {
    resource: `${publicUrl}/mcp`,
    authorization_servers: [oidc.issuer],
    bearer_methods_supported: ["header"],
  };
}

/** Value for the WWW-Authenticate header on 401 responses. */
export function wwwAuthenticate(publicUrl: string): string {
  return `Bearer resource_metadata="${publicUrl}${PRM_PATH}"`;
}
