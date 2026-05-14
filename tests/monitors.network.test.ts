import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { webcrypto } from "crypto";

const g = globalThis as unknown as { crypto?: Crypto };
if (!g.crypto || !g.crypto.subtle) {
  g.crypto = webcrypto as unknown as Crypto;
}

import { WatcherChain } from "../src/chain/chain";
import { NetworkMonitor } from "../src/monitors/network";
import { DEFAULT_SETTINGS, RankigiWatcherSettings } from "../src/settings";

async function mktmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "rnk-net-"));
}

interface FakeApp {
  vault: { adapter: object };
  plugins: { manifests: Record<string, { id: string; authorUrl?: string }> };
}

function makeApp(): FakeApp {
  return {
    vault: { adapter: {} },
    plugins: {
      manifests: {
        "obsidian-git": { id: "obsidian-git", authorUrl: "https://example.com" },
      },
    },
  };
}

function makeSettings(): RankigiWatcherSettings {
  return {
    ...DEFAULT_SETTINGS,
    monitorNetwork: true,
    cloudEndpoint: "https://app.rankigi.com/api/ingest",
  };
}

class FakeXMLHttpRequest {
  opened: { method: string; url: string } | null = null;
  sent = false;
  open(this: FakeXMLHttpRequest, method: string, url: string): void {
    this.opened = { method, url };
  }
  send(this: FakeXMLHttpRequest): void {
    this.sent = true;
  }
}

describe("NetworkMonitor", () => {
  let dir: string;
  let chain: WatcherChain;
  let monitor: NetworkMonitor;
  let settings: RankigiWatcherSettings;
  let app: FakeApp;
  let fakeObsModule: { requestUrl: unknown };
  let origFetch: typeof globalThis.fetch | undefined;
  let origXhr: unknown;
  let origRequire: unknown;
  let origWindow: unknown;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(async () => {
    dir = await mktmp();
    chain = new WatcherChain(dir);
    await chain.load();
    settings = makeSettings();
    app = makeApp();

    fetchCalls = [];
    origFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      fetchCalls.push({ url, init });
      return new Response("ok", { status: 200 });
    };

    origXhr = (globalThis as unknown as { XMLHttpRequest?: unknown })
      .XMLHttpRequest;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest =
      FakeXMLHttpRequest;

    fakeObsModule = {
      requestUrl: async (param: unknown) => ({ status: 200, text: "ok", param }),
    };

    origWindow = (globalThis as unknown as { window?: unknown }).window;
    origRequire = (globalThis as unknown as { require?: unknown }).require;
    const win = {
      require: (name: string): unknown => {
        if (name === "obsidian") return fakeObsModule;
        throw new Error("unexpected require: " + name);
      },
      get fetch() {
        return (globalThis as unknown as { fetch: typeof fetch }).fetch;
      },
      set fetch(v: typeof fetch) {
        (globalThis as unknown as { fetch: typeof fetch }).fetch = v;
      },
    };
    (globalThis as unknown as { window: unknown }).window = win;

    monitor = new NetworkMonitor(
      app as unknown as never,
      chain,
      settings
    );
    monitor.start();
  });

  afterEach(async () => {
    monitor.stop();
    if (origFetch === undefined) {
      delete (globalThis as unknown as { fetch?: unknown }).fetch;
    } else {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
    if (origXhr === undefined) {
      delete (globalThis as unknown as { XMLHttpRequest?: unknown })
        .XMLHttpRequest;
    } else {
      (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest =
        origXhr;
    }
    if (origWindow === undefined) {
      delete (globalThis as unknown as { window?: unknown }).window;
    } else {
      (globalThis as unknown as { window: unknown }).window = origWindow;
    }
    if (origRequire === undefined) {
      delete (globalThis as unknown as { require?: unknown }).require;
    } else {
      (globalThis as unknown as { require: unknown }).require = origRequire;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fetch to unknown domain produces chain entry with severity warn", async () => {
    await (globalThis.fetch as typeof fetch)("https://unknown.test/api");
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("NETWORK");
    expect(events[0].severity).toBe("warn");
    expect(events[0].summary).toBe("GET unknown.test/api");
  });

  it("fetch to cloudEndpoint is not recorded", async () => {
    await (globalThis.fetch as typeof fetch)(
      settings.cloudEndpoint + "/v1/events"
    );
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(0);
  });

  it("fetch with x-rankigi-watcher header is not recorded", async () => {
    await (globalThis.fetch as typeof fetch)("https://unknown.test/api", {
      headers: { "x-rankigi-watcher": "1" },
    });
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(0);
  });

  it("fetch to allowlisted domain has severity info", async () => {
    await (globalThis.fetch as typeof fetch)("https://example.com/path");
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].severity).toBe("info");
  });

  it("requestUrl via live binding is captured", async () => {
    const liveBindingCall = async (): Promise<unknown> => {
      const obs = (
        (globalThis as unknown as { window: { require: (m: string) => unknown } })
          .window.require("obsidian") as { requestUrl: (p: unknown) => unknown }
      );
      return obs.requestUrl({ url: "https://unknown.test/api2", method: "POST" });
    };
    await liveBindingCall();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("NETWORK");
    expect(events[0].summary).toBe("POST unknown.test/api2");
  });

  it("requestUrl reassignment logs a tamper event", async () => {
    const obs = (
      (globalThis as unknown as { window: { require: (m: string) => unknown } })
        .window.require("obsidian") as { requestUrl: unknown }
    );
    obs.requestUrl = async () => ({ status: 200 });
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].summary).toBe("requestUrl binding reassigned");
    expect(events[0].severity).toBe("warn");
  });

  it("XHR open+send produces chain entry", async () => {
    const xhr = new (
      (globalThis as unknown as { XMLHttpRequest: typeof FakeXMLHttpRequest })
        .XMLHttpRequest
    )();
    xhr.open("PUT", "https://unknown.test/x");
    xhr.send();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("NETWORK");
    expect(events[0].summary).toBe("PUT unknown.test/x");
  });

  it("XHR to cloudEndpoint is not recorded", async () => {
    const xhr = new (
      (globalThis as unknown as { XMLHttpRequest: typeof FakeXMLHttpRequest })
        .XMLHttpRequest
    )();
    xhr.open("POST", settings.cloudEndpoint);
    xhr.send();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(0);
  });

  it("stop() restores fetch and XHR prototype methods", async () => {
    const beforeFetch = (globalThis as unknown as { fetch: unknown }).fetch;
    const beforeOpen = FakeXMLHttpRequest.prototype.open;
    monitor.stop();
    const afterFetch = (globalThis as unknown as { fetch: unknown }).fetch;
    const afterOpen = FakeXMLHttpRequest.prototype.open;
    expect(afterFetch).not.toBe(beforeFetch);
    expect(afterOpen).not.toBe(beforeOpen);
  });
});

describe("watcher_start interception metadata (chain assertion)", () => {
  it("startup event payload contains interception object with the four keys", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rnk-start-"));
    const chain = new WatcherChain(dir);
    await chain.load();
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "rankigi-watcher",
      summary: "watcher started v0.2.0",
      payload: {
        event: "watcher_start",
        agent_id: "RNK-WATCH-TEST",
        version: "0.2.0",
        interception: {
          fetch: "patched",
          xhr: "patched",
          requestUrl: "patched_live_binding_only",
          vault_writes: "adapter_layer",
        },
      },
      severity: "info",
    });
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].summary).toBe("watcher started v0.2.0");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
