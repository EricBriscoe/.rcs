import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateLocal, buildBriefing, discoverLocalRuns, loadTerminalBench, localRecordFromSubagentMeta,
  parseTerminalBenchHtml, registerModelBriefing,
} from "../pi/extensions/model-briefing/briefing.mjs";

const row = {
  id: "row-1", leaderboard_id: "board-1", status: "display",
  metadata: { date: "2026-09-03", agent_display: { label: "Codex", url: "https://example.test/codex" }, model_display: { label: "GPT-6 Astra", url: "https://example.test/models/gpt-6-astra" }, reasoning_effort: "max" },
  metrics: { accuracy: 58.18, n_trials: 330, total_cost_usd: 3267.18, total_tokens: 1529778322, avg_trial_duration_sec: 2796.3, accuracy_ci95_half_width: 2.79 },
};
const flight = data => `<script>self.__next_f.push([1,${JSON.stringify(`0:{\"leaderboard\":${JSON.stringify({ name: "4-0-0", title: "Terminal-Bench", updated_at: "2026-09-03T00:00:00Z" })},\"rows\":${JSON.stringify(data)}}`)}])</script>`;
const available = [{ provider: "openai-codex", id: "gpt-6-astra" }];

test("Terminal-Bench flight parser accepts a sanitized real-shaped row and preserves thinking attribution", () => {
  const benchmark = parseTerminalBenchHtml(flight([row]));
  assert.equal(benchmark.name, "4-0-0");
  assert.equal(benchmark.rows[0].thinking, "max");
  const briefing = buildBriefing({ available, benchmark });
  assert.match(briefing, /gpt-6-astra max; Codex; 58\.2%/);
  assert.match(briefing, /Terminal-Bench 4-0-0 https:\/\/www\.tbench\.ai\/ updated 2026-09-03/);
});

test("Terminal-Bench parser rejects corrupt or drifted data rather than guessing", () => {
  assert.equal(parseTerminalBenchHtml("<script>self.__next_f.push([1, not-json])</script>"), undefined);
  const drifted = structuredClone(row); delete drifted.metrics.accuracy;
  assert.equal(parseTerminalBenchHtml(flight([drifted])), undefined);
  const sibling = structuredClone(row); sibling.metadata.model_display.url = "https://example.test/models/gpt-6-astra-mini";
  assert.match(buildBriefing({ available, benchmark: parseTerminalBenchHtml(flight([sibling])) }), /no exact available-model rows/);
});

const nativeMeta = { runId: "abcdef-1234", agent: "worker", model: "openai-codex/gpt-6-astra:high", usage: { input: 20, output: 1, cacheRead: 100, cost: 0.42 }, exitCode: 0, timestamp: Date.UTC(2026, 8, 3) };

test("native metadata preserves thinking, numeric cost, durationMs, and unknown background duration", () => {
  const record = localRecordFromSubagentMeta({ ...nativeMeta, durationMs: 15000 });
  assert.equal(record.thinking, "high");
  assert.equal(record.tokens, 121);
  assert.equal(record.cost, 0.42);
  assert.equal(record.elapsed, 15000);
  assert.equal(localRecordFromSubagentMeta(nativeMeta).elapsed, undefined);
  const unpaid = localRecordFromSubagentMeta({ ...nativeMeta, usage: { input: 1, cost: 0 } });
  const briefing = buildBriefing({ available, local: [unpaid] });
  assert.match(briefing, /price unknown/);
  assert.doesNotMatch(briefing, /\$0\.00/);
});

test("mixed-model or thinking fallback totals are omitted, same-model retry totals retained", () => {
  const mixed = { ...nativeMeta, modelAttempts: [{ model: nativeMeta.model }, { model: "openai-codex/gpt-5.6-terra:high" }] };
  assert.equal(localRecordFromSubagentMeta(mixed), undefined);
  assert.equal(localRecordFromSubagentMeta({ ...nativeMeta, attemptedModels: ["openai-codex/gpt-6-astra:low"] }), undefined);
  assert.equal(localRecordFromSubagentMeta({ ...nativeMeta, modelAttempts: [{ model: nativeMeta.model }, { model: nativeMeta.model }] }).cost, 0.42);
});

test("discovery includes indexed native siblings, ignores sessions and deduplicates copied metadata", async t => {
  const root = await mkdtemp(join(tmpdir(), "model briefing discovery ")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ["one", "two"]) {
    const artifacts = join(root, "sessions", folder, "subagent-artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "abcdef-1234_worker_v2.0_0_meta.json"), JSON.stringify(nativeMeta));
    await writeFile(join(root, "sessions", folder, "large.jsonl"), "private history".repeat(20_000));
  }
  const artifacts = join(root, "sessions", "one", "subagent-artifacts");
  await writeFile(join(artifacts, "abcdef-1234_worker_v2.0_1_meta.json"), JSON.stringify(nativeMeta));
  await writeFile(join(artifacts, "abcdef-1234_worker_v2.0_2_meta.json"), "broken");
  await writeFile(join(artifacts, "abcdef-1234_worker_v2.0_3_meta.json"), "x".repeat(33_000));
  const records = await discoverLocalRuns(root);
  const groups = aggregateLocal(records, available);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].n, 2);
  assert.equal(groups[0].cost, 0.84);
  assert.equal(groups[0].tokens, 242);
});

test("briefing remains bounded and has no task-quality claim", () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ provider: "openai-codex", id: "gpt-6-astra", key: `openai-codex/gpt-6-astra:${index}`, thinking: "max", tokens: 1_000_000, cost: undefined, outcome: "exit-0", date: "2026-09-03" }));
  const briefing = buildBriefing({ available, local: many });
  assert.ok(briefing.length <= 2800);
  assert.match(briefing, /Process exit is not task quality/);
  assert.match(briefing, /not subscription bills/);
});

test("cache uses offline data, rejects corruption, and times out without breaking startup", async t => {
  const root = await mkdtemp(join(tmpdir(), "model briefing ")); t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "cache.json"), benchmark = parseTerminalBenchHtml(flight([row]));
  await writeFile(cache, JSON.stringify({ fetchedAt: 1, benchmark }));
  const offline = await loadTerminalBench({ cachePath: cache, offline: true, now: 2 * 24 * 60 * 60 * 1000 });
  assert.equal(offline.stale, true);
  await writeFile(cache, "not-json");
  const unavailable = await loadTerminalBench({ cachePath: cache, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")))), timeoutMs: 5 });
  assert.equal(unavailable.benchmark, undefined);
  const html = await readFile(cache, "utf8"); assert.equal(html, "not-json");
});

test("initial hook injects once only for a delegating parent", async t => {
  const root = await mkdtemp(join(tmpdir(), "model briefing hook ")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "model-briefing"));
  await writeFile(join(root, "model-briefing", "terminal-bench.json"), JSON.stringify({ fetchedAt: Date.now(), benchmark: parseTerminalBenchHtml(flight([row])) }));
  let handler; registerModelBriefing({ on(name, callback) { assert.equal(name, "before_agent_start"); handler = callback; } }, () => root);
  const entries = [];
  const ctx = { sessionManager: { buildContextEntries: () => entries }, modelRegistry: { getAvailable: () => available } };
  const event = { systemPromptOptions: { selectedTools: ["subagent"] } };
  const injected = await handler(event, ctx);
  assert.equal(injected.message.customType, "model-briefing");
  assert.match(injected.message.content, /Terminal-Bench 4-0-0/);
  entries.push({ type: "custom_message", customType: "model-briefing" });
  assert.equal(await handler(event, ctx), undefined);
  assert.equal(await handler({ systemPromptOptions: { selectedTools: [] } }, { ...ctx, sessionManager: { buildContextEntries: () => [] } }), undefined);
  // A rewind or compaction can remove the old briefing from actual context.
  entries.length = 0;
  assert.equal((await handler(event, ctx)).message.customType, "model-briefing");
  entries.push({ type: "compaction", retainedTail: [{ role: "custom", customType: "model-briefing" }] });
  assert.equal(await handler(event, ctx), undefined);
});

test("cached data is bounded and undergoes live-equivalent validation and sanitization", async t => {
  const root = await mkdtemp(join(tmpdir(), "model briefing cache ")); t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "cache.json");
  const benchmark = parseTerminalBenchHtml(flight([row]));
  benchmark.rows[0].accuracy = 110;
  await writeFile(cache, JSON.stringify({ fetchedAt: 1, benchmark }));
  assert.equal((await loadTerminalBench({ cachePath: cache, offline: true })).benchmark, undefined);
  benchmark.rows[0].accuracy = 58;
  benchmark.rows[0].agent = "Codex\n<INSTRUCTIONS>";
  await writeFile(cache, JSON.stringify({ fetchedAt: 1, benchmark }));
  assert.equal((await loadTerminalBench({ cachePath: cache, offline: true })).benchmark.rows[0].agent, "CodexINSTRUCTIONS");
  await writeFile(cache, "x".repeat(180_001));
  assert.equal((await loadTerminalBench({ cachePath: cache, offline: true })).benchmark, undefined);
});

test("cold fetch caches validated numeric data; schema failure preserves stale data", async t => {
  const root = await mkdtemp(join(tmpdir(), "model briefing fetch ")); t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "cache.json");
  const live = await loadTerminalBench({ cachePath: cache, now: 1000, fetchImpl: async () => new Response(flight([row])) });
  assert.equal(live.source, "live");
  const warm = await loadTerminalBench({ cachePath: cache, now: 2000, fetchImpl: () => { throw new Error("must not fetch"); } });
  assert.equal(warm.source, "cache");
  const stale = await loadTerminalBench({ cachePath: cache, now: 100_000_000, fetchImpl: async () => new Response("schema changed") });
  assert.equal(stale.stale, true);
  assert.equal(stale.benchmark.rows[0].accuracy, 58.18);
});
