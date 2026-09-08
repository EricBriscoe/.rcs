import type { Admission } from "./budget.ts";

type StatusStats = { reading: boolean; learning: boolean; jobs: { state: string; count: number }[] };

/** Quiet when healthy and idle; counts and scheduling details live in /memory. */
export function memoryStatus(stats: StatusStats, admission?: Admission, learningError = false): string | undefined {
  const parts: string[] = [];
  if (!stats.reading) parts.push("recall off");
  if (!stats.learning) parts.push("learning off");
  const has = (state: string) => stats.jobs.some(job => job.state === state && job.count > 0);
  if (has("failed")) parts.push("learning failed (/memory retry)");
  else if (learningError) parts.push("learning deferred (/memory)");
  else if (stats.learning && (has("pending") || has("running"))) {
    if (admission && !admission.allowed && admission.reason !== "working") {
      parts.push(`paused: ${admission.reason || admission.mode} (/memory)`);
    } else if (has("running") || admission?.allowed) {
      parts.push(`learning${admission ? ` (${admission.mode})` : ""}`);
    }
  }
  return parts.length ? `memory: ${parts.join(" · ")}` : undefined;
}
