const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    g.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return buf;
}

export function generateInstallId(length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function generateAgentId(): string {
  return "RNK-WATCH-" + generateInstallId(12);
}
