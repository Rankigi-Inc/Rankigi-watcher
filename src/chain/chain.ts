import { promises as fs } from "fs";
import * as path from "path";
import {
  WatcherEvent,
  ChainHead,
  WatcherCategory,
  WatcherSeverity,
} from "./types";
import { computeEventHash, hashPayload } from "./hash";
import { isoUtcMs } from "../util/time";

export interface AppendParams {
  category: WatcherCategory;
  plugin_id: string | null;
  summary: string;
  payload: Record<string, unknown>;
  severity: WatcherSeverity;
}

export interface VerifyResult {
  valid: boolean;
  event_count: number;
  first_broken_index: number | null;
}

function newEventId(): string {
  const g = globalThis as unknown as { crypto?: Crypto };
  const buf = new Uint8Array(16);
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    g.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i].toString(16);
    hex.push(b.length === 1 ? "0" + b : b);
  }
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

export class WatcherChain {
  private chainPath: string;
  private head: ChainHead;

  constructor(pluginDir: string) {
    this.chainPath = path.join(pluginDir, "chain.jsonl");
    this.head = { event_count: 0, last_event_hash: null, last_event_ts: null };
  }

  getChainPath(): string {
    return this.chainPath;
  }

  getHead(): ChainHead {
    return { ...this.head };
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.chainPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        this.head = {
          event_count: 0,
          last_event_hash: null,
          last_event_ts: null,
        };
        return;
      }
      throw err;
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    let count = 0;
    let lastHash: string | null = null;
    let lastTs: string | null = null;
    for (const line of lines) {
      const ev = JSON.parse(line) as WatcherEvent;
      count++;
      lastHash = ev.event_hash;
      lastTs = ev.ts;
    }
    this.head = {
      event_count: count,
      last_event_hash: lastHash,
      last_event_ts: lastTs,
    };
  }

  async append(params: AppendParams): Promise<WatcherEvent> {
    const ts = isoUtcMs();
    const payload_hash = await hashPayload(params.payload);
    const prev_hash = this.head.last_event_hash;
    const event_hash = await computeEventHash(prev_hash, payload_hash, ts);
    const event: WatcherEvent = {
      event_id: newEventId(),
      ts,
      category: params.category,
      plugin_id: params.plugin_id,
      summary: params.summary,
      payload_hash,
      prev_hash,
      event_hash,
      severity: params.severity,
    };
    const line = JSON.stringify(event) + "\n";
    await fs.mkdir(path.dirname(this.chainPath), { recursive: true });
    await fs.appendFile(this.chainPath, line, "utf8");
    this.head = {
      event_count: this.head.event_count + 1,
      last_event_hash: event_hash,
      last_event_ts: ts,
    };
    return event;
  }

  async export(): Promise<WatcherEvent[]> {
    let text: string;
    try {
      text = await fs.readFile(this.chainPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return [];
      throw err;
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    return lines.map((l) => JSON.parse(l) as WatcherEvent);
  }

  async verify(): Promise<VerifyResult> {
    const events = await this.export();
    let prev: string | null = null;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.prev_hash !== prev) {
        return { valid: false, event_count: events.length, first_broken_index: i };
      }
      const expected = await computeEventHash(prev, ev.payload_hash, ev.ts);
      if (expected !== ev.event_hash) {
        return { valid: false, event_count: events.length, first_broken_index: i };
      }
      prev = ev.event_hash;
    }
    return { valid: true, event_count: events.length, first_broken_index: null };
  }

  async reset(): Promise<void> {
    try {
      await fs.unlink(this.chainPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
    this.head = { event_count: 0, last_event_hash: null, last_event_ts: null };
  }
}
