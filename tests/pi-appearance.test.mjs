import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { stripVTControlCharacters as plain } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const host = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const require = createRequire(join(host, "package.json"));
const { visibleWidth } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")));
const { loadThemeFromPath, setThemeJsonValidator } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme.js")));
const { validateThemeJson } = await import(pathToFileURL(join(host, "dist/modes/interactive/theme/theme-json.js")));
const { clearExtensionCache, loadExtensionsCached } = await import(pathToFileURL(join(host, "dist/core/extensions/loader.js")));
const { WorkingStatusIndicator } = await import(pathToFileURL(join(host, "dist/modes/interactive/components/status-indicator.js")));
const { InteractiveMode } = await import(pathToFileURL(join(host, "dist/modes/interactive/interactive-mode.js")));
setThemeJsonValidator(validateThemeJson);
const themePath = name => join(checkout, "pi/themes", `${name}.json`);
const graphite = loadThemeFromPath(themePath("quiet-graphite"), "truecolor");
const paper = loadThemeFromPath(themePath("paper"), "truecolor");

async function fixture(t, mode = "tui", vim = false) {
  clearExtensionCache();
  const paths = [join(checkout, "pi/extensions/appearance/index.ts")];
  if (vim) paths[vim === "late" ? "push" : "unshift"](join(homedir(), ".pi/agent/npm/node_modules/pi-vim/index.ts"));
  const loaded = await loadExtensionsCached(paths, checkout);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(extension => extension.commands.has("appearance"));
  let footer, indicator, editorFactory, editor, renders = 0, unsubscriptions = 0;
  const tui = { requestRender() { renders++; }, terminal: { rows: 30, columns: 100 } };
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
    getEditorComponent: () => editorFactory,
    setEditorComponent(factory) {
      editorFactory = factory;
      editor = factory?.(tui, { borderColor: text => ui.theme.fg("border", text) }, {
        matches: (data, key) => data === "\x1b" && key === "app.interrupt",
      });
    },
    notify: (...args) => notices.push(args),
  };
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/fixture/.rcs", ui,
    model: { id: "gpt-6-astra", provider: "openai-codex" }, thinkingLevel: "high",
    getContextUsage: () => ({ percent: 28, tokens: 116588, contextWindow: 416384 }),
  };
  async function emit(type, context = ctx) {
    for (const loadedExtension of loaded.extensions) {
      for (const handler of loadedExtension.handlers.get(type) ?? []) await handler({ type }, context);
    }
  }
  await emit("session_start");
  t.after(async () => { await emit("session_shutdown"); loaded.runtime.invalidate(); clearExtensionCache(); });
  return {
    ctx, ui, statuses, notices, emit,
    render: width => footer.render(width),
    footer: () => footer, indicator: () => indicator, editor: () => editor,
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
  assert.deepEqual(f.indicator(), { frames: ["●", "●"], intervalMs: 80 });
  assert.equal(f.editor().embedWorkingStatus, true);
  fits(lines, 100);
});

test("border glint follows the native loader clock and clears on stop, preserving input and scroll labels", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const editor = f.editor();
  editor.setText("Draft input 研究");
  editor.focused = true;
  const idle = editor.render(80);
  let redraws = 0;
  const indicator = new WorkingStatusIndicator({ requestRender() { redraws++; } }, "Working", f.indicator(), text => text);
  t.after(() => indicator.dispose());
  editor.setWorkingStatusIndicator(indicator);
  assert.equal(plain(editor.render(80)[0]).indexOf("●"), 0);
  const before = redraws;
  t.mock.timers.tick(1600);
  assert.ok(redraws > before, "native loader drives redraws");
  assert.equal(plain(editor.render(80)[0]).indexOf("●"), 40);
  assert.deepEqual(editor.render(80).slice(1), idle.slice(1), "input and cursor are unchanged");
  const dark = editor.render(80)[0];
  f.ui.theme = paper;
  editor.invalidate();
  assert.notEqual(editor.render(80)[0], dark);
  assert.equal(plain(editor.render(80)[0]), plain(dark));
  for (const width of [1, 2, 5, 20, 80, 160]) {
    for (const hidden of [0, 12]) {
      const line = editor.renderTopBorder(width, hidden);
      fits([line], width);
      if (hidden && width >= 20) assert.match(plain(line), /↑ 12 more/);
    }
  }
  t.mock.timers.tick(1600);
  assert.equal(plain(editor.render(80)[0]).indexOf("●"), 79);
  t.mock.timers.tick(1600);
  assert.equal(plain(editor.render(80)[0]).indexOf("●"), 40);
  indicator.dispose();
  editor.setWorkingStatusIndicator(undefined);
  assert.doesNotMatch(plain(editor.render(80)[0]), /●|Working/);
  const stopped = redraws;
  t.mock.timers.tick(800);
  assert.equal(redraws, stopped, "no extension-owned timer survives native stop");
  let aborted = false;
  editor.onEscape = () => { aborted = true; };
  editor.handleInput("\x1b");
  assert.equal(aborted, true, "stock Escape handling remains intact");
  assert.equal(editor.getText(), "Draft input 研究");
});

for (const order of [true, "late"]) test(`installed pi-vim keeps modal editing with native working-status routing (order=${order})`, async t => {
  const f = await fixture(t, "tui", order);
  await f.emit("agent_start");
  const editor = f.editor();
  assert.equal(editor.embedWorkingStatus, true);
  assert.match(plain(editor.render(80).at(-1)), /INSERT/);
  const indicator = new WorkingStatusIndicator({ requestRender() {} }, "Working", f.indicator(), text => text);
  t.after(() => indicator.dispose());
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    editor, defaultEditor: { setWorkingStatusIndicator() {} },
    statusContainer: { children: [], clear() { this.children = []; }, addChild(child) { this.children.push(child); } },
  });
  mode.showStatusIndicator(indicator);
  assert.equal(mode.activeWorkingIndicatorEmbedded, true);
  assert.deepEqual(mode.statusContainer.children, [], "no separate Working spinner remains");
  assert.match(plain(editor.render(80)[0]), /●/);
  assert.doesNotMatch(plain(editor.render(80)[0]), /Working/);
  editor.handleInput("\x1b");
  assert.match(plain(editor.render(80).at(-1)), /NORMAL/);
  editor.handleInput("i");
  editor.handleInput("hello");
  assert.equal(editor.getText(), "hello");
  mode.clearStatusIndicator("working");
  assert.doesNotMatch(plain(editor.render(80)[0]), /●/);
  await f.command("stock");
  assert.match(plain(f.editor().render(80).at(-1)), /INSERT/);
  assert.equal(f.editor().embedWorkingStatus, false);
});

test("compact mode does not replace another extension's editor or clear it on shutdown", async t => {
  const f = await fixture(t);
  await f.command("stock");
  const otherFactory = () => ({ render: () => ["other editor"], invalidate() {} });
  f.ui.setEditorComponent(otherFactory);
  await f.command("compact");
  assert.deepEqual(f.editor().render(80), ["other editor"]);
  assert.deepEqual(f.indicator(), { frames: ["·", "•", "●", "•"], intervalMs: 300 });
  await f.emit("session_shutdown");
  assert.equal(f.ui.getEditorComponent(), otherFactory);
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
  assert.equal(f.editor(), undefined);
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
