import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const checkout = new URL('../', import.meta.url);
const settings = JSON.parse(await readFile(new URL('pi/settings.json', checkout), 'utf8'));
const host = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
const npmRoot = join(agentDir, 'npm');
const installed = join(npmRoot, 'node_modules/pi-subagents');

test('replacement uses a pinned upstream package with dynamic model selection, not role pins or a model allowlist', async () => {
  assert.ok(settings.packages.includes('npm:pi-subagents@0.66.0'));
  assert.equal(settings.subagents, undefined);
  assert.equal(settings.enabledModels, undefined);
  for (const path of ['pi/extensions/orchestrate', 'pi/orchestrator.json']) assert.equal(existsSync(new URL(path, checkout)), false);
  const rules = await readFile(new URL('pi/AGENTS.md', checkout), 'utf8');
  assert.doesNotMatch(rules, /orchestrate|no recursion|native Pi workers only|no routine.*agents|Do not inherit ancestor/);
  assert.match(rules, /full authenticated OpenAI catalog/);
  assert.match(rules, /Prefer newer generations/);
});

test('installed pi-subagents loads via standard package discovery in both Pi distributions, without role/model restrictions', { timeout: 60000 }, async t => {
  assert.ok(existsSync(join(installed, 'index.ts')), 'Run setup-pi.sh to install the declared Pi package first');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(`npm:${metadata.name}@${metadata.version}`, settings.packages[0]);
  const root = await mkdtemp(join(tmpdir(), 'pi subagents integration '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'), cwd = join(root, 'project'), output = join(root, 'loaded.json');
  await mkdir(agent); await mkdir(cwd);
  await writeFile(join(agent, 'settings.json'), JSON.stringify(settings));
  await symlink(npmRoot, join(agent, 'npm'));
  const probe = join(root, 'probe.ts');
  await writeFile(probe, `import {writeFileSync} from 'node:fs';
import {discoverAgents} from ${JSON.stringify(join(installed, 'src/agents/agents.ts'))};
export default function(pi) { pi.registerCommand('replacement-probe', { handler: async (_args,ctx) => {
  writeFileSync(${JSON.stringify(output)},JSON.stringify({tools:pi.getAllTools().map(t=>t.name),commands:pi.getCommands().map(c=>c.name),agents:discoverAgents(ctx.cwd,'both','openai-codex').agents.map(a=>({name:a.name,model:a.model,thinking:a.thinking})),skills:ctx.getSystemPromptOptions().skills?.map(s=>s.name)}));
}}); }`);
  for (const cli of ['dist/cli.js', 'dist/bundle/cli.js']) {
    await t.test(cli, async () => {
      const pending = promisify(execFile)(process.execPath, [join(host, cli), '--offline', '--no-session', '--no-context-files', '--approve', '-e', probe, '-p', '/replacement-probe'], {
        cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000, maxBuffer: 1024 * 1024,
      });
      pending.child.stdin.end(); const { stdout, stderr } = await pending;
      assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module|duplicate registration/i);
      const result = JSON.parse(await readFile(output, 'utf8'));
      for (const tool of ['subagent', 'bg_wait', 'subagent_supervisor']) assert.ok(result.tools.includes(tool), tool);
      for (const command of ['subagents-guide', 'subagents-fleet', 'subagents-models', 'subagents-doctor']) assert.ok(result.commands.includes(command), command);
      assert.ok(!result.commands.includes('orchestrate'));
      for (const name of ['scout', 'worker']) {
        const agent = result.agents.find(a=>a.name===name);
        assert.ok(agent, name);
        assert.ok(!agent.model || agent.model === 'inherit', `${name} is not pinned to a fixed model`);
      }
      assert.ok(result.skills.length > 0, 'stock package skills load without custom filtering');
    });
  }
});
