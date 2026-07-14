#!/usr/bin/env node
/**
 * MSPStack Gateway — CLI entry.
 *
 *   mspstack-gateway [--port 3100] [--config mspstack.config.json] [--db data/gateway.db]
 *
 * All log output goes to stderr (family convention). Refuses to start with
 * no authentication configured unless DEV_ALLOW_UNAUTHENTICATED=true.
 */

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { PolicyService } from "./domain/policy.js";
import { createOidcVerifier } from "./auth/oidc.js";
import { OpenBaoStore } from "./secrets/openbao.js";
import { createKeyVaultStore } from "./secrets/keyvault.js";
import { UpstreamConnection } from "./upstream/connection.js";
import { UpstreamManager } from "./upstream/manager.js";
import { createApp } from "./http/app.js";
import { SERVER_NAME, SERVER_VERSION } from "./mcp/gateway-server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  console.error(`[gateway] ${SERVER_NAME} v${SERVER_VERSION}`);

  // ── auth mode ──
  if (
    config.staticTokens.length === 0 &&
    !config.oidc &&
    !config.devAllowUnauthenticated
  ) {
    throw new ConfigError(
      "No authentication configured. Set MCP_TOKENS_<ROLE> and/or OIDC_ISSUER (+OIDC_AUDIENCE), " +
        "or DEV_ALLOW_UNAUTHENTICATED=true for local development."
    );
  }
  if (config.devAllowUnauthenticated) {
    console.error(
      "[gateway] WARNING: DEV_ALLOW_UNAUTHENTICATED=true — anonymous requests get the admin role. Never expose this beyond localhost."
    );
  }
  if (config.staticTokens.length > 0) {
    console.error(
      `[auth] static tokens: ${config.staticTokens.map((t) => `${t.label}(${t.roleName})`).join(", ")}`
    );
  }
  if (config.oidc) {
    console.error(`[auth] OIDC resource server: issuer=${config.oidc.issuer}`);
  }

  // ── persistence + policy ──
  const db = openDatabase(config.dbPath);
  const repo = new Repo(db);
  const policy = new PolicyService(repo);

  // Config file upstreams are upserted at boot (file wins for the ids it names).
  for (const spec of config.upstreamsFromFile) {
    repo.upsertUpstream(spec, "file");
  }

  // ── secrets ──
  const secretStore = config.bao
    ? new OpenBaoStore(config.bao)
    : config.keyVault
      ? await createKeyVaultStore(config.keyVault.vaultUrl)
      : null;
  if (secretStore) {
    const label = secretStore.scheme === "kv" ? "Key Vault" : "OpenBao";
    const health = await secretStore.health();
    console.error(
      health.ok
        ? `[secrets] ${label} ${health.detail}`
        : `[secrets] WARNING: ${label} unhealthy (${health.detail}) — ${secretStore.scheme}: refs will fail until it recovers`
    );
  }

  // ── OIDC verifier ──
  const oidcVerifier = config.oidc ? createOidcVerifier(config.oidc) : null;

  // ── upstreams ──
  const specs = repo.listUpstreams().map((row) => row.spec);
  const manager = new UpstreamManager(specs, (spec) => new UpstreamConnection(spec, secretStore));
  await manager.start();

  // ── HTTP ──
  const adminUiDir = fileURLToPath(new URL("../public", import.meta.url));
  const app = createApp({
    config,
    repo,
    manager,
    policy,
    secretStore,
    oidcVerifier,
    adminUiDir: existsSync(adminUiDir) ? adminUiDir : null,
  });
  const httpServer = app.listen(config.port, () => {
    console.error(`[gateway] MCP endpoint  http://localhost:${config.port}/mcp`);
    console.error(`[gateway] admin UI      http://localhost:${config.port}/admin`);
  });

  const shutdown = (signal: string): void => {
    console.error(`[gateway] ${signal} received — shutting down`);
    httpServer.close();
    manager
      .stop()
      .catch((err) => console.error(`[gateway] shutdown error: ${String(err)}`))
      .finally(() => {
        db.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[gateway] Configuration error: ${err.message}`);
  } else {
    console.error(`[gateway] Fatal: ${String(err)}`);
  }
  process.exit(1);
});
