import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { nativeArgs } from "../pi/native-resources.mjs";
import { projectInstructions } from "../pi/extensions/project-context/context.ts";

const packageDir = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));

test("native launcher disables inherited resources and honors explicit resource overrides", () => {
  const args = nativeArgs(["-p", "hello"], checkout);
  for (const flag of ["--no-context-files", "--no-skills", "--no-extensions", "--no-prompt-templates"]) assert.ok(args.includes(flag));
  assert.ok(args.includes(join(checkout, "pi/AGENTS.md")));
  assert.ok(args.includes(join(checkout, "pi/extensions/orchestrate/index.ts")));
  assert.ok(!args.some(arg => /\.agents\/skills|\.codex|\.claude|skills\/schlep/.test(arg)));
  assert.deepEqual(nativeArgs(["update", "self"], checkout), ["update", "self"]);
  const disabled = nativeArgs(["-nc", "-ns", "-ne", "-np", "-e", "/explicit.ts"], checkout);
  assert.ok(!disabled.includes("--append-system-prompt"));
  assert.ok(!disabled.includes("--extension"));
  assert.equal(disabled.at(-1), "/explicit.ts");
  assert.ok(!nativeArgs(["-nc"], checkout).includes(join(checkout, "pi/extensions/project-context/index.ts")));
});

test("only a real .pi/AGENTS.md in the current workspace becomes project context", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi project context "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "AGENTS.md"), "FOREIGN_AGENT");
  await writeFile(join(root, "CLAUDE.md"), "FOREIGN_CLAUDE");
  assert.equal(await projectInstructions(root), "");
  await mkdir(join(root, ".pi"));
  const path = join(root, ".pi/AGENTS.md");
  await writeFile(path, "NATIVE_PROJECT");
  assert.equal(await projectInstructions(root), "NATIVE_PROJECT");
  await rm(path); await symlink(join(root, "CLAUDE.md"), path);
  assert.equal(await projectInstructions(root), "");
});

test("actual native CLI receives Pi instructions/skills but no ancestor or shared-harness context", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi native cli "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "checkout");
  const agent = join(root, "agent");
  const project = join(root, "project");
  const output = join(root, "effective.json");
  for (const path of [join(source, "pi/extensions"), join(source, "pi/skills/native"), agent, project, join(root, ".agents/skills/foreign")]) await mkdir(path, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "FOREIGN_ANCESTOR_MARKER");
  await writeFile(join(project, "CLAUDE.md"), "FOREIGN_CLAUDE_MARKER");
  await writeFile(join(root, ".agents/skills/foreign/SKILL.md"), "---\nname: foreign\ndescription: FOREIGN_SHARED_SKILL\n---\nFOREIGN_SHARED_SKILL\n");
  await writeFile(join(source, "pi/AGENTS.md"), "NATIVE_PI_MARKER");
  await writeFile(join(source, "pi/skills/native/SKILL.md"), "---\nname: native\ndescription: NATIVE_SKILL_MARKER\n---\nNative skill\n");
  const probe = join(root, "probe.ts");
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi) {pi.registerCommand('resource-probe',{description:'fixture',handler:async(_args,ctx)=>{const o=ctx.getSystemPromptOptions(); writeFileSync(${JSON.stringify(output)},JSON.stringify({prompt:ctx.getSystemPrompt(),files:o.contextFiles,skills:o.skills?.map(s=>s.name)}));}});}`);
  const pending = promisify(execFile)(process.execPath, [join(packageDir, "dist/cli.js"), ...nativeArgs(["--offline", "--no-session", "--approve", "-e", probe, "-p", "/resource-probe"], source)], { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, timeout: 25000 });
  pending.child.stdin.end();
  await pending;
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.match(result.prompt, /NATIVE_PI_MARKER/);
  assert.match(result.prompt, /NATIVE_SKILL_MARKER/);
  assert.doesNotMatch(result.prompt, /FOREIGN_|Users\/eric\/AGENTS|\.agents\/skills/);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.skills, ["native"]);
});
