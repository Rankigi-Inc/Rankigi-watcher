export type WatcherCategory =
  | "LIFECYCLE"
  | "NETWORK"
  | "WRITE"
  | "CLIPBOARD"
  | "SHELL";

export type WatcherSeverity = "info" | "warn" | "critical";

export interface WatcherEvent {
  event_id: string;
  ts: string;
  category: WatcherCategory;
  plugin_id: string | null;
  summary: string;
  payload_hash: string;
  prev_hash: string | null;
  event_hash: string;
  severity: WatcherSeverity;
}

export interface ChainHead {
  event_count: number;
  last_event_hash: string | null;
  last_event_ts: string | null;
}

export const GENESIS_PREV_HASH = "0".repeat(64);
