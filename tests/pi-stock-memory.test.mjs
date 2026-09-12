import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const core = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const stock = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "npm/node_modules/pi-memory");

for (const exercise of [false, true]) test(`stock pi-memory ${exercise ? "file tools round-trip" : "package discovery"} in installed Pi`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-stock-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "result.json"), probe = join(root, "probe.ts");
  await mkdir(agent); await mkdir(cwd);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages: exercise ? [] : [stock] }));
  const manifest = JSON.parse(await readFile(join(stock, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-memory");
  // Test-only capture of upstream definitions; production uses package discovery without a wrapper.
  await writeFile(probe, `import {writeFileSync} from 'node:fs';
    ${exercise ? `import memory from ${JSON.stringify(join(stock, "index.ts"))};` : ""}
    export default function(pi) {
      const tools = new Map();
      ${exercise ? "memory({...pi, registerTool: definition => { tools.set(definition.name, definition); pi.registerTool(definition); }});" : ""}
      pi.registerCommand('stock-probe', {handler: async (_args, ctx) => {
        const names = pi.getAllTools().map(t => t.name);
        ${exercise ? `
        const call = (name, args) => tools.get(name).execute('fixture', args, undefined, undefined, ctx);
        const initial = await call('memory_status', {});
        await call('memory_write', {target:'long_term', content:'Synthetic stock-memory fixture.'});
        const read = await call('memory_read', {target:'long_term'});
        const forgotten = await call('memory_forget', {match:'Synthetic stock-memory fixture.'});
        const restored = await call('memory_restore', {recoveryId:forgotten.details.recoveryId});
        await call('scratchpad', {action:'add', text:'Synthetic task'});
        await call('memory_write', {target:'daily', content:'Synthetic daily entry.'});
        const status = await call('memory_status', {});
        writeFileSync(${JSON.stringify(output)}, JSON.stringify({names, initial, read, forgotten, restored, status}));
        ` : `writeFileSync(${JSON.stringify(output)}, JSON.stringify({names}));`}
      }});
    }`);
  const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_MEMORY_DIR: join(root, "memory"), PI_MEMORY_EXIT_SUMMARY: "0", PI_MEMORY_QMD_UPDATE: "off" };
  const pending = exec(process.execPath, [join(core, "dist/cli.js"), "--offline", "--no-session", "--no-context-files", "--approve", "-e", probe, "-p", "/stock-probe"], { cwd, env, timeout: 25000 });
  pending.child.stdin.end();
  const { stdout, stderr } = await pending;
  assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module|duplicate/i);
  const result = JSON.parse(await readFile(output, "utf8"));
  for (const name of ["memory_write", "memory_read", "memory_forget", "memory_restore", "memory_search", "memory_status", "scratchpad"]) assert.ok(result.names.includes(name), name);
  assert.ok(!result.names.includes("memory"));
  if (exercise) {
    assert.equal(result.initial.details.longTermChars, 0);
    assert.match(result.read.content[0].text, /Synthetic stock-memory fixture/);
    assert.equal(result.forgotten.details.removed, 1);
    assert.equal(result.restored.details.restored, 1);
    assert.equal(result.status.details.scratchpadOpen, 1);
    assert.equal(result.status.details.dailyCount, 1);
    assert.equal(result.status.details.dir, join(root, "memory"));
    assert.match(await readFile(join(root, "memory/MEMORY.md"), "utf8"), /Synthetic stock-memory fixture/);
  }
});
