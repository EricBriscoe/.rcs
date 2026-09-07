import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { projectInstructions } from '../pi/extensions/project-context/context.ts';

const packageDir = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));

test('optional .pi project context accepts real files and rejects symlink escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi project context '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'AGENTS.md'), 'STANDARD_CONTEXT');
  assert.equal(await projectInstructions(root), '');
  await mkdir(join(root, '.pi'));
  const path = join(root, '.pi/AGENTS.md');
  await writeFile(path, 'EXTRA_PROJECT_CONTEXT');
  assert.equal(await projectInstructions(root), 'EXTRA_PROJECT_CONTEXT');
  await rm(path); await symlink(join(root, 'AGENTS.md'), path);
  assert.equal(await projectInstructions(root), '');
});

test('standard Pi discovery loads global/project instructions and installed skills; launcher does not suppress resources', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi standard resources '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'), cwd = join(root, 'project'), output = join(root, 'effective.json');
  await mkdir(agent); await mkdir(cwd);
  await writeFile(join(agent, 'settings.json'), '{}');
  await writeFile(join(agent, 'AGENTS.md'), 'GLOBAL_FIXTURE');
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_FIXTURE');
  for (const name of ['schlep', 'pi-maintenance']) await cp(join(checkout, 'pi/skills', name), join(agent, 'skills', name), { recursive: true });
  const probe = join(root, 'probe.ts');
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi) {pi.registerCommand('resource-probe',{handler:async(_args,ctx)=>{writeFileSync(${JSON.stringify(output)},JSON.stringify({prompt:ctx.getSystemPrompt(),skills:ctx.getSystemPromptOptions().skills?.map(s=>s.name)}));}});}`);
  const pending = promisify(execFile)(process.execPath, [join(packageDir, 'dist/cli.js'), '--offline', '--no-session', '--approve', '-e', probe, '-p', '/resource-probe'], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent, HOME: root }, timeout: 25000 });
  pending.child.stdin.end(); await pending;
  const result = JSON.parse(await readFile(output, 'utf8'));
  assert.match(result.prompt, /GLOBAL_FIXTURE/); assert.match(result.prompt, /PROJECT_FIXTURE/);
  assert.deepEqual(result.skills.sort(), ['pi-maintenance', 'schlep']);
  assert.doesNotMatch(result.prompt, /Capture long test logs locally/, 'skill bodies stay on demand');
  const launcher = await readFile(join(checkout, 'pi/launch.mjs'), 'utf8');
  assert.match(launcher, /process\.argv\.slice\(2\)/);
  assert.doesNotMatch(launcher, /nativeArgs|--no-context-files|--no-extensions/);
});
