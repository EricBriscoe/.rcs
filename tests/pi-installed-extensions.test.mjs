import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exec = promisify(execFile);
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const names = ["ask-user", "code-navigation", "efficiency", "memory", "monitor", "project-context", "web"];

test("migrated installer links load sibling imports in both Pi CLI distributions", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi installed extensions "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent"), cwd = join(root, "project");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(cwd);
  for (const name of names) await symlink(join(checkout, "pi/extensions", name), join(agent, "extensions", `rcs-${name}`));
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
  await exec("/bin/bash", [join(checkout, "setup-pi.sh"), "--skip-install"], { cwd, env });
  // This checks owned links, separately from the installed upstream package test.
  const settings = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
  settings.packages = [];
  await rm(join(agent, "settings.json"));
  await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
  const output = join(root, "loaded.json"), probe = join(root, "probe.ts");
  await writeFile(probe, `import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.registerCommand('installed-probe', { handler: async () => {
    writeFileSync(${JSON.stringify(output)}, JSON.stringify({ tools: pi.getAllTools().map(t => t.name), commands: pi.getCommands() }));
  } });
}`);
  // Exercise standard discovery through installed links, not canonical source paths.
  for (const cli of ["dist/cli.js", "dist/bundle/cli.js"]) {
    await t.test(cli, async () => {
      const pending = exec(process.execPath, [join(packageDir, cli), "--offline", "--no-session", "-nc", "-ns", "-np", "--no-approve", "-e", probe, "-p", "/installed-probe"], { cwd, env, timeout: 25000 });
      pending.child.stdin.end();
      const { stdout, stderr } = await pending;
      assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module|duplicate/i);
      const loaded = JSON.parse(await readFile(output, "utf8"));
      for (const tool of ["ask_user", "code_nav", "code_search", "memory", "monitor", "web_search", "web_browse"]) assert.ok(loaded.tools.includes(tool), tool);
      const commands = loaded.commands.filter(c => c.source === "extension");
      assert.ok(!commands.some(c => c.name === "orchestrate"));
      assert.ok(commands.some(c => c.name === "code-nav"));
      assert.ok(!commands.some(c => /:\d+$/.test(c.name)), "no duplicate registrations after migration");
      for (const name of ["code-nav", "tokens", "output"]) assert.ok(commands.find(c => c.name === name).sourceInfo.path.startsWith(join(agent, "extensions")), "loaded through installed links");
      await rm(output);
    });
  }
});
