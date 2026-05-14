import type { App, PluginManifest } from "obsidian";
import { WatcherChain } from "../chain/chain";
import { RankigiWatcherSettings } from "../settings";

interface ObsidianPluginsApi {
  manifests: Record<string, PluginManifest>;
  enabledPlugins?: Set<string>;
}

interface AppWithPlugins extends App {
  plugins: ObsidianPluginsApi;
}

export type LifecycleListener = () => void;

export class LifecycleMonitor {
  private lastSnapshot: Map<string, string> = new Map();
  private intervalId: number | null = null;
  private layoutReadyCallback: (() => void) | null = null;
  private listeners: Set<LifecycleListener> = new Set();
  private running = false;

  constructor(
    private app: App,
    private chain: WatcherChain,
    private settings: RankigiWatcherSettings,
    private pollIntervalMs: number = 10000
  ) {}

  onChange(listener: LifecycleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    if (!this.settings.monitorLifecycle) return;
    this.running = true;
    this.lastSnapshot = this.currentSnapshot();
    this.layoutReadyCallback = () => {
      void this.checkForChanges();
    };
    this.app.workspace.onLayoutReady(this.layoutReadyCallback);
    this.intervalId = window.setInterval(() => {
      void this.checkForChanges();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.layoutReadyCallback = null;
  }

  private currentSnapshot(): Map<string, string> {
    const map = new Map<string, string>();
    const plugins = (this.app as AppWithPlugins).plugins;
    if (!plugins || !plugins.manifests) return map;
    for (const id of Object.keys(plugins.manifests)) {
      const m = plugins.manifests[id];
      map.set(id, m?.version ?? "unknown");
    }
    return map;
  }

  private async checkForChanges(): Promise<void> {
    const current = this.currentSnapshot();
    const previous = this.lastSnapshot;
    let changed = false;

    for (const [id, version] of current) {
      if (!previous.has(id)) {
        await this.chain.append({
          category: "LIFECYCLE",
          plugin_id: id,
          summary: "installed v" + version,
          payload: { event: "install", plugin_id: id, version },
          severity: "info",
        });
        changed = true;
      } else {
        const oldVersion = previous.get(id) as string;
        if (oldVersion !== version) {
          await this.chain.append({
            category: "LIFECYCLE",
            plugin_id: id,
            summary: "updated " + oldVersion + " to " + version,
            payload: {
              event: "update",
              plugin_id: id,
              old_version: oldVersion,
              new_version: version,
            },
            severity: "info",
          });
          changed = true;
        }
      }
    }

    for (const [id] of previous) {
      if (!current.has(id)) {
        await this.chain.append({
          category: "LIFECYCLE",
          plugin_id: id,
          summary: "removed",
          payload: { event: "remove", plugin_id: id },
          severity: "warn",
        });
        changed = true;
      }
    }

    this.lastSnapshot = current;

    if (changed) {
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          // listeners must not break the monitor
        }
      }
    }
  }
}
