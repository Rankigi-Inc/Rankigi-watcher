export type StatusBarState = "clean" | "active" | "alert";

export interface StatusBarUpdate {
  eventCount: number;
  alertCount: number;
  lastEventTs: string | null;
}

const ACTIVE_WINDOW_MS = 60_000;

export class WatcherStatusBar {
  private state: StatusBarState = "clean";
  private alertCount = 0;

  constructor(
    private el: HTMLElement,
    private onClick: () => void
  ) {
    this.el.addClass("rankigi-status-bar-item");
    this.el.addClass("rankigi-status-clean");
    this.el.setAttribute("aria-label", "Rankigi Watcher");
    this.el.style.cursor = "pointer";
    this.el.addEventListener("click", () => this.onClick());
    this.render({ eventCount: 0, alertCount: 0, lastEventTs: null });
  }

  update(params: StatusBarUpdate): void {
    this.render(params);
  }

  setAlert(count: number): void {
    this.alertCount = count;
    this.state = "alert";
    this.applyClass();
    this.el.textContent = "RNK \u25B2 " + count;
  }

  clearAlert(): void {
    this.alertCount = 0;
    this.render({ eventCount: 0, alertCount: 0, lastEventTs: null });
  }

  private render(params: StatusBarUpdate): void {
    if (params.alertCount > 0) {
      this.alertCount = params.alertCount;
      this.state = "alert";
      this.el.textContent = "RNK \u25B2 " + params.alertCount;
    } else {
      const recent =
        params.lastEventTs !== null &&
        Date.now() - new Date(params.lastEventTs).getTime() < ACTIVE_WINDOW_MS;
      this.state = recent ? "active" : "clean";
      this.el.textContent = "RNK \u25CF " + params.eventCount;
    }
    this.applyClass();
  }

  private applyClass(): void {
    this.el.removeClass("rankigi-status-clean");
    this.el.removeClass("rankigi-status-active");
    this.el.removeClass("rankigi-status-alert");
    this.el.addClass("rankigi-status-" + this.state);
  }

  getState(): StatusBarState {
    return this.state;
  }
}
