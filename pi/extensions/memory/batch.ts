import type { Evidence, Payload } from "./policy.ts";

// Keep source revisions apart: an entry ID names exactly one text within an extraction.
// Whole jobs that do not fit are left pending; legacy oversized jobs progress by entry.
export function packBatch(rows: any[]) {
  const first = rows[0];
  if (!first) return undefined;
  const entries = new Map<string, Evidence>();
  const members: any[] = [];
  const origins: Record<string, { created_at: number; sequence: number }> = {};
  for (const row of rows) {
    if (row.session !== first.session || row.generation !== first.generation) continue;
    const payload: Payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    if (payload.entries.some(entry => entries.has(entry.id) && JSON.stringify(entries.get(entry.id)) !== JSON.stringify(entry))) break;
    const merged = new Map(entries);
    for (const entry of payload.entries) merged.set(entry.id, entry);
    const fits = (values: Evidence[]) => values.reduce((n, entry) => n + entry.text.length, 0) <= 18000 &&
      Buffer.byteLength(JSON.stringify({ session: first.session, entries: values })) <= 29900;
    let sent = payload.entries;
    if (!fits([...merged.values()])) {
      if (members.length) break;
      sent = [];
      for (const entry of payload.entries) {
        if (!fits([...sent, entry])) break;
        sent.push(entry);
      }
      // An indivisible malformed old entry is retained, never silently discarded.
      if (!sent.length) return undefined;
    }
    for (const entry of sent) {
      entries.set(entry.id, entry);
      origins[entry.id] ??= { created_at: row.created_at, sequence: row.sequence };
    }
    members.push({ ...row, remainder: payload.entries.slice(sent.length) });
    if (sent.length < payload.entries.length) break;
  }
  return { ...first, members, origins, payload: { session: first.session, entries: [...entries.values()] } };
}
