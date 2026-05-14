import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { webcrypto } from "crypto";

// Polyfill SubtleCrypto onto globalThis before importing chain modules.
const g = globalThis as unknown as { crypto?: Crypto };
if (!g.crypto || !g.crypto.subtle) {
  g.crypto = webcrypto as unknown as Crypto;
}

import {
  sha256,
  canonicalJson,
  computeEventHash,
  hashPayload,
} from "../src/chain/hash";
import { WatcherChain } from "../src/chain/chain";

async function mktmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "rnk-watch-"));
}

describe("hash", () => {
  it("sha256 produces correct hex for known input", async () => {
    // SHA-256("abc")
    const h = await sha256("abc");
    expect(h).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("sha256 handles empty input", async () => {
    const h = await sha256("");
    expect(h).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("canonicalJson produces stable output regardless of key order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalJson({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });

  it("canonicalJson preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("computeEventHash is deterministic for the same inputs", async () => {
    const ts = "2026-05-14T00:00:00.000Z";
    const ph = await hashPayload({ a: 1 });
    const h1 = await computeEventHash(null, ph, ts);
    const h2 = await computeEventHash(null, ph, ts);
    expect(h1).toBe(h2);
  });

  it("computeEventHash differs when prev_hash differs", async () => {
    const ts = "2026-05-14T00:00:00.000Z";
    const ph = await hashPayload({ a: 1 });
    const h1 = await computeEventHash(null, ph, ts);
    const h2 = await computeEventHash("a".repeat(64), ph, ts);
    expect(h1).not.toBe(h2);
  });
});

describe("WatcherChain", () => {
  let dir: string;
  let chain: WatcherChain;

  beforeEach(async () => {
    dir = await mktmp();
    chain = new WatcherChain(dir);
    await chain.load();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts empty when chain.jsonl does not exist", () => {
    const head = chain.getHead();
    expect(head.event_count).toBe(0);
    expect(head.last_event_hash).toBeNull();
    expect(head.last_event_ts).toBeNull();
  });

  it("append adds event and updates head", async () => {
    const ev = await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p1",
      summary: "installed v1.0.0",
      payload: { event: "install", plugin_id: "p1", version: "1.0.0" },
      severity: "info",
    });
    expect(ev.event_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.prev_hash).toBeNull();
    const head = chain.getHead();
    expect(head.event_count).toBe(1);
    expect(head.last_event_hash).toBe(ev.event_hash);
    expect(head.last_event_ts).toBe(ev.ts);
  });

  it("export returns all events in order", async () => {
    const a = await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p1",
      summary: "a",
      payload: { n: 1 },
      severity: "info",
    });
    const b = await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p2",
      summary: "b",
      payload: { n: 2 },
      severity: "info",
    });
    const all = await chain.export();
    expect(all).toHaveLength(2);
    expect(all[0].event_id).toBe(a.event_id);
    expect(all[1].event_id).toBe(b.event_id);
    expect(all[1].prev_hash).toBe(a.event_hash);
  });

  it("verify passes for untampered chain", async () => {
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p1",
      summary: "a",
      payload: { n: 1 },
      severity: "info",
    });
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p2",
      summary: "b",
      payload: { n: 2 },
      severity: "info",
    });
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p3",
      summary: "c",
      payload: { n: 3 },
      severity: "info",
    });
    const r = await chain.verify();
    expect(r.valid).toBe(true);
    expect(r.event_count).toBe(3);
    expect(r.first_broken_index).toBeNull();
  });

  it("verify detects tampered event_hash", async () => {
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p1",
      summary: "a",
      payload: { n: 1 },
      severity: "info",
    });
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p2",
      summary: "b",
      payload: { n: 2 },
      severity: "info",
    });
    const chainPath = path.join(dir, "chain.jsonl");
    const raw = await fs.readFile(chainPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const first = JSON.parse(lines[0]);
    // Flip one hex char in event_hash to simulate tampering.
    const h: string = first.event_hash;
    const flipped = (h[0] === "0" ? "1" : "0") + h.slice(1);
    first.event_hash = flipped;
    lines[0] = JSON.stringify(first);
    await fs.writeFile(chainPath, lines.join("\n") + "\n", "utf8");

    const r = await chain.verify();
    expect(r.valid).toBe(false);
    expect(r.first_broken_index).toBe(0);
  });

  it("verify detects broken prev_hash linkage", async () => {
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p1",
      summary: "a",
      payload: { n: 1 },
      severity: "info",
    });
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p2",
      summary: "b",
      payload: { n: 2 },
      severity: "info",
    });

    const chainPath = path.join(dir, "chain.jsonl");
    const raw = await fs.readFile(chainPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const second = JSON.parse(lines[1]);
    second.prev_hash = "f".repeat(64);
    lines[1] = JSON.stringify(second);
    await fs.writeFile(chainPath, lines.join("\n") + "\n", "utf8");

    const r = await chain.verify();
    expect(r.valid).toBe(false);
    expect(r.first_broken_index).toBe(1);
  });

  it("reset deletes the chain file and clears head", async () => {
    await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p1",
      summary: "a",
      payload: { n: 1 },
      severity: "info",
    });
    await chain.reset();
    const head = chain.getHead();
    expect(head.event_count).toBe(0);
    expect(head.last_event_hash).toBeNull();
    const all = await chain.export();
    expect(all).toHaveLength(0);
  });

  it("load reconstructs head from existing chain file", async () => {
    const a = await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p1",
      summary: "a",
      payload: { n: 1 },
      severity: "info",
    });
    const b = await chain.append({
      category: "LIFECYCLE",
      plugin_id: "p2",
      summary: "b",
      payload: { n: 2 },
      severity: "info",
    });
    const reopened = new WatcherChain(dir);
    await reopened.load();
    const head = reopened.getHead();
    expect(head.event_count).toBe(2);
    expect(head.last_event_hash).toBe(b.event_hash);
    expect(head.last_event_ts).toBe(b.ts);
    // sanity: a comes before b
    expect(b.prev_hash).toBe(a.event_hash);
  });
});
