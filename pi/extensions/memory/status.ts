import type { Admission } from "./budget.ts";
import type { LearningOutcome } from "./learner.ts";

export type RecallStatus = { state: "not-run" | "recalled" | "no-match" | "empty" | "off" | "unavailable"; count: number };
type StatusStats = { reading: boolean | number; learning: boolean | number; jobs: { state: string; count: number }[] };

export function recallStatus(recall: RecallStatus): string {
  switch (recall.state) {
    case "recalled": return `Recalled ${recall.count} ${recall.count === 1 ? "memory" : "memories"} (/memory)`;
    case "empty": return "Memory: no saved project or global notes (/memory)";
    case "no-match": return "Memory: no matching notes (/memory)";
    case "off": return "Memory: recall off (/memory read on)";
    case "unavailable": return "Memory: recall unavailable (/memory)";
    default: return "Memory: recall runs on your next prompt (/memory)";
  }
}

export function learningOutcome(outcome: LearningOutcome): string {
  if (!outcome.proposed) return "Last learning pass: no durable memories proposed (not an error).";
  const skipped = Object.entries(outcome.skipped).map(([reason, count]) => `${reason}: ${count}`).join(", ");
  return `Last learning pass: ${outcome.saved} saved/updated of ${outcome.proposed} proposed${skipped ? `; skipped ${skipped}` : ""}.`;
}

/** Recall has its own widget; the footer reports learning activity and blockers. */
export function memoryStatus(stats: StatusStats, admission?: Admission, learningError = false, outcome?: LearningOutcome): string | undefined {
  const parts: string[] = [];
  if (!stats.reading) parts.push("recall off");
  if (!stats.learning) parts.push("learning off");
  const has = (state: string) => stats.jobs.some(job => job.state === state && job.count > 0);
  if (has("failed")) parts.push("learning failed (/memory retry)");
  else if (learningError) parts.push("learning deferred (/memory)");
  else if (stats.learning && (has("pending") || has("running"))) {
    if (admission && !admission.allowed && admission.reason !== "working") {
      parts.push(`paused: ${admission.reason || admission.mode} (/memory)`);
    } else if (has("running")) {
      parts.push(`learning${admission ? ` (${admission.mode})` : ""}`);
    } else {
      parts.push("learning queued (waiting for idle)");
    }
  } else if (stats.learning && outcome && !outcome.saved) {
    parts.push(outcome.proposed ? "last pass skipped all proposals (/memory)" : "last pass found no durable notes (/memory)");
  }
  return parts.length ? `memory: ${parts.join(" · ")}` : undefined;
}
