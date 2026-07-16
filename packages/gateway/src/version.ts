/**
 * Server identity, read from the package manifest so releases can't drift
 * from what /health, /api/status, and MCP serverInfo report. Resolved
 * relative to this module, the path is the same depth from src/ (dev via
 * tsx) and dist/ (build + container, where the Dockerfile copies
 * package.json next to dist/).
 */

import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as {
  name: string;
  version: string;
};

export const SERVER_NAME = pkg.name.replace(/^@[^/]+\//, "");
export const SERVER_VERSION: string = pkg.version;
