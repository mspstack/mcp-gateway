/**
 * UpstreamManager: owns all upstream connections and the merged tool catalog.
 *
 * Upstreams can be added/removed/toggled at runtime (admin API) — the manager
 * hot-connects new ones and rebuilds the catalog. An upstream that fails to
 * connect is logged and skipped (the gateway still serves the healthy ones);
 * its supervised connection keeps retrying with backoff. Upstream
 * `tools/list_changed` notifications and reconnect recoveries trigger a
 * rediscovery; when the merged catalog actually changes, `onCatalogChanged`
 * fires so the HTTP layer can notify connected clients.
 *
 * The manager is policy-free: role filtering happens in the MCP layer via
 * PolicyService, keyed by the entries this manager exposes.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamSpec } from "../config.js";
import {
  buildCatalog,
  type CatalogEntry,
  type UpstreamTools,
} from "../domain/catalog.js";
import { UpstreamConnection, type UpstreamStatus } from "./connection.js";

/** Minimal connection surface the manager needs — lets tests inject fakes. */
export interface UpstreamLink {
  readonly spec: UpstreamSpec;
  onToolListChanged: (() => void) | null;
  onRecovered?: (() => void) | null;
  connect(): Promise<void>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
  getStatus?(): UpstreamStatus;
}

export interface UpstreamSummary {
  id: string;
  namespace: string;
  transport: "http" | "stdio";
  enabled: boolean;
  connected: boolean;
  lastError: string | null;
  toolCount: number;
}

const failure = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

export class UpstreamManager {
  private readonly links = new Map<string, UpstreamLink>();
  private readonly specs = new Map<string, UpstreamSpec>();
  private catalog = new Map<string, CatalogEntry>();
  private refreshing: Promise<void> | null = null;
  /** Fires after the merged catalog changed (upstream update or admin action). */
  onCatalogChanged: (() => void) | null = null;

  constructor(
    specs: UpstreamSpec[],
    private readonly linkFactory: (spec: UpstreamSpec) => UpstreamLink = (spec) =>
      new UpstreamConnection(spec)
  ) {
    for (const spec of specs) this.register(spec);
  }

  private register(spec: UpstreamSpec): void {
    this.specs.set(spec.id, spec);
    if (!spec.enabled) {
      console.error(`[gateway] upstream "${spec.id}" is disabled — not connecting`);
      return;
    }
    const link = this.linkFactory(spec);
    link.onToolListChanged = () => {
      console.error(`[upstream:${spec.id}] tool list changed — rediscovering`);
      void this.refreshCatalog();
    };
    if ("onRecovered" in link) {
      link.onRecovered = () => {
        console.error(`[upstream:${spec.id}] recovered — rediscovering`);
        void this.refreshCatalog();
      };
    }
    this.links.set(spec.id, link);
  }

  async start(): Promise<void> {
    await this.refreshCatalog();
    console.error(
      `[gateway] serving ${this.catalog.size} tool(s) from ${this.links.size} upstream(s)`
    );
  }

  /** Add or replace an upstream at runtime, then rebuild the catalog. */
  async upsertUpstream(spec: UpstreamSpec): Promise<void> {
    await this.removeUpstream(spec.id, { keepSpec: false, silent: true });
    this.register(spec);
    await this.refreshCatalog();
  }

  async removeUpstream(
    id: string,
    opts: { keepSpec?: boolean; silent?: boolean } = {}
  ): Promise<void> {
    const link = this.links.get(id);
    if (link) {
      this.links.delete(id);
      await link.close().catch(() => undefined);
    }
    if (!opts.keepSpec) this.specs.delete(id);
    if (!opts.silent) await this.refreshCatalog();
  }

  /** Reconnect-if-needed + rediscover every upstream, then rebuild the catalog. */
  async refreshCatalog(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const discovered: UpstreamTools[] = [];
    for (const link of this.links.values()) {
      try {
        await link.connect();
        discovered.push({
          upstreamId: link.spec.id,
          namespace: link.spec.namespace,
          tools: await link.listTools(),
        });
      } catch (err) {
        console.error(
          `[upstream:${link.spec.id}] unavailable: ${String(err)} — its tools are omitted until it recovers`
        );
      }
    }

    const { entries, collisions } = buildCatalog(discovered);
    for (const collision of collisions) console.error(`[gateway] tool collision: ${collision}`);

    const before = this.fingerprint();
    this.catalog = entries;
    if (this.fingerprint() !== before) this.onCatalogChanged?.();
  }

  private fingerprint(): string {
    return [...this.catalog.keys()].sort().join("\n");
  }

  catalogEntries(): IterableIterator<CatalogEntry> {
    return this.catalog.values();
  }

  entryFor(exposedName: string): CatalogEntry | undefined {
    return this.catalog.get(exposedName);
  }

  summaries(): UpstreamSummary[] {
    return [...this.specs.values()].map((spec) => {
      const link = this.links.get(spec.id);
      const status = link?.getStatus?.() ?? {
        connected: false,
        lastError: null,
        reconnectAttempts: 0,
      };
      let toolCount = 0;
      for (const entry of this.catalog.values()) {
        if (entry.upstreamId === spec.id) toolCount += 1;
      }
      return {
        id: spec.id,
        namespace: spec.namespace,
        transport: spec.transport,
        enabled: spec.enabled,
        connected: link ? status.connected : false,
        lastError: status.lastError,
        toolCount,
      };
    });
  }

  async callTool(entry: CatalogEntry, args: Record<string, unknown>): Promise<CallToolResult> {
    const link = this.links.get(entry.upstreamId);
    if (!link) {
      return failure(`Upstream "${entry.upstreamId}" is not available.`);
    }
    try {
      return await link.callTool(entry.upstreamToolName, args);
    } catch (err) {
      // Family convention: errors become isError text, never thrown to the SDK.
      return failure(`Upstream "${entry.upstreamId}" call failed: ${String(err)}`);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.links.values()].map((link) => link.close()));
  }
}
