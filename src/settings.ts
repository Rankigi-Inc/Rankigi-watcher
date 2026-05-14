import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type RankigiWatcherPlugin from "./main";

export interface RankigiWatcherSettings {
  monitorLifecycle: boolean;
  monitorNetwork: boolean;
  monitorVaultWrites: boolean;
  monitorClipboard: boolean;
  monitorShell: boolean;
  apiKey: string;
  cloudEnabled: boolean;
  cloudEndpoint: string;
  agentId: string;
  installId: string;
}

export const DEFAULT_SETTINGS: RankigiWatcherSettings = {
  monitorLifecycle: true,
  monitorNetwork: true,
  monitorVaultWrites: true,
  monitorClipboard: false,
  monitorShell: true,
  apiKey: "",
  cloudEnabled: false,
  cloudEndpoint: "https://app.rankigi.com/api/ingest",
  agentId: "",
  installId: "",
};

class ConfirmResetModal extends Modal {
  constructor(app: App, private onConfirm: () => Promise<void>) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Reset local chain?" });
    contentEl.createEl("p", {
      text:
        "This permanently deletes chain.jsonl. Past events cannot be recovered. " +
        "Export the chain first if you want a copy.",
    });
    const row = contentEl.createDiv();
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.justifyContent = "flex-end";
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const ok = row.createEl("button", { text: "Reset chain" });
    ok.addClass("mod-warning");
    ok.addEventListener("click", async () => {
      await this.onConfirm();
      this.close();
    });
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

export class RankigiSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: RankigiWatcherPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderMonitoring(containerEl);
    this.renderLocalChain(containerEl);
    this.renderCloud(containerEl);
    this.renderAbout(containerEl);
  }

  private renderMonitoring(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Monitoring" });

    new Setting(containerEl)
      .setName("Plugin Lifecycle")
      .setDesc(
        "Record plugin installs, enables, disables, updates, and removals. Recommended."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.monitorLifecycle).onChange(async (v) => {
          this.plugin.settings.monitorLifecycle = v;
          await this.plugin.saveSettings();
          this.plugin.applyMonitorSettings();
        })
      );

    new Setting(containerEl)
      .setName("Network Activity")
      .setDesc("Record plugin network requests. Available in v0.2.0.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.monitorNetwork)
          .setDisabled(true)
          .onChange(async (v) => {
            this.plugin.settings.monitorNetwork = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Vault Writes")
      .setDesc("Record vault file creates, modifies, deletes, renames. Available in v0.2.0.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.monitorVaultWrites)
          .setDisabled(true)
          .onChange(async (v) => {
            this.plugin.settings.monitorVaultWrites = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Clipboard Access")
      .setDesc("Record clipboard reads and writes by plugins. Available in v0.4.0.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.monitorClipboard)
          .setDisabled(true)
          .onChange(async (v) => {
            this.plugin.settings.monitorClipboard = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Shell and FS Escape")
      .setDesc("Record shell exec and filesystem writes outside the vault. Available in v0.4.0.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.monitorShell)
          .setDisabled(true)
          .onChange(async (v) => {
            this.plugin.settings.monitorShell = v;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderLocalChain(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Local Chain" });

    const info = containerEl.createDiv({ cls: "rankigi-settings-chain-info" });
    const head = this.plugin.chain.getHead();
    const headHash = head.last_event_hash ?? "(empty)";
    const lastTs = head.last_event_ts ?? "(none)";
    const rows: Array<[string, string]> = [
      ["Head hash", headHash],
      ["Event count", String(head.event_count)],
      ["Last event", lastTs],
      ["Chain file", this.plugin.chain.getChainPath()],
    ];
    for (const [label, value] of rows) {
      const row = info.createDiv({ cls: "rankigi-settings-chain-info-row" });
      row.createSpan({
        cls: "rankigi-settings-chain-info-label",
        text: label,
      });
      row.createSpan({ text: value });
    }

    new Setting(containerEl)
      .setName("Verify chain")
      .setDesc("Recompute every event hash and check linkage.")
      .addButton((b) =>
        b.setButtonText("Verify").onClick(async () => {
          const r = await this.plugin.chain.verify();
          if (r.valid) {
            new Notice("Chain valid. " + r.event_count + " events.");
          } else {
            new Notice(
              "Chain broken at index " + String(r.first_broken_index)
            );
          }
        })
      );

    new Setting(containerEl)
      .setName("Export chain")
      .setDesc("Write chain to a file in the plugin directory.")
      .addButton((b) =>
        b.setButtonText("Export").onClick(async () => {
          await this.plugin.exportChainToFile();
        })
      );

    new Setting(containerEl)
      .setName("Reset chain")
      .setDesc("Permanently delete the local chain. Export first if you want a copy.")
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(() => {
            new ConfirmResetModal(this.app, async () => {
              await this.plugin.chain.reset();
              new Notice("Chain reset");
              this.display();
            }).open();
          })
      );
  }

  private renderCloud(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "RANKIGI Cloud" });
    const desc = containerEl.createDiv();
    desc.createEl("p", {
      text: "Stream events to app.rankigi.com for a multi-vault dashboard. Coming in v0.3.0.",
    });
    const linkP = desc.createEl("p");
    linkP.createEl("a", {
      text: "rankigi.com",
      href: "https://rankigi.com",
    });

    new Setting(containerEl)
      .setName("Agent ID")
      .setDesc("Stable identifier for this install. Sent only when cloud sync is enabled.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.agentId)
          .setDisabled(true)
      );
  }

  private renderAbout(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "About" });
    const p = containerEl.createEl("p");
    p.appendText("Rankigi Watcher v" + this.plugin.manifest.version + ". ");
    p.createEl("a", {
      text: "github.com/Rankigi-Inc/Rankigi-watcher",
      href: "https://github.com/Rankigi-Inc/Rankigi-watcher",
    });
  }
}
