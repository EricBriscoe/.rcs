import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_HTML_BYTES = 180_000;
const MAX_RUN_FILES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = value => typeof value === "string" ? value : undefined;
const safeLabel = value => text(value)?.replace(/[^A-Za-z0-9 ._/-]/g, "").slice(0, 48) || undefined;

function jsonAfter(source, marker) {
  const index = source.indexOf(marker);
  if (index < 0) return undefined;
  let start = index + marker.length;
  while (/\s/.test(source[start] || "")) start++;
  if (source[start] !== "{" && source[start] !== "[") return undefined;
  const open = source[start], close = open === "{" ? "}" : "]";
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) {
      try { return JSON.parse(source.slice(start, i + 1)); } catch { return undefined; }
    }
  }
}

function flightChunks(html) {
  const chunks = [];
  const scripts = html.matchAll(/<script[^>]*>\s*self\.__next_f\.push\((.*?)\)<\/script>/gs);
  for (const match of scripts) {
    try {
      const payload = JSON.parse(match[1]);
      if (Array.isArray(payload) && typeof payload[1] === "string") chunks.push(payload[1]);
    } catch { /* Untrusted markup is data, never code. */ }
  }
  return chunks;
}

function normalizeBenchmark(leaderboard, rows) {
  const board = object(leaderboard);
  if (!board || !text(board.name) || !Array.isArray(rows)) return undefined;
  const validRows = [];
  for (const raw of rows) {
    const row = object(raw), metadata = object(row?.metadata), metrics = object(row?.metrics);
    const model = object(metadata?.model_display), agent = object(metadata?.agent_display);
    const accuracy = finite(metrics?.accuracy), nTrials = finite(metrics?.n_trials), cost = finite(metrics?.total_cost_usd);
    const tokens = finite(metrics?.total_tokens), duration = finite(metrics?.avg_trial_duration_sec), ci = finite(metrics?.accuracy_ci95_half_width);
    if (!row || row.status !== "display" || !metadata || !metrics || !text(row.id) || !text(row.leaderboard_id) || !text(model?.url) || !safeLabel(model?.label) || !safeLabel(agent?.label) || !text(metadata.reasoning_effort) || !/^\d{4}-\d{2}-\d{2}$/.test(text(metadata.date) || "") || accuracy === undefined || accuracy < 0 || accuracy > 100 || nTrials === undefined || !Number.isInteger(nTrials) || nTrials <= 0 || cost === undefined || cost < 0 || tokens === undefined || tokens < 0 || duration === undefined || duration < 0 || ci === undefined || ci < 0) continue;
    validRows.push({ id: row.id, leaderboardId: row.leaderboard_id, date: metadata.date, agent: safeLabel(agent.label), model: safeLabel(model.label), modelUrl: model.url, thinking: safeLabel(metadata.reasoning_effort), accuracy, nTrials, cost, tokens, duration, ci });
  }
  if (!validRows.length) return undefined;
  return { name: safeLabel(board.name), title: safeLabel(board.title) || "Terminal-Bench", updatedAt: text(board.updated_at)?.slice(0, 10), rows: validRows };
}

/** Parse only JSON data embedded in Terminal-Bench's Next.js flight payload. */
export function parseTerminalBenchHtml(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_HTML_BYTES) return undefined;
  for (const chunk of flightChunks(html)) {
    const leaderboard = jsonAfter(chunk, '"leaderboard":');
    const rows = jsonAfter(chunk, '"rows":');
    const parsed = normalizeBenchmark(leaderboard, rows);
    if (parsed) return parsed;
  }
  return undefined;
}

function modelKey(provider, id, thinking) { return `${provider}/${id}${thinking ? `:${thinking}` : ""}`; }
function parseModel(value) {
  const match = text(value)?.match(/^([\w.-]{1,60})\/([\w./-]{1,160})(?::(off|minimal|low|medium|high|xhigh|max))?$/);
  return match ? { provider: match[1], id: match[2], thinking: match[3] } : undefined;
}
function usageOf(value) {
  const usage = object(value);
  if (!usage) return {};
  const tokens = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].reduce((sum, n) => sum + (finite(n) || 0), 0);
  return { tokens: tokens || undefined, cost: finite(usage.cost) };
}

/** Native per-child metadata only. Mixed-model totals cannot be attributed safely. */
export function localRecordFromSubagentMeta(raw, identity) {
  const meta = object(raw), model = parseModel(meta?.model);
  if (!meta || !text(meta.runId) || !model) return undefined;
  const attempts = [...(Array.isArray(meta.attemptedModels) ? meta.attemptedModels : []),
    ...(Array.isArray(meta.modelAttempts) ? meta.modelAttempts.map(attempt => attempt?.model) : [])];
  if (attempts.some(attempt => attempt !== meta.model)) return undefined;
  const usage = usageOf(meta.usage);
  const dateValue = new Date(finite(meta.timestamp) ?? NaN);
  const date = Number.isFinite(dateValue.getTime()) ? dateValue.toISOString().slice(0, 10) : undefined;
  return { identity: identity || `${meta.runId}_${safeLabel(meta.agent) || "unknown"}`, key: modelKey(model.provider, model.id, model.thinking), ...model, tokens: usage.tokens, cost: usage.cost, elapsed: finite(meta.durationMs), outcome: Number.isInteger(meta.exitCode) ? `exit-${meta.exitCode}` : "unknown", date, source: "subagent" };
}

export function aggregateLocal(records, available) {
  const allowed = new Set(available.map(model => `${model.provider}/${model.id}`));
  const groups = new Map(), identities = new Set();
  for (const record of records) {
    if (record.identity) { if (identities.has(record.identity)) continue; identities.add(record.identity); }
    if (!allowed.has(`${record.provider}/${record.id}`)) continue;
    const group = groups.get(record.key) || { ...record, n: 0, tokens: 0, tokensKnown: 0, elapsed: 0, elapsedKnown: 0, cost: 0, costKnown: 0, outcomes: new Set(), dates: new Set() };
    group.n++;
    if (finite(record.tokens) !== undefined) { group.tokens += record.tokens; group.tokensKnown++; }
    if (finite(record.elapsed) !== undefined) { group.elapsed += record.elapsed; group.elapsedKnown++; }
    if ((finite(record.cost) || 0) > 0) { group.cost += record.cost; group.costKnown++; }
    group.outcomes.add(record.outcome || "unknown");
    if (record.date) group.dates.add(record.date);
    groups.set(record.key, group);
  }
  return [...groups.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

function slug(url) { const found = text(url)?.match(/\/([^/?#]+)\/?(?:[?#].*)?$/); return found?.[1]?.toLowerCase(); }
export function benchmarkForModels(benchmark, available) {
  if (!benchmark?.rows) return [];
  const ids = new Set(available.map(model => model.id.toLowerCase()));
  return benchmark.rows.filter(row => ids.has(slug(row.modelUrl))).map(row => ({ ...row, modelId: slug(row.modelUrl) }));
}

const shortNumber = number => number >= 1_000_000 ? `${(number / 1_000_000).toFixed(1)}m` : number >= 1_000 ? `${Math.round(number / 1_000)}k` : `${Math.round(number)}`;
function localLine(group) {
  const parts = [`${group.key}: n=${group.n}`, group.tokensKnown ? `${shortNumber(group.tokens / group.tokensKnown)} tok/run` : "tokens unknown"];
  parts.push(group.elapsedKnown ? `${Math.round(group.elapsed / group.elapsedKnown / 1000)}s avg (n=${group.elapsedKnown})` : "time unknown");
  parts.push(group.costKnown ? `est. $${(group.cost / group.costKnown).toFixed(2)}/run (n=${group.costKnown})` : "price unknown");
  parts.push(`process ${[...group.outcomes].slice(0, 3).join("/")}`);
  const dates = [...group.dates].sort();
  if (dates.length) parts.push(`date ${dates[0]}${dates.length > 1 ? `–${dates.at(-1)}` : ""}`);
  return parts.join("; ");
}

/** Build compact factual context; no runtime outcome is presented as task quality. */
export function buildBriefing({ available, local = [], benchmark, stale = false }) {
  const models = available.slice(0, 12).map(model => `${model.provider}/${model.id}`).join(", ") || "none";
  const lines = ["# Model-selection briefing", "Evidence only, not routing rules. Process exit is not task quality; local tasks vary. Pi $ estimates are not subscription bills. Benchmark scores reflect model + harness + thinking, not Pi.", `Available: ${models}.`];
  const localGroups = aggregateLocal(local, available);
  lines.push(`Local Pi subagent runs (recent retained metadata; mixed-model runs omitted; ${localGroups.reduce((n, group) => n + group.n, 0)} sampled): ${localGroups.length ? localGroups.slice(0, 5).map(localLine).join(" | ") : "no matching numeric observations"}.`);
  const bench = benchmarkForModels(benchmark, available);
  if (benchmark) {
    const source = `Terminal-Bench ${benchmark.name || "unknown"} https://www.tbench.ai/${benchmark.updatedAt ? ` updated ${benchmark.updatedAt}` : ""}${stale ? " (stale cache)" : ""}`;
    lines.push(`${source} (public benchmark pricing, distinct from subscription billing): ${bench.length ? bench.slice(0, 8).map(row => `${row.modelId} ${row.thinking}; ${row.agent}; ${row.accuracy.toFixed(1)}% ±${row.ci.toFixed(1)}, n=${row.nTrials}, $${(row.cost / row.nTrials).toFixed(2)}/trial, ${Math.round(row.duration)}s/trial; ${row.date}`).join(" | ") : "no exact available-model rows"}.`);
  } else lines.push("Terminal-Bench: unknown (no valid cached/live public data).");
  return lines.join("\n").slice(0, 2800);
}

async function readLimited(path, limit) {
  const info = await stat(path);
  if (info.size > limit) return undefined;
  return readFile(path, "utf8");
}

/** Read only retained subagent metadata under Pi's default session artifact directories. */
export async function discoverLocalRuns(agentDir) {
  const sessions = join(agentDir, "sessions");
  let folders;
  try { folders = await readdir(sessions, { withFileTypes: true }); } catch { return []; }
  const files = [];
  const recentFolders = (await Promise.all(folders.filter(item => item.isDirectory()).map(async item => ({ item, info: await stat(join(sessions, item.name)).catch(() => undefined) })))).filter(entry => entry.info).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 80);
  for (const { item: folder } of recentFolders) {
    const base = join(sessions, folder.name);
    try {
      const artifacts = join(base, "subagent-artifacts");
      for (const item of await readdir(artifacts, { withFileTypes: true })) if (item.isFile() && /^[0-9a-f-]+_[\w.-]+_meta\.json$/i.test(item.name)) files.push(join(artifacts, item.name));
    } catch { /* A disappearing or unreadable session is skipped. */ }
  }
  const recent = (await Promise.all(files.map(async path => ({ path, info: await stat(path).catch(() => undefined) })))).filter(item => item.info).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, MAX_RUN_FILES);
  const records = [];
  for (const { path } of recent) try {
    const raw = await readLimited(path, 32 * 1024), record = raw && localRecordFromSubagentMeta(JSON.parse(raw), basename(path));
    if (record) records.push(record);
  } catch { /* Corrupt local artifacts are not startup failures. */ }
  return records;
}

async function readResponse(response, limit) {
  if (!response?.ok) throw new Error("Terminal-Bench request failed");
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("Terminal-Bench response too large");
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value) > limit) throw new Error("Terminal-Bench response too large");
    return value;
  }
  const reader = response.body.getReader(), parts = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new Error("Terminal-Bench response too large"); }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

function cachedBenchmark(value) {
  const benchmark = object(value);
  if (!benchmark || !Array.isArray(benchmark.rows)) return undefined;
  // Round-trip through the same validation/sanitization as public data.
  return normalizeBenchmark({ name: benchmark.name, title: benchmark.title, updated_at: benchmark.updatedAt }, benchmark.rows.map(row => ({
    id: row?.id, leaderboard_id: row?.leaderboardId, status: "display",
    metadata: { date: row?.date, reasoning_effort: row?.thinking, agent_display: { label: row?.agent }, model_display: { label: row?.model, url: row?.modelUrl } },
    metrics: { accuracy: row?.accuracy, n_trials: row?.nTrials, total_cost_usd: row?.cost, total_tokens: row?.tokens, avg_trial_duration_sec: row?.duration, accuracy_ci95_half_width: row?.ci },
  })));
}

export async function loadTerminalBench({ cachePath, fetchImpl = fetch, now = Date.now(), offline = false, timeoutMs = 4000 }) {
  let cached;
  try {
    const raw = JSON.parse(await readLimited(cachePath, MAX_HTML_BYTES));
    const benchmark = cachedBenchmark(raw.benchmark);
    cached = finite(raw.fetchedAt) !== undefined && raw.fetchedAt <= now && benchmark ? { fetchedAt: raw.fetchedAt, benchmark } : undefined;
  } catch { /* Missing or corrupt cache is a normal cold start. */ }
  if (cached && now - cached.fetchedAt < DAY_MS) return { benchmark: cached.benchmark, stale: false, source: "cache" };
  if (offline) return cached ? { benchmark: cached.benchmark, stale: true, source: "cache" } : { benchmark: undefined, stale: false, source: "offline" };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  try {
    const html = await readResponse(await fetchImpl("https://www.tbench.ai/", { signal: controller.signal, headers: { accept: "text/html" } }), MAX_HTML_BYTES);
    const benchmark = parseTerminalBenchHtml(html);
    if (!benchmark) throw new Error("Terminal-Bench schema changed");
    await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(cachePath), 0o700).catch(() => {});
    await writeFile(temporary, JSON.stringify({ fetchedAt: now, benchmark }), { mode: 0o600 });
    await rename(temporary, cachePath); await chmod(cachePath, 0o600).catch(() => {});
    return { benchmark, stale: false, source: "live" };
  } catch {
    return cached ? { benchmark: cached.benchmark, stale: true, source: "cache" } : { benchmark: undefined, stale: false, source: "unavailable" };
  } finally { clearTimeout(timer); await rm(temporary, { force: true }).catch(() => {}); }
}

/** Register the small startup hook separately so its contract is testable without Pi internals. */
export function registerModelBriefing(pi, getAgentDirectory) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!event.systemPromptOptions?.selectedTools?.includes("subagent")) return;
    if (ctx.sessionManager.buildContextEntries().some(entry =>
      (entry.type === "custom_message" && entry.customType === "model-briefing") ||
      entry.retainedTail?.some(message => message.role === "custom" && message.customType === "model-briefing"))) return;
    const available = ctx.modelRegistry.getAvailable();
    if (!available.length) return;
    const agentDir = getAgentDirectory();
    const [local, terminalBench] = await Promise.all([
      discoverLocalRuns(agentDir),
      loadTerminalBench({ cachePath: join(agentDir, "model-briefing", "terminal-bench.json"), offline: /^(1|true)$/i.test(process.env.PI_OFFLINE || "") }),
    ]);
    return { message: { customType: "model-briefing", content: buildBriefing({ available, local, benchmark: terminalBench.benchmark, stale: terminalBench.stale }), display: false } };
  });
}
