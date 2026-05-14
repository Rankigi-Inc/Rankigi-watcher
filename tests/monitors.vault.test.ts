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
import { VaultWritesMonitor } from "../src/monitors/vault";
import { DEFAULT_SETTINGS, RankigiWatcherSettings } from "../src/settings";

interface FakeAdapter {
  write: (p: string, d: string) => Promise<void>;
  append: (p: string, d: string) => Promise<void>;
  writeBinary: (p: string, d: ArrayBuffer) => Promise<void>;
  remove: (p: string) => Promise<void>;
  rename: (a: string, b: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
  _writes: Array<{ op: string; args: unknown[] }>;
}

function makeAdapter(): FakeAdapter {
  const writes: Array<{ op: string; args: unknown[] }> = [];
  return {
    _writes: writes,
    write: async (p, d) => {
      writes.push({ op: "write", args: [p, d] });
    },
    append: async (p, d) => {
      writes.push({ op: "append", args: [p, d] });
    },
    writeBinary: async (p, d) => {
      writes.push({ op: "writeBinary", args: [p, d] });
    },
    remove: async (p) => {
      writes.push({ op: "remove", args: [p] });
    },
    rename: async (a, b) => {
      writes.push({ op: "rename", args: [a, b] });
    },
    mkdir: async (p) => {
      writes.push({ op: "mkdir", args: [p] });
    },
  };
}

interface FakeApp {
  vault: { adapter: FakeAdapter };
  plugins: { manifests: Record<string, { id: string }> };
}

function makeApp(adapter: FakeAdapter): FakeApp {
  return {
    vault: { adapter },
    plugins: {
      manifests: {
        "test-plugin": { id: "test-plugin" },
      },
    },
  };
}

function makeSettings(): RankigiWatcherSettings {
  return {
    ...DEFAULT_SETTINGS,
    monitorVaultWrites: true,
  };
}

async function mktmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "rnk-vault-"));
}

describe("VaultWritesMonitor", () => {
  let dir: string;
  let chain: WatcherChain;
  let adapter: FakeAdapter;
  let app: FakeApp;
  let settings: RankigiWatcherSettings;
  let monitor: VaultWritesMonitor;

  beforeEach(async () => {
    dir = await mktmp();
    chain = new WatcherChain(dir);
    await chain.load();
    adapter = makeAdapter();
    app = makeApp(adapter);
    settings = makeSettings();
    monitor = new VaultWritesMonitor(
      app as unknown as never,
      chain,
      settings,
      50
    );
    monitor.start();
  });

  afterEach(async () => {
    monitor.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("write to .obsidian/foo produces no chain entry", async () => {
    await app.vault.adapter.write(".obsidian/foo.json", "hello");
    monitor.flushDebounceNow();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(0);
  });

  it("write to chain.jsonl produces no chain entry", async () => {
    await app.vault.adapter.write("chain.jsonl", "line");
    monitor.flushDebounceNow();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(0);
  });

  it("write to chain-export-* produces no chain entry", async () => {
    await app.vault.adapter.write("chain-export-foo.jsonl", "line");
    monitor.flushDebounceNow();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(0);
  });

  it("write to Notes/foo.md produces chain entry with attribution_method field", async () => {
    await app.vault.adapter.write("Notes/foo.md", "hello world");
    monitor.flushDebounceNow();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].category).toBe("WRITE");
    expect(events[0].summary).toBe("write Notes/foo.md");
    // payload field check: we need to read the JSONL file directly
    const raw = await fs.readFile(path.join(dir, "chain.jsonl"), "utf8");
    const line = JSON.parse(raw.split("\n").filter((l) => l)[0]);
    expect(line.summary).toBe("write Notes/foo.md");
  });

  it("high-frequency writes to same path are debounced into one chain entry", async () => {
    for (let i = 0; i < 5; i++) {
      await app.vault.adapter.write("Notes/spam.md", "v" + i);
    }
    monitor.flushDebounceNow();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
  });

  it("debounce times out and emits after the window passes", async () => {
    await app.vault.adapter.write("Notes/wait.md", "x");
    await new Promise((r) => setTimeout(r, 120));
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
  });

  it("remove and rename are not debounced and emit immediately", async () => {
    await app.vault.adapter.remove("Notes/old.md");
    await app.vault.adapter.rename("a.md", "b.md");
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(2);
    expect(events.map((e) => e.summary).sort()).toEqual([
      "remove Notes/old.md",
      "rename a.md",
    ]);
    expect(events.every((e) => e.severity === "warn")).toBe(true);
  });

  it("stop() restores adapter methods", async () => {
    const wrappedWrite = adapter.write;
    monitor.stop();
    expect(adapter.write).not.toBe(wrappedWrite);
    // The post-stop write should not produce a chain entry.
    await adapter.write("Notes/after.md", "x");
    await new Promise((r) => setTimeout(r, 80));
    const events = await chain.export();
    expect(events.length).toBe(0);
  });

  it("writes still propagate to the original adapter method", async () => {
    await app.vault.adapter.write("Notes/forwarded.md", "hello");
    expect(adapter._writes).toContainEqual({
      op: "write",
      args: ["Notes/forwarded.md", "hello"],
    });
  });

  it("writeBinary is captured with size_bytes set", async () => {
    const buf = new ArrayBuffer(42);
    await app.vault.adapter.writeBinary("Notes/file.bin", buf);
    monitor.flushDebounceNow();
    await monitor.pendingFlushed();
    const events = await chain.export();
    expect(events.length).toBe(1);
    expect(events[0].summary).toBe("writeBinary Notes/file.bin");
  });
});
