import type { Source } from "./policy.ts";

// Preserve case, punctuation, compatibility characters and line boundaries: they
// can distinguish identifiers, paths and instructions. Normalize presentation only.
export function normalizedText(text: string) {
  const value = text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  // Quoted strings, code and multiline indentation may carry significant spacing.
  return /[\n`"']/.test(value) ? value : value.replace(/[\t ]+/g, " ");
}

export const RETENTION = { revisions: 10, changeDays: 90, changesPerMemory: 10, jobDays: 30, requestDays: 2 };
export const DAY = 86400000;

export function combinedSources(groups: Source[][]): Source[] {
  const sources = [...new Map(groups.flat().map(source => [JSON.stringify(source), source])).values()];
  // Never silently lose provenance to fit storage. An overlarge merge is skipped.
  if (sources.length > 12 || JSON.stringify(sources).length > 6000) throw new Error("Consolidation evidence exceeds budget.");
  return sources;
}

export type Target = { id: string; revision: number };
export type Consolidation = { action: "add" | "ignore" | "merge" | "supersede"; targets: Target[]; reason?: string };
