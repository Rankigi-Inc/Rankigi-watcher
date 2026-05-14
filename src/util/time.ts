export function isoUtcMs(): string {
  const d = new Date();
  const iso = d.toISOString();
  if (iso.indexOf(".") === -1) {
    return iso.replace("Z", ".000Z");
  }
  return iso;
}
