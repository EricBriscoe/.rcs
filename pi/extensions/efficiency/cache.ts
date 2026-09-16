import { createHash } from "node:crypto";

/** Per-request fingerprint of everything that forms the provider's cached prefix. */
export interface RequestFingerprint {
  instructions: string;
  instructionsLength: number;
  /** Which known extension-injected sections the system prompt contained. */
  sections: string[];
  tools: Record<string, string>;
  toolNames: string[];
  input: string[];
  inputLabels: string[];
}

export interface CacheDiagnosis {
  cause: "system-prompt" | "tools" | "conversation" | "provider";
  summary: string;
}

/** Markers of blocks that extensions append to the system prompt; names are what the diagnosis reports. */
const SECTION_MARKERS: [name: string, marker: string][] = [
  ["skills", "<available_skills>"],
  ["project-instructions", "<project_instructions"],
  ["code-navigation", "# First-visit code navigation setup"],
  ["memory", "\n## Memory"],
  ["chrome", "<chrome-profile-bridge>"],
  ["subagents", "<available_agents"],
];

const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
const toolName = (tool: any) => String(tool?.name ?? tool?.function?.name ?? "?");
const label = (item: any) => item?.type === "function_call" ? `function_call ${item.name ?? "?"}` : item?.type === "function_call_output" ? "function_call_output" : item?.role ? String(item.role) : String(item?.type ?? "item");

export function fingerprintRequest(payload: any): RequestFingerprint {
  const instructions = String(payload?.instructions ?? "");
  const tools: Record<string, string> = {};
  for (const tool of payload?.tools ?? []) tools[toolName(tool)] = sha(tool);
  const input = Array.isArray(payload?.input) ? payload.input : [];
  return {
    instructions: sha(instructions), instructionsLength: instructions.length,
    sections: SECTION_MARKERS.filter(([, marker]) => instructions.includes(marker)).map(([name]) => name),
    tools, toolNames: Object.keys(tools), input: input.map(sha), inputLabels: input.map(label),
  };
}

/** A drop is a cache read well below the previous request's context, once contexts are big enough to matter. */
export function isCacheDrop({ previousContext, cacheRead }: { previousContext: number; cacheRead: number }) {
  return previousContext >= 16384 && cacheRead < previousContext - 4096;
}

const formatGap = (ms: number) => ms >= 60_000 ? `idle ${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s since last request`;

function promptChange(previous: RequestFingerprint, current: RequestFingerprint): string | undefined {
  if (previous.instructions === current.instructions) return undefined;
  const delta = current.instructionsLength - previous.instructionsLength;
  const removed = previous.sections.filter(name => !current.sections.includes(name));
  const added = current.sections.filter(name => !previous.sections.includes(name));
  const detail = [removed.length ? `removed: ${removed.join(", ")}` : "", added.length ? `added: ${added.join(", ")}` : ""].filter(Boolean).join("; ");
  return `system prompt changed (${delta >= 0 ? "+" : ""}${delta} chars${detail ? `; ${detail}` : ""})`;
}

function toolsChange(previous: RequestFingerprint, current: RequestFingerprint): string | undefined {
  const added = current.toolNames.filter(name => !(name in previous.tools)), removed = previous.toolNames.filter(name => !(name in current.tools));
  const redefined = current.toolNames.filter(name => name in previous.tools && previous.tools[name] !== current.tools[name]);
  if (added.length || removed.length) return `tools changed: ${[...added.map(n => `+${n}`), ...removed.map(n => `-${n}`)].join(", ")}`;
  if (redefined.length) return `tool definition changed: ${redefined.join(", ")}`;
  return undefined;
}

function conversationChange(previous: RequestFingerprint, current: RequestFingerprint): string | undefined {
  const shared = Math.min(previous.input.length, current.input.length);
  for (let index = 0; index < shared; index++) {
    if (previous.input[index] !== current.input[index]) return `conversation diverged at item ${index + 1} of ${current.input.length} (${current.inputLabels[index]})`;
  }
  if (current.input.length < previous.input.length) return `conversation shortened to ${current.input.length} items (was ${previous.input.length})`;
  return undefined;
}

/** Every changed component is reported; the first one is the cause the cache broke on. */
export function diagnoseCacheDrop(previous: RequestFingerprint, current: RequestFingerprint, { gapMs }: { gapMs: number }): CacheDiagnosis {
  const parts: [CacheDiagnosis["cause"], string | undefined][] = [
    ["system-prompt", promptChange(previous, current)],
    ["tools", toolsChange(previous, current)],
    ["conversation", conversationChange(previous, current)],
  ];
  const changed = parts.filter((part): part is [CacheDiagnosis["cause"], string] => part[1] !== undefined);
  if (changed.length === 0) return { cause: "provider", summary: `request unchanged; provider-side eviction or routing (${formatGap(gapMs)})` };
  return { cause: changed[0][0], summary: changed.map(part => part[1]).join("; ") };
}
