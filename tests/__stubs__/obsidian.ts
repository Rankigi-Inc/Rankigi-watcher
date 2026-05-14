export class FileSystemAdapter {
  getBasePath(): string {
    return "/tmp/fake-vault";
  }
}

export class Modal {
  contentEl: { empty(): void; createEl(): unknown; createDiv(): unknown } = {
    empty: () => undefined,
    createEl: () => ({}),
    createDiv: () => ({}),
  };
  constructor(_app?: unknown) {}
  open(): void {}
  close(): void {}
}

export class PluginSettingTab {
  containerEl: { empty(): void; createEl(): unknown; createDiv(): unknown } = {
    empty: () => undefined,
    createEl: () => ({}),
    createDiv: () => ({}),
  };
  app: unknown;
  constructor(app: unknown, _plugin: unknown) {
    this.app = app;
  }
  display(): void {}
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName(_name: string): this {
    return this;
  }
  setDesc(_desc: string): this {
    return this;
  }
  addToggle(_fn: unknown): this {
    return this;
  }
  addButton(_fn: unknown): this {
    return this;
  }
  addText(_fn: unknown): this {
    return this;
  }
}

export class Notice {
  constructor(_msg: string) {}
}

export type App = unknown;
export type PluginManifest = {
  id: string;
  name?: string;
  version?: string;
  authorUrl?: string;
  fundingUrl?: string | Record<string, string>;
};
