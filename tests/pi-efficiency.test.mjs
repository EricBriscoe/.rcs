import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { commandWords, filterFor, quietTests, runFilter, saveRaw, originalOutput, MAX_FILTER_BYTES } from '../pi/extensions/efficiency/output.ts';
import { recordUsage, recordOutput, usageReport, formatReport } from '../pi/extensions/efficiency/usage.ts';
import { installRtk } from '../pi/install-rtk.mjs';
import { nativeEnvironment } from '../pi/native-resources.mjs';

async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'pi efficiency ')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const signal = () => new AbortController().signal;

test('classification is conservative and never reconstructs executed commands', () => {
  assert.deepEqual(commandWords('cd "space here" && VAR=x git --no-pager diff'), ['git', '--no-pager', 'diff']);
  for (const cmd of ['git diff | head', 'git diff; touch x', 'git diff && echo hi', 'git diff > out', 'git diff $(echo x)', 'git diff\ngit status', '# pi:raw\ngit diff', 'RTK_DISABLED=1 git diff', 'git diff `whoami`']) assert.equal(filterFor(cmd, 'diff --git a/a b/a'), undefined, cmd);
  assert.equal(filterFor('git diff', 'diff --git a/a b/a'), 'git-diff');
  assert.equal(filterFor('git status --short', ' M file'), 'git-status');
  for (const cmd of ['git status', 'git status --short --branch', 'git diff --numstat', 'git log --format=oneline', 'git diff -z']) assert.equal(filterFor(cmd, 'diff --git a/a b/a'), undefined, cmd);
  assert.equal(filterFor('git diff', 'warning: inspect this\ndiff --git a/a b/a'), undefined);
  assert.equal(filterFor('git log', 'commit ' + 'a'.repeat(40) + '\nAuthor: fixture\nDate: today'), undefined, 'RTK log filter requires injected delimiters');
  assert.equal(filterFor('git status --short', '\u001b[31m M file\u001b[0m'), undefined);
  assert.equal(filterFor('rg -n match src', 'src/a.ts:2:match\nsrc/b.ts:3:match\n'), 'grep');
  assert.equal(filterFor('rg -n match src', 'not a line match'), undefined);
  assert.equal(filterFor('cargo test', 'test result: ok. 12 passed'), 'cargo-test');
  assert.equal(filterFor('pytest', '===== 12 passed in 1.0s ====='), 'pytest');
});

test('quiet passing tests retain summaries, skips and diagnostics; failures/opt-outs stay raw', () => {
  const raw = '✔ good (1.234ms)\n✔ another (2s)\nℹ tests 2\nℹ fail 0\nSKIPPED optional\n';
  const quiet = quietTests('node --test tests/*.test.mjs', raw);
  assert.match(quiet, /2 passing test lines omitted/);
  assert.match(quiet, /ℹ tests 2/); assert.match(quiet, /SKIPPED optional/);
  assert.equal(quietTests('node --test', raw.replace('fail 0', 'fail 1')), undefined);
  assert.equal(quietTests('node --test', 'Warning: retained diagnostic\n' + raw), undefined);
  assert.equal(quietTests('# pi:raw\nnode --test', raw), undefined);
  assert.match(quietTests('python3 -m unittest discover -v', 'test_thing (Fixture) ... ok\nRan 1 test in 0.01s\nOK\n'), /1 passing test lines omitted/);
});

test('RTK pipe has isolated environment/stdin, bounded errors and cancellation', async t => {
  const root = await temp(t), script = join(root, 'rtk');
  await writeFile(script, `#!${process.execPath}\nlet s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),s,cwd:process.cwd(),home:process.env.HOME,telemetry:process.env.RTK_TELEMETRY_DISABLED,toml:process.env.RTK_NO_TOML,privateEnv:process.env.PI_EFFICIENCY_SECRET_FIXTURE??null})));`, { mode: 0o700 });
  const previous = process.env.PI_EFFICIENCY_SECRET_FIXTURE;
  process.env.PI_EFFICIENCY_SECRET_FIXTURE = 'not-for-rtk';
  t.after(() => { if (previous === undefined) delete process.env.PI_EFFICIENCY_SECRET_FIXTURE; else process.env.PI_EFFICIENCY_SECRET_FIXTURE = previous; });
  const home = join(root, 'isolated');
  const result = JSON.parse(await runFilter(script, 'git-diff', 'unchanged stdin\n', home, signal()));
  assert.deepEqual(result.args, ['pipe', '--filter', 'git-diff']);
  assert.equal(result.s, 'unchanged stdin\n'); assert.equal(result.home, home); assert.equal(result.cwd, await import('node:fs/promises').then(fs => fs.realpath(home)));
  assert.equal(result.telemetry, '1'); assert.equal(result.toml, '1'); assert.equal(result.privateEnv, null);
  for (const body of ["process.stderr.write('warning');", 'process.exit(1)', 'process.stdout.write("x".repeat(3*1024*1024))']) {
    await writeFile(script, `#!${process.execPath}\n${body}`);
    await assert.rejects(runFilter(script, 'git-diff', 'raw', home, signal()));
  }
  await writeFile(script, `#!${process.execPath}\nsetInterval(()=>{},1000)`);
  const controller = new AbortController();
  const pending = runFilter(script, 'git-diff', 'raw', home, controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending);
  await assert.rejects(runFilter(join(root, 'missing'), 'git-diff', 'raw', home, signal()));
});

test('raw artifacts are private, bounded in count and recover native full logs', async t => {
  const root = await temp(t), directory = join(root, 'output');
  let path;
  for (let i = 0; i < 103; i++) path = await saveRaw(directory, `raw ${i}\n`);
  assert.equal((await readdir(directory)).length, 100);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const event = { content: [{ type: 'text', text: 'truncated...' }], details: { fullOutputPath: path } };
  assert.equal((await originalOutput(event)).raw, 'raw 102\n');
  await writeFile(path, 'x'.repeat(MAX_FILTER_BYTES + 1));
  assert.equal(await originalOutput(event), undefined);
  const link = join(root, 'link'); await symlink(directory, link);
  await assert.rejects(saveRaw(link, 'no'));
});

test('usage separates provider categories/cache counts from byte reductions and fences duplicate summaries', async t => {
  const root = await temp(t), usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, totalTokens: 117 };
  for (const category of ['foreground', 'memory', 'worker', 'routing', 'supervision', 'compaction', 'branch-summary']) recordUsage(root, 'session', category, 'provider/model', usage, category);
  recordUsage(root, 'session', 'compaction', 'provider/model', usage, 'compaction');
  recordUsage(root, 'other', 'foreground', 'provider/model', { input: 7 });
  recordUsage(root, 'session', 'foreground', 'provider/model', undefined);
  recordOutput(root, 'session', 'passing-tests', 10000, 500);
  const report = usageReport(root, 'session');
  assert.equal(report.models.length, 7); assert.equal(report.models.reduce((n, r) => n + r.calls, 0), 7);
  assert.equal(report.models[0].cacheRead, 100); assert.equal(report.output[0].beforeBytes, 10000);
  assert.match(formatReport(report), /not provider-token or billing savings/);
  assert.equal(usageReport(root).models.find(r => r.category === 'foreground').input, 17);
  assert.equal((await stat(join(root, 'efficiency/usage.sqlite'))).mode & 0o777, 0o600);
  const target = join(root, 'private-target'); await writeFile(target, 'unchanged');
  await symlink(target, join(root, 'efficiency/usage.sqlite-wal'));
  recordUsage(root, 'session', 'foreground', 'model', usage);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  assert.equal(usageReport(root), undefined);
  await rm(join(root, 'efficiency'), { recursive: true });
  await writeFile(join(root, 'efficiency'), 'blocked');
  assert.doesNotThrow(() => recordUsage(root, 'session', 'foreground', 'model', usage));
  assert.equal(usageReport(root), undefined);
});

test('RTK installer verifies pinned archives, installs atomically, rejects tampering and avoids repeat downloads', async t => {
  const root = await temp(t), archive = join(root, 'fixture.tar.gz'), source = join(root, 'source');
  await mkdir(source); await writeFile(join(source, 'rtk'), '#!/bin/sh\nprintf fixture');
  execFileSync('tar', ['-czf', archive, '-C', source, 'rtk']);
  const bytes = await readFile(archive), sha256 = createHash('sha256').update(bytes).digest('hex');
  const pins = { version: '0.48.0', assets: { fixture: { name: 'rtk-fixture.tar.gz', sha256 } } };
  let downloads = 0;
  const options = { platform: 'fixture', download: async url => { assert.match(url, /github.com\/rtk-ai\/rtk\/releases\/download\/v0.48.0\/rtk-fixture.tar.gz$/); downloads++; return new Response(bytes); } };
  const agent = join(root, 'agent'), binary = await installRtk(agent, pins, options);
  assert.equal((await stat(binary)).mode & 0o777, 0o700);
  assert.equal(await installRtk(agent, pins, options), binary); assert.equal(downloads, 1);
  await writeFile(binary, 'tampered'); await assert.rejects(installRtk(agent, pins, options), /Invalid RTK/);
  await assert.rejects(installRtk(join(root, 'bad'), { ...pins, assets: { fixture: { ...pins.assets.fixture, sha256: '0'.repeat(64) } } }, options), /checksum mismatch/);
  assert.equal((await readdir(join(root, 'bad/tooling/rtk'))).length, 0);
  await assert.rejects(installRtk(agent, pins, { ...options, platform: 'unsupported' }), /Unsupported/);
  const checkout = join(root, 'checkout'); await mkdir(join(checkout, 'pi'), { recursive: true });
  await writeFile(join(checkout, 'pi/rtk.json'), JSON.stringify(pins));
  const env = nativeEnvironment(checkout, { PI_CODING_AGENT_DIR: agent, PATH: '/original' });
  assert.equal(env.PATH, `${dirname(binary)}:/original`); assert.equal(env.RTK_TELEMETRY_DISABLED, '1');
});

test('Pi Markdown remains lean and maintenance stays on demand', async () => {
  const root = new URL('../', import.meta.url);
  const paths = ['README.md', 'pi/AGENTS.md', 'pi/extensions/memory/README.md', 'pi/SUBAGENTS.md', 'pi/extensions/code-navigation/README.md', 'pi/extensions/efficiency/README.md', 'pi/skills/pi-maintenance/SKILL.md', 'pi/skills/schlep/SKILL.md'];
  const files = await Promise.all(paths.map(path => readFile(new URL(path, root), 'utf8')));
  assert.ok(Buffer.byteLength(files[1]) < 2500, 'global instructions budget');
  const owned = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'README.md', ':(glob)pi/**/*.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
  const sizes = await Promise.all(owned.filter(path => existsSync(new URL(path, root))).map(async path => Buffer.byteLength(await readFile(new URL(path, root), 'utf8'))));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) < 26000, 'all owned Markdown budget, including new files');
  assert.match(files[1], /pi-maintenance/); assert.doesNotMatch(files[1], /no routine.*agents|\/orchestrate/);
  assert.match(files[6], /python3 -m unittest/); assert.match(files[7], /No push/);
});
