import type { App } from "obsidian";
import { WatcherChain } from "../chain/chain";
import { RankigiWatcherSettings } from "../settings";
import { resolvePluginFromStack } from "../attribution";

type Op = "write" | "append" | "writeBinary" | "remove" | "rename" | "mkdir";

interface AdapterLike {
  write?: (path: string, data: string, options?: unknown) => Promise<void>;
  append?: (path: string, data: string, options?: unknown) => Promise<void>;
  appendFile?: (
    path: string,
    data: string,
    options?: unknown
  ) => Promise<void>;
  writeBinary?: (
    path: string,
    data: ArrayBuffer,
    options?: unknown
  ) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
}

type AdapterMethodKey =
  | "write"
  | "append"
  | "appendFile"
  | "writeBinary"
  | "remove"
  | "rename"
  | "mkdir";

interface DebounceEntry {
  firstTs: string;
  lastTs: string;
  count: number;
  plugin_id: string | null;
  attribution_method: "adapter_stack" | "none";
  size_bytes: number | null;
  operation: Op;
  path: string;
  timer: ReturnType<typeof setTimeout>;
}

function isoUtcMs(): string {
  return new Date().toISOString();
}

function sizeOf(data: unknown): number | null {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) {
    return (data as ArrayBufferView).byteLength;
  }
  return null;
}

const DEBOUNCED_OPS = new Set<Op>(["write", "append", "writeBinary"]);

export class VaultWritesMonitor {
  private adapter: AdapterLike | null = null;
  private originals: Partial<Record<AdapterMethodKey, unknown>> = {};
  private wrappers: Partial<Record<AdapterMethodKey, unknown>> = {};
  private inWatcherAppend = false;
  private debounceMap = new Map<string, DebounceEntry>();
  private running = false;
  private pendingChain: Promise<unknown> = Promise.resolve();

  constructor(
    private app: App,
    private chain: WatcherChain,
    private settings: RankigiWatcherSettings,
    private debounceMs: number = 5000
  ) {}

  start(): void {
    if (this.running) return;
    if (!this.settings.monitorVaultWrites) return;
    this.running = true;

    this.adapter = this.app.vault.adapter as unknown as AdapterLike;
    this.patchMethod("write", "write");
    if (typeof this.adapter.append === "function") {
      this.patchMethod("append", "append");
    }
    if (typeof this.adapter.appendFile === "function") {
      this.patchMethod("appendFile", "append");
    }
    this.patchMethod("writeBinary", "writeBinary");
    this.patchMethod("remove", "remove");
    this.patchMethod("rename", "rename");
    this.patchMethod("mkdir", "mkdir");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.adapter) {
      for (const key of Object.keys(
        this.originals
      ) as AdapterMethodKey[]) {
        const original = this.originals[key];
        const wrapper = this.wrappers[key];
        const adapterAny = this.adapter as unknown as Record<string, unknown>;
        if (
          original !== undefined &&
          wrapper !== undefined &&
          adapterAny[key] === wrapper
        ) {
          adapterAny[key] = original;
        }
      }
    }
    this.originals = {};
    this.wrappers = {};
    this.adapter = null;

    for (const entry of this.debounceMap.values()) {
      clearTimeout(entry.timer);
    }
    this.debounceMap.clear();
  }

  pendingFlushed(): Promise<void> {
    return this.pendingChain.then(() => undefined);
  }

  flushDebounceNow(): void {
    for (const [key, entry] of [...this.debounceMap.entries()]) {
      clearTimeout(entry.timer);
      this.emitDebounced(key, entry);
    }
  }

  private patchMethod(key: AdapterMethodKey, op: Op): void {
    const adapterAny = this.adapter as unknown as Record<string, unknown>;
    const original = adapterAny[key];
    if (typeof original !== "function") return;

    this.originals[key] = original;
    const self = this;
    const wrapper = function (
      this: unknown,
      ...args: unknown[]
    ): unknown {
      let stack = "";
      try {
        stack = new Error().stack ?? "";
      } catch {
        stack = "";
      }
      try {
        self.observe(op, args, stack);
      } catch {
        // wrappers must never throw
      }
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    this.wrappers[key] = wrapper;
    adapterAny[key] = wrapper;
  }

  private observe(op: Op, args: unknown[], stack: string): void {
    const path = typeof args[0] === "string" ? args[0] : "";
    if (!path) return;

    if (this.shouldSkip(path)) return;
    if (this.inWatcherAppend) return;

    const data = args[1];
    const size = sizeOf(data);

    const plugin_id = resolvePluginFromStack(stack, this.app);
    const attribution_method: "adapter_stack" | "none" =
      plugin_id ? "adapter_stack" : "none";

    if (DEBOUNCED_OPS.has(op)) {
      this.debounce(plugin_id, attribution_method, path, op, size);
    } else {
      this.queueAppend({
        category: "WRITE",
        plugin_id,
        summary: op + " " + path,
        payload: {
          event: "vault_write",
          path,
          operation: op,
          plugin_id,
          attribution_method,
          size_bytes: size,
        },
        severity: op === "remove" || op === "rename" ? "warn" : "info",
      });
    }
  }

  private shouldSkip(path: string): boolean {
    if (path.startsWith(".obsidian/")) return true;
    if (path.startsWith(".obsidian\\")) return true;
    if (path.includes("chain.jsonl")) return true;
    if (path.includes("chain-export-")) return true;
    return false;
  }

  private debounce(
    plugin_id: string | null,
    attribution_method: "adapter_stack" | "none",
    path: string,
    operation: Op,
    size_bytes: number | null
  ): void {
    const key = (plugin_id ?? "<null>") + "|" + path + "|" + operation;
    const existing = this.debounceMap.get(key);
    const now = isoUtcMs();

    if (existing) {
      clearTimeout(existing.timer);
      existing.lastTs = now;
      existing.count += 1;
      if (size_bytes !== null) existing.size_bytes = size_bytes;
      existing.timer = setTimeout(() => {
        this.emitDebounced(key, existing);
      }, this.debounceMs);
      return;
    }

    const entry: DebounceEntry = {
      firstTs: now,
      lastTs: now,
      count: 1,
      plugin_id,
      attribution_method,
      size_bytes,
      operation,
      path,
      timer: setTimeout(() => {
        const e = this.debounceMap.get(key);
        if (e) this.emitDebounced(key, e);
      }, this.debounceMs),
    };
    this.debounceMap.set(key, entry);
  }

  private emitDebounced(key: string, entry: DebounceEntry): void {
    this.debounceMap.delete(key);
    this.queueAppend({
      category: "WRITE",
      plugin_id: entry.plugin_id,
      summary: entry.operation + " " + entry.path,
      payload: {
        event: "vault_write",
        path: entry.path,
        operation: entry.operation,
        plugin_id: entry.plugin_id,
        attribution_method: entry.attribution_method,
        size_bytes: entry.size_bytes,
        first_ts: entry.firstTs,
        last_ts: entry.lastTs,
        coalesced_count: entry.count,
      },
      severity: "info",
    });
  }

  private queueAppend(params: {
    category: "WRITE";
    plugin_id: string | null;
    summary: string;
    payload: Record<string, unknown>;
    severity: "info" | "warn" | "critical";
  }): void {
    // chain.append uses Node fs to write to chain.jsonl, which never reaches
    // adapter.write, so toggling inWatcherAppend across the await is not
    // required for re-entrance safety. shouldSkip() filters chain.jsonl paths
    // already. The inWatcherAppend field remains available for future hooks
    // that synchronously invoke adapter methods from inside chain.append.
    const p = this.chain.append(params).catch(() => undefined);
    this.pendingChain = this.pendingChain.then(() => p);
  }
}
