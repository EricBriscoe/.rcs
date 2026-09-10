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
const longRunConfig = JSON.parse(await readFile(new URL('pi/subagents.json', checkout), 'utf8'));
const host = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
const npmRoot = join(agentDir, 'npm');
const installed = join(npmRoot, 'node_modules/pi-subagents');

test('replacement tracks upstream updates with dynamic model selection, not role pins or a model allowlist', async () => {
  assert.ok(settings.packages.includes('npm:pi-subagents'));
  assert.equal(settings.subagents, undefined);
  assert.equal(settings.enabledModels, undefined);
  for (const path of ['pi/extensions/orchestrate', 'pi/orchestrator.json']) assert.equal(existsSync(new URL(path, checkout)), false);
  const rules = await readFile(new URL('pi/AGENTS.md', checkout), 'utf8');
  assert.doesNotMatch(rules, /orchestrate|no recursion|native Pi workers only|no routine.*agents|Do not inherit ancestor/);
  assert.match(rules, /full authenticated OpenAI catalog/);
  assert.match(rules, /Prefer newer generations/);
});

test('long-run policy keeps monitoring advisory and documents stock limits', async () => {
  assert.equal(longRunConfig.timeoutMs, 72 * 60 * 60 * 1000);
  assert.ok(longRunConfig.timeoutMs <= 2147483647, 'deadline fits Node timers');
  assert.equal(longRunConfig.maxSubagentSpawnsPerRun, 1024);
  assert.equal(longRunConfig.maxSubagentSpawnsPerSession, 0);
  for (const key of ['toolBudget', 'usageBudget', 'toolTimeoutMs', 'globalConcurrencyLimit', 'waitTool']) {
    assert.equal(longRunConfig[key], undefined, `${key} stays stock/unconfigured`);
  }
  assert.deepEqual(longRunConfig.control, {
    enabled: true, needsAttentionAfterMs: 15 * 60 * 1000, activeNoticeAfterMs: 30 * 60 * 1000,
    notifyOn: ['active_long_running', 'needs_attention'],
  });
  const policy = await readFile(new URL('pi/SUBAGENTS.md', checkout), 'utf8');
  assert.match(policy, /steeringRecovery: false/);
  assert.match(policy, /auto-drain still fails after 30 minutes/);
  assert.match(policy, /72 hours is a hard deadline, not unlimited/);
  const instructions = await readFile(new URL('pi/AGENTS.md', checkout), 'utf8');
  assert.match(instructions, /Cancellation is the coordinator's decision/);
  assert.match(instructions, /SUBAGENTS\.md/);
});

test('installed pi-subagents loads long-run settings via standard discovery in both Pi distributions, without role/model restrictions', { timeout: 60000 }, async t => {
  assert.ok(existsSync(join(installed, 'index.ts')), 'Run setup-pi.sh to install the declared Pi package first');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(`npm:${metadata.name}`, settings.packages[0]);
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  const root = await mkdtemp(join(tmpdir(), 'pi subagents integration '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'), cwd = join(root, 'project'), output = join(root, 'loaded.json');
  await mkdir(agent); await mkdir(cwd);
  await writeFile(join(agent, 'settings.json'), JSON.stringify(settings));
  await symlink(npmRoot, join(agent, 'npm'));
  await mkdir(join(agent, 'extensions/subagent'), { recursive: true });
  await symlink(new URL('pi/subagents.json', checkout), join(agent, 'extensions/subagent/config.json'));
  const probe = join(root, 'probe.ts');
  await writeFile(probe, `import {writeFileSync} from 'node:fs';
import {discoverAgents} from ${JSON.stringify(join(installed, 'src/agents/agents.ts'))};
import {loadConfig} from ${JSON.stringify(join(installed, 'src/extension/config.ts'))};
import {resolveConfigDefaultTimeoutMs,resolveSingleAgentLaunchTimeout} from ${JSON.stringify(join(installed, 'src/runs/foreground/subagent-executor.ts'))};
import {resolveControlConfig,deriveActivityState,shouldEmitOpenToolAttention} from ${JSON.stringify(join(installed, 'src/runs/shared/subagent-control.ts'))};
import {resolveMaxSubagentSpawnsPerRun,resolveMaxSubagentSpawnsPerSession} from ${JSON.stringify(join(installed, 'src/shared/types.ts'))};
export default function(pi) { pi.registerCommand('replacement-probe', { handler: async (_args,ctx) => {
  const config = loadConfig(), timeout = resolveConfigDefaultTimeoutMs(config.timeoutMs), control = resolveControlConfig(config.control);
  const activity = now => deriveActivityState({config:control,startedAt:0,lastActivityAt:0,turnCount:1,thinking:'high',now}) ?? null;
  const openTool = now => shouldEmitOpenToolAttention({config:control,currentTool:'bash',currentToolStartedAt:0,now});
  const policy = {config,
    asyncChild:resolveSingleAgentLaunchTimeout({agent:'worker'},true,timeout),
    foregroundChild:resolveSingleAgentLaunchTimeout({agent:'worker'},false,timeout),
    asyncWorkflow:resolveSingleAgentLaunchTimeout({workflowScript:'return 1'},true,timeout),
    explicitDeadline:resolveSingleAgentLaunchTimeout({agent:'worker',timeoutMs:12345},true,timeout),
    runSpawns:resolveMaxSubagentSpawnsPerRun(config.maxSubagentSpawnsPerRun),
    sessionSpawns:resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
    quietAtFiveMinutes:activity(300000),attentionAfterFifteenMinutes:activity(900001),
    quietToolAtFiveMinutes:openTool(300000),toolNoticeAtThirtyMinutes:openTool(1800000)};
  writeFileSync(${JSON.stringify(output)},JSON.stringify({policy,tools:pi.getAllTools().map(t=>t.name),commands:pi.getCommands().map(c=>c.name),agents:discoverAgents(ctx.cwd,'both','openai-codex').agents.map(a=>({name:a.name,model:a.model,thinking:a.thinking})),skills:ctx.getSystemPromptOptions().skills?.map(s=>s.name)}));
}}); }`);
  for (const cli of ['dist/cli.js', 'dist/bundle/cli.js']) {
    await t.test(cli, async () => {
      const pending = promisify(execFile)(process.execPath, [join(host, cli), '--offline', '--no-session', '--no-context-files', '--approve', '-e', probe, '-p', '/replacement-probe'], {
        cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_SUBAGENT_MAX_SPAWNS_PER_RUN: '', PI_SUBAGENT_MAX_SPAWNS_PER_SESSION: '' }, timeout: 25000, maxBuffer: 1024 * 1024,
      });
      pending.child.stdin.end(); const { stdout, stderr } = await pending;
      assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module|duplicate registration/i);
      const result = JSON.parse(await readFile(output, 'utf8'));
      assert.deepEqual(result.policy, {
        config: longRunConfig,
        asyncChild: { timeoutMs: longRunConfig.timeoutMs },
        foregroundChild: { timeoutMs: longRunConfig.timeoutMs },
        asyncWorkflow: {}, explicitDeadline: { timeoutMs: 12345 },
        runSpawns: 1024, sessionSpawns: null,
        quietAtFiveMinutes: null, attentionAfterFifteenMinutes: 'needs_attention',
        quietToolAtFiveMinutes: false, toolNoticeAtThirtyMinutes: true,
      });
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
