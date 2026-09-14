import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const host = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { DefaultPackageManager } = await import(pathToFileURL(join(host, 'dist/core/package-manager.js')));
const { SettingsManager } = await import(pathToFileURL(join(host, 'dist/core/settings-manager.js')));

test('native package install persistence retains Bigpowers filters and discovery disables executable resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi package filters '));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Package discovery also reads ~/.agents/skills, independently of agentDir.
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  const agent = join(root, 'agent'), packageRoot = join(agent, 'npm/node_modules/bigpowers');
  const put = async (path, text) => {
    const file = join(packageRoot, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
  };
  await put('package.json', JSON.stringify({ name: 'bigpowers', version: '1.0.0', pi: {
    extensions: ['./extensions'], skills: ['./.pi/skills'], prompts: ['./.pi/prompts'], themes: ['./themes'],
  } }));
  await put('extensions/hook.ts', 'throw Error("must not load");');
  await put('.pi/skills/example/SKILL.md', '---\nname: example\ndescription: Example\n---\nExample\n');
  await put('.pi/prompts/example.md', 'Example\n');
  await put('themes/example.json', '{}');
  const settings = JSON.parse(await readFile(new URL('../pi/settings.json', import.meta.url), 'utf8'));
  const entry = settings.packages.find(value => value.source === 'npm:bigpowers');
  const manager = SettingsManager.inMemory({ packages: [entry] });
  const packages = new DefaultPackageManager({ cwd: root, agentDir: agent, settingsManager: manager });
  assert.equal(packages.addSourceToSettings('npm:bigpowers'), false);
  assert.deepEqual(manager.getGlobalSettings().packages, [entry]);
  const resolved = await packages.resolve(() => { throw Error('fixture must not download'); });
  const enabled = type => resolved[type].filter(resource => resource.enabled);
  assert.equal(enabled('extensions').length, 0);
  assert.equal(enabled('themes').length, 0);
  assert.equal(enabled('skills').length, 1);
  assert.equal(enabled('prompts').length, 1);
});
