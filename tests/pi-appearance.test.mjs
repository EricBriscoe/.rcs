import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { stripVTControlCharacters as plain } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { memoryStatus } from "../pi/extensions/memory/status.ts";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const host = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const require = createRequire(join(host, "package.json"));
const { visibleWidth } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const { loadThemeFromPath, setThemeJsonValidator } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")));
const { validateThemeJson } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme-json.js")));
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")));
setThemeJsonValidator(validateThemeJson);
const themePath = name => join(checkout, "pi/themes", `${name}.json`);
const graphite = loadThemeFromPath(themePath("quiet-graphite"), "truecolor");
const paper = loadThemeFromPath(themePath("paper"), "truecolor");

async function fixture(t, mode = "tui") {
  clearExtensionCache();
  const loaded = await loadExtensionsCached([join(checkout, "pi/extensions/appearance/index.ts")], checkout);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  let footer, indicator, renders = 0, unsubscriptions = 0;
  const branchListeners = new Set();
  const statuses = new Map();
  const notices = [];
  let branch = "main";
  const ui = {
    theme: graphite,
    setFooter(factory) {
      footer?.dispose();
      footer = factory?.({ requestRender() { renders++; } }, ui.theme, {
        getGitBranch: () => branch,
        getExtensionStatuses: () => statuses,
        onBranchChange(listener) {
          branchListeners.add(listener);
          return () => { branchListeners.delete(listener); unsubscriptions++; };
        },
      });
    },
    setWorkingIndicator(value) { indicator = value; },
    notify: (...args) => notices.push(args),
  };
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/fixture/.rcs", ui,
    model: { id: "gpt-6-astra", provider: "openai-codex" }, thinkingLevel: "high",
    getContextUsage: () => ({ percent: 28, tokens: 116588, contextWindow: 416384 }),
  };
  async function emit(type, context = ctx) {
    for (const handler of extension.handlers.get(type) ?? []) await handler({ type }, context);
  }
  await emit("session_start");
  t.after(async () => { await emit("session_shutdown"); loaded.runtime.invalidate(); clearExtensionCache(); });
  return {
    ctx, ui, statuses, notices, emit,
    render: width => footer.render(width),
    footer: () => footer, indicator: () => indicator,
    renders: () => renders, listeners: () => branchListeners.size, unsubscriptions: () => unsubscriptions,
    branch(value) { branch = value; for (const listener of branchListeners) listener(); },
    command: args => extension.commands.get("appearance").handler(args, ctx),
  };
}

function fits(lines, width) {
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${plain(line)}`);
    assert.doesNotMatch(plain(line), /[\r\n\t]/);
  }
}

test("both complete palettes validate in installed Pi and keep healthy tools neutral", async () => {
  for (const name of ["quiet-graphite", "paper"]) {
    const json = JSON.parse(await readFile(themePath(name), "utf8"));
    validateThemeJson(name, json);
    assert.equal(json.name, name);
    for (const mode of ["truecolor", "256color"]) {
      const theme = loadThemeFromPath(themePath(name), mode);
      for (const token of Object.keys(json.colors)) {
        const backgrounds = ["selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
        assert.equal(plain(theme[backgrounds.includes(token) ? "bg" : "fg"](token, "fixture")), "fixture");
      }
    }
    assert.equal(json.colors.toolPendingBg, json.colors.toolSuccessBg);
    assert.notEqual(json.colors.toolSuccessBg, json.colors.toolErrorBg);
  }
});

test("compact idle footer uses real context, honest unknown quota and no extra row", async t => {
  const f = await fixture(t);
  const lines = f.render(100);
  assert.equal(lines.length, 1);
  assert.match(plain(lines[0]), /\.rcs · main\s+gpt-6-astra · high · ctx 28% · quota unknown/);
  assert.deepEqual(f.indicator(), { frames: ["·", "•", "●", "•"], intervalMs: 300 });
  fits(lines, 100);
});

test("quota freshness, exhaustion and all opaque extension statuses survive narrow layouts", async t => {
  const f = await fixture(t);
  f.statuses.set("codex-pool", "Codex pool: personal 12% left · reset tomorrow · stale");
  f.statuses.set("subagent", graphite.fg("warning", "2 agents running · 1 needs input"));
  f.statuses.set("future-extension", "Approval required: inspect deployment before continuing");
  for (const width of [20, 40, 60, 80, 120, 180]) {
    const lines = f.render(width);
    fits(lines, width);
    const text = plain(lines.join("")).replace(/\s+/g, "");
    for (const status of f.statuses.values()) assert.ok(text.includes(plain(status).replace(/\s+/g, "")), status);
    assert.ok(lines.join("").includes(graphite.getFgAnsi("warning")), "keeps subagent warning styling");
  }
  f.statuses.set("codex-pool", "Codex pool: all accounts exhausted; quota reset unknown");
  assert.match(plain(f.render(60).join(" ")), /exhausted/);
  assert.equal(f.statuses.size, 3, "does not mutate provider status map");
});

test("Unicode, long branches and tiny terminal widths stay bounded", async t => {
  const f = await fixture(t);
  f.ctx.cwd = "/fixture/研究👩‍💻";
  f.branch("feature/" + "長い名前".repeat(20));
  f.statuses.set("extension", "進行中 👩‍💻\tneeds attention\nsecond line");
  for (const width of [0, 1, 2, 5, 12, 24, 50, 100]) fits(f.render(width), width);
  f.ctx.cwd = "/fixture/unsafe\x1b[2J\nname";
  assert.doesNotMatch(f.render(100).join(""), /\x1b\[2J|\n/);
});

test("theme, branch, model, thinking and compaction refresh without cached colors or subscriptions", async t => {
  const f = await fixture(t);
  const before = f.render(100).join("");
  f.ui.theme = paper;
  f.footer().invalidate();
  const after = f.render(100).join("");
  assert.notEqual(before, after);
  assert.equal(plain(before), plain(after));
  assert.ok(after.includes(paper.getFgAnsi("muted")));
  const next = { ...f.ctx, model: { id: "other-model", provider: "other" }, thinkingLevel: "low", getContextUsage: () => ({ percent: null }) };
  await f.emit("model_select", next);
  f.branch("review");
  let text = plain(f.render(100).join(" "));
  assert.match(text, /review.*other-model · low · ctx \?/);
  assert.doesNotMatch(text, /quota unknown|gpt-6-astra/);
  for (const [percent, color] of [[85, "warning"], [96, "error"]]) {
    await f.emit("session_compact", { ...next, getContextUsage: () => ({ percent }) });
    assert.ok(f.render(100).join("").includes(paper.getFgAnsi(color)));
  }
  assert.ok(f.renders() >= 4);
  assert.equal(f.listeners(), 1);
});

test("stock toggle and shutdown dispose safely; typo leaves current view unchanged", async t => {
  const f = await fixture(t);
  const previous = f.footer();
  await f.command("typo");
  assert.equal(f.footer(), previous);
  assert.equal(f.notices.length, 1);
  await f.command("stock");
  assert.equal(f.footer(), undefined);
  assert.equal(f.indicator(), undefined);
  assert.equal(f.listeners(), 0);
  assert.deepEqual(previous.render(100), []);
  await f.command("compact");
  assert.equal(f.listeners(), 1);
  await f.emit("session_shutdown");
  await f.emit("session_shutdown");
  assert.equal(f.listeners(), 0);
  assert.equal(f.unsubscriptions(), 2);
});

for (const mode of ["rpc", "json", "print"]) test(`appearance is inert in ${mode} mode`, async t => {
  const f = await fixture(t, mode);
  await f.command("compact");
  await f.emit("model_select");
  assert.equal(f.footer(), undefined);
  assert.equal(f.indicator(), undefined);
  assert.equal(f.listeners(), 0);
  assert.deepEqual(f.notices, []);
});

test("memory is quiet at rest but preserves disabled, failed, deferred and learning states", () => {
  const stats = { reading: true, learning: true, jobs: [] };
  assert.equal(memoryStatus(stats), undefined);
  assert.match(memoryStatus({ ...stats, reading: false }), /recall off/);
  assert.match(memoryStatus({ ...stats, learning: false }), /learning off/);
  assert.match(memoryStatus(stats, undefined, true), /deferred.*\/memory/);
  const queued = { ...stats, jobs: [{ state: "pending", count: 3 }] };
  assert.equal(memoryStatus(queued), undefined);
  assert.equal(memoryStatus(queued, { allowed: false, mode: "fallback", reason: "working" }), undefined);
  assert.match(memoryStatus(queued, { allowed: false, mode: "quota", reason: "quota exhausted" }), /paused: quota exhausted.*\/memory/);
  assert.match(memoryStatus(queued, { allowed: true, mode: "fallback" }), /learning \(fallback\)/);
  assert.match(memoryStatus({ ...stats, jobs: [{ state: "failed", count: 1 }] }), /failed.*\/memory retry/);
});
