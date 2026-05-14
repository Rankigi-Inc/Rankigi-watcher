import { GENESIS_PREV_HASH } from "./types";

function getSubtle(): SubtleCrypto {
  const g = globalThis as unknown as { crypto?: Crypto };
  if (!g.crypto || !g.crypto.subtle) {
    throw new Error("SubtleCrypto is unavailable in this environment");
  }
  return g.crypto.subtle;
}

export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await getSubtle().digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    const b = view[i].toString(16);
    hex += b.length === 1 ? "0" + b : b;
  }
  return hex;
}

export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson cannot serialize non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stringify(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + stringify(obj[k])
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error("canonicalJson cannot serialize value of type " + typeof value);
}

export async function hashPayload(
  payload: Record<string, unknown>
): Promise<string> {
  return sha256(canonicalJson(payload));
}

export async function computeEventHash(
  prevHash: string | null,
  payloadHash: string,
  ts: string
): Promise<string> {
  const prev = prevHash ?? GENESIS_PREV_HASH;
  return sha256(prev + payloadHash + ts);
}
