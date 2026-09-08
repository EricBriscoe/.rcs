export const DEFAULT_BUDGET = { pause: 30, resume: 40, fallback: 20, quota: 100 };
export type BudgetPolicy = typeof DEFAULT_BUDGET;
export type Admission = { allowed: boolean; mode: "quota" | "fallback"; reason?: string; nextAt?: number; accountId?: string };
export class BackgroundDeferred extends Error {
  code = "MEMORY_BACKGROUND_DEFERRED";
  admission: Admission;
  submitted = false;
  constructor(admission: Admission) { super(admission.reason ?? "Learning deferred"); this.admission = admission; }
}
export function validateBudget(value: BudgetPolicy): BudgetPolicy {
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_BUDGET, key)) ||
      !Object.values(value).every(Number.isInteger) || value.pause < 1 || value.resume > 100 || value.resume <= value.pause ||
      value.fallback < 1 || value.quota < value.fallback || value.quota > 1000) {
    throw new Error("Budget requires 1 ≤ pause < resume ≤ 100 and 1 ≤ fallback ≤ quota ≤ 1000.");
  }
  return value;
}
export function admissionText(admission?: Admission) {
  if (!admission) return "waiting for idle";
  return `${admission.mode}${admission.reason ? ` · ${admission.reason}` : " · learning"}${admission.nextAt ? ` · next ${new Date(admission.nextAt).toISOString()}` : ""}`;
}
