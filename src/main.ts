import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { promises as fs } from "fs";
import * as path from "path";
import {
  RankigiWatcherSettings,
  DEFAULT_SETTINGS,
  RankigiSettingTab,
} from "./settings";
import { WatcherChain } from "./chain/chain";
import { LifecycleMonitor } from "./monitors/lifecycle";
import { WatcherStatusBar } from "./ui/statusBar";
import { WatcherSidebarView, VIEW_TYPE_WATCHER } from "./ui/sidebarView";
import { generateAgentId, generateInstallId } from "./util/id";
import { isoUtcMs } from "./util/time";

const STATUS_BAR_REFRESH_MS = 30_000;

interface PluginManifestLite {
  dir?: string;
}

export default class RankigiWatcherPlugin extends Plugin {
  settings!: RankigiWatcherSettings;
  chain!: WatcherChain;
  private lifecycleMonitor: LifecycleMonitor | null = null;
  private statusBar: WatcherStatusBar | null = null;
  private statusBarTimer: number | null = null;
  private pluginDir: string = "";

  async onload(): Promise<void> {
    await this.loadSettings();

    if (!this.settings.installId) {
      this.settings.installId = generateInstallId(12);
    }
    if (!this.settings.agentId) {
      this.settings.agentId = "RNK-WATCH-" + this.settings.installId;
    }
    await this.saveSettings();

    this.pluginDir = this.resolvePluginDir();
    this.chain = new WatcherChain(this.pluginDir);
    await this.chain.load();

    this.registerView(
      VIEW_TYPE_WATCHER,
      (leaf: WorkspaceLeaf) => new WatcherSidebarView(leaf, this.chain)
    );

    this.addRibbonIcon("shield-check", "Rankigi Watcher", () => {
      void this.activateSidebar();
    });

    const statusEl = this.addStatusBarItem();
    this.statusBar = new WatcherStatusBar(statusEl, () => {
      void this.activateSidebar();
    });
    this.refreshStatusBar();

    this.lifecycleMonitor = new LifecycleMonitor(this.app, this.chain, this.settings);
    this.lifecycleMonitor.onChange(() => {
      this.refreshSidebar();
      this.refreshStatusBar();
    });
    if (this.settings.monitorLifecycle) {
      this.lifecycleMonitor.start();
    }

    this.addSettingTab(new RankigiSettingTab(this.app, this));

    this.statusBarTimer = window.setInterval(() => {
      this.refreshStatusBar();
    }, STATUS_BAR_REFRESH_MS);
    this.registerInterval(this.statusBarTimer);

    // Genesis row, only on a fresh chain.
    if (this.chain.getHead().event_count === 0) {
      await this.chain.append({
        category: "LIFECYCLE",
        plugin_id: "rankigi-watcher",
        summary: "watcher started",
        payload: {
          event: "watcher_start",
          agent_id: this.settings.agentId,
          version: this.manifest.version,
        },
        severity: "info",
      });
      this.refreshSidebar();
      this.refreshStatusBar();
    }
  }

  async onunload(): Promise<void> {
    if (this.lifecycleMonitor) {
      this.lifecycleMonitor.stop();
      this.lifecycleMonitor = null;
    }
    if (this.statusBarTimer !== null) {
      window.clearInterval(this.statusBarTimer);
      this.statusBarTimer = null;
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_WATCHER);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<RankigiWatcherSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  applyMonitorSettings(): void {
    if (!this.lifecycleMonitor) return;
    if (this.settings.monitorLifecycle) {
      this.lifecycleMonitor.start();
    } else {
      this.lifecycleMonitor.stop();
    }
  }

  async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_WATCHER);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_WATCHER, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshStatusBar(): void {
    if (!this.statusBar) return;
    const head = this.chain.getHead();
    this.statusBar.update({
      eventCount: head.event_count,
      alertCount: 0,
      lastEventTs: head.last_event_ts,
    });
  }

  refreshSidebar(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_WATCHER);
    for (const leaf of leaves) {
      const view = leaf.view as WatcherSidebarView | undefined;
      if (!view || typeof view.refresh !== "function") continue;
      void this.chain.export().then((events) => view.refresh(events));
    }
  }

  async exportChainToFile(): Promise<void> {
    const events = await this.chain.export();
    const stamp = isoUtcMs().replace(/[:.]/g, "-");
    const outPath = path.join(this.pluginDir, "chain-export-" + stamp + ".jsonl");
    const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(outPath, text, "utf8");
    new Notice("Chain exported to " + outPath);
  }

  private resolvePluginDir(): string {
    const m = this.manifest as unknown as PluginManifestLite;
    if (m.dir && typeof m.dir === "string") {
      // Obsidian gives a vault-relative path, e.g. .obsidian/plugins/rankigi-watcher
      const adapter = this.app.vault.adapter as unknown as {
        basePath?: string;
        getBasePath?: () => string;
      };
      const base =
        typeof adapter.getBasePath === "function"
          ? adapter.getBasePath()
          : adapter.basePath ?? "";
      return path.join(base, m.dir);
    }
    return path.join(".", ".obsidian", "plugins", this.manifest.id);
  }
}
