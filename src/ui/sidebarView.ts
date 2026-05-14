import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { WatcherChain } from "../chain/chain";
import { WatcherEvent } from "../chain/types";

export const VIEW_TYPE_WATCHER = "rankigi-watcher-view";

const MAX_FEED_ROWS = 200;

export class WatcherSidebarView extends ItemView {
  private feedEl: HTMLElement | null = null;
  private hashEl: HTMLElement | null = null;
  private expanded: Set<string> = new Set();
  private events: WatcherEvent[] = [];

  constructor(leaf: WorkspaceLeaf, private chain: WatcherChain) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_WATCHER;
  }

  getDisplayText(): string {
    return "Rankigi Watcher";
  }

  getIcon(): string {
    return "shield-check";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("rankigi-watcher-container");

    const header = root.createDiv({ cls: "rankigi-watcher-header" });
    header.createSpan({
      cls: "rankigi-watcher-header-title",
      text: "RANKIGI WATCHER",
    });
    const hash = header.createSpan({ cls: "rankigi-watcher-header-hash" });
    hash.setAttribute("title", "Click to copy chain head hash");
    hash.addEventListener("click", () => this.copyHeadHash());
    this.hashEl = hash;

    this.feedEl = root.createDiv({ cls: "rankigi-watcher-feed" });

    root.createDiv({
      cls: "rankigi-watcher-stub",
      text: "Plugin Roster coming in v0.4.0",
    });

    const events = await this.chain.export();
    this.refresh(events);
  }

  async onClose(): Promise<void> {
    this.feedEl = null;
    this.hashEl = null;
  }

  refresh(events: WatcherEvent[]): void {
    this.events = events.slice(-MAX_FEED_ROWS);
    this.renderHead();
    this.renderFeed();
  }

  private renderHead(): void {
    if (!this.hashEl) return;
    const head = this.chain.getHead();
    if (!head.last_event_hash) {
      this.hashEl.textContent = "no chain";
      return;
    }
    this.hashEl.textContent = "#" + head.last_event_hash.slice(0, 8);
  }

  private renderFeed(): void {
    if (!this.feedEl) return;
    this.feedEl.empty();
    if (this.events.length === 0) {
      this.feedEl.createDiv({
        cls: "rankigi-watcher-feed-empty",
        text: "No events yet. Lifecycle changes will appear here.",
      });
      return;
    }
    const reversed = this.events.slice().reverse();
    for (const ev of reversed) {
      this.renderRow(ev);
    }
  }

  private renderRow(ev: WatcherEvent): void {
    if (!this.feedEl) return;
    const row = this.feedEl.createDiv({
      cls: "rankigi-watcher-row severity-" + ev.severity,
    });
    if (ev.severity !== "info") row.addClass("alert");
    row.createSpan({
      cls: "rankigi-watcher-row-cell",
      text: ev.ts.replace("T", " ").replace("Z", ""),
    });
    row.createSpan({ cls: "rankigi-watcher-row-cell", text: ev.category });
    row.createSpan({
      cls: "rankigi-watcher-row-cell",
      text: ev.plugin_id ?? "-",
    });
    row.createSpan({ cls: "rankigi-watcher-row-cell", text: ev.summary });
    row.createSpan({
      cls: "rankigi-watcher-row-cell",
      text: ev.severity === "info" ? "\u2713" : "\u25B2",
    });
    row.addEventListener("click", () => this.toggleExpand(ev));
    if (this.expanded.has(ev.event_id)) {
      const detail = this.feedEl.createDiv({ cls: "rankigi-watcher-row-expanded" });
      detail.createDiv({ text: "event_hash " + ev.event_hash });
      detail.createDiv({ text: "prev_hash  " + (ev.prev_hash ?? "(genesis)") });
      detail.createDiv({ text: "payload    " + ev.payload_hash });
    }
  }

  private toggleExpand(ev: WatcherEvent): void {
    if (this.expanded.has(ev.event_id)) {
      this.expanded.delete(ev.event_id);
    } else {
      this.expanded.add(ev.event_id);
    }
    this.renderFeed();
  }

  private async copyHeadHash(): Promise<void> {
    const head = this.chain.getHead();
    if (!head.last_event_hash) return;
    try {
      await navigator.clipboard.writeText(head.last_event_hash);
      new Notice("Chain head hash copied");
    } catch {
      new Notice("Clipboard unavailable");
    }
  }
}
