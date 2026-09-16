/**
 * External usage: model calls made by other extensions (pi-condense summaries)
 * never become assistant messages, so transcript readers such as token-widget
 * cannot see them. pi-condense publishes cumulative cost updates on Pi's
 * extension event bus; turn those into per-flush `external-usage` session
 * entries carrying the model and token lanes. Custom entries never enter the
 * model context.
 */
export interface ExternalUsageTotals { input: number; output: number; cost: number }
export interface ExternalCostUpdate { source?: string; inputTokens?: number; outputTokens?: number; totalCost?: number }

const nonNegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const round = (value: number) => Math.round(value * 1e9) / 1e9;

/** Cumulative updates become deltas; a cumulative below the last seen means the source restarted. */
export function externalUsageDelta(previous: ExternalUsageTotals | undefined, update: ExternalCostUpdate): ExternalUsageTotals {
  const current = { input: nonNegative(update.inputTokens), output: nonNegative(update.outputTokens), cost: nonNegative(update.totalCost) };
  if (!previous || current.input < previous.input || current.output < previous.output) return current;
  return { input: current.input - previous.input, output: current.output - previous.output, cost: round(Math.max(0, current.cost - previous.cost)) };
}

/** `contextPrune.summarizerModel` as "provider/model", else the session model. */
export function summarizerModel(settings: any, sessionModel: { provider?: string; id?: string } | undefined): { provider: string; model: string } {
  const configured = settings?.contextPrune?.summarizerModel;
  if (typeof configured === "string" && configured.includes("/")) {
    const slash = configured.indexOf("/");
    return { provider: configured.slice(0, slash), model: configured.slice(slash + 1) };
  }
  return { provider: sessionModel?.provider || "unknown", model: sessionModel?.id || "unknown" };
}

export const nonNegativeTotal = (value: unknown) => nonNegative(value);
