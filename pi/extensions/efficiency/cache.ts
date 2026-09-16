import { createHash } from "node:crypto";

/** Per-request fingerprint of everything that forms the provider's cached prefix. */
export interface RequestFingerprint {
  instructions: string;
  instructionsLength: number;
  tools: Record<string, string>;
  toolNames: string[];
  input: string[];
  inputLabels: string[];
}

export interface CacheDiagnosis {
  cause: "system-prompt" | "tools" | "conversation" | "provider";
  summary: string;
}

const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
const toolName = (tool: any) => String(tool?.name ?? tool?.function?.name ?? "?");
const label = (item: any) => item?.type === "function_call" ? `function_call ${item.name ?? "?"}` : item?.type === "function_call_output" ? "function_call_output" : item?.role ? String(item.role) : String(item?.type ?? "item");

export function fingerprintRequest(payload: any): RequestFingerprint {
  const instructions = String(payload?.instructions ?? "");
  const tools: Record<string, string> = {};
  for (const tool of payload?.tools ?? []) tools[toolName(tool)] = sha(tool);
  const input = Array.isArray(payload?.input) ? payload.input : [];
  return { instructions: sha(instructions), instructionsLength: instructions.length, tools, toolNames: Object.keys(tools), input: input.map(sha), inputLabels: input.map(label) };
}

/** A drop is a cache read well below the previous request's context, once contexts are big enough to matter. */
export function isCacheDrop({ previousContext, cacheRead }: { previousContext: number; cacheRead: number }) {
  return previousContext >= 16384 && cacheRead < previousContext - 4096;
}

const formatGap = (ms: number) => ms >= 60_000 ? `idle ${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s since last request`;

export function diagnoseCacheDrop(previous: RequestFingerprint, current: RequestFingerprint, { gapMs }: { gapMs: number }): CacheDiagnosis {
  if (previous.instructions !== current.instructions) {
    const delta = current.instructionsLength - previous.instructionsLength;
    return { cause: "system-prompt", summary: `system prompt changed (${delta >= 0 ? "+" : ""}${delta} chars)` };
  }
  const added = current.toolNames.filter(name => !(name in previous.tools)), removed = previous.toolNames.filter(name => !(name in current.tools));
  const redefined = current.toolNames.filter(name => name in previous.tools && previous.tools[name] !== current.tools[name]);
  if (added.length || removed.length) return { cause: "tools", summary: `tools changed: ${[...added.map(n => `+${n}`), ...removed.map(n => `-${n}`)].join(", ")}` };
  if (redefined.length) return { cause: "tools", summary: `tool definition changed: ${redefined.join(", ")}` };
  const shared = Math.min(previous.input.length, current.input.length);
  for (let index = 0; index < shared; index++) {
    if (previous.input[index] !== current.input[index]) return { cause: "conversation", summary: `conversation diverged at item ${index + 1} of ${current.input.length} (${current.inputLabels[index]})` };
  }
  if (current.input.length < previous.input.length) return { cause: "conversation", summary: `conversation shortened to ${current.input.length} items (was ${previous.input.length})` };
  return { cause: "provider", summary: `request unchanged; provider-side eviction or routing (${formatGap(gapMs)})` };
}
