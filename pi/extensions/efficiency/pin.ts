/**
 * Prompt pinning. Pi applies extension system-prompt additions (memory, code
 * navigation, chrome primer, advertised agents) only through before_agent_start,
 * and clears that override when a run ends. A run started by a custom message
 * (monitor output, subagent notification) never re-runs before_agent_start, so
 * the next tool-set change inside it rebuilds the prompt as the bare base: the
 * additions vanish mid-session and the cached prefix breaks. Restore them.
 */
export interface PinInput { fresh: boolean; reference: string | undefined; current: string }

export function pinInstructions({ fresh, reference, current }: PinInput): { instructions: string; restored: boolean } {
  if (fresh || reference === undefined || current === reference) return { instructions: current, restored: false };
  // Additions are appended, so a dropped prompt is exactly the reference minus its tail.
  if (current.length < reference.length && reference.startsWith(current)) return { instructions: reference, restored: true };
  return { instructions: current, restored: false };
}
