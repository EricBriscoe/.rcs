import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const script = new URL('../pi/global-ignore.mjs', import.meta.url);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'pi ignore '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', args, { cwd: home, env, encoding: 'utf8' }).trim();
  const run = () => execFileSync(process.execPath, [script.pathname], { cwd: home, env });
  return { home, env, git, run };
}

test('creates a global file, preserves rules, is idempotent, and ignores only approved paths', t => {
  const { home, env, git, run } = fixture(t);
  const path = join(home, '.gitignore');
  writeFileSync(path, '.serena/\n');
  run();
  const first = readFileSync(path, 'utf8');
  run();
  assert.equal(readFileSync(path, 'utf8'), first);
  assert.ok(first.startsWith('.serena/\n'));
  assert.equal(git('config', '--global', '--get', 'core.excludesFile'), path);
  git('init', '-q');
  for (const name of ['specs/state.yaml', 'nested/specs/a.md', '.bigpowers/cache/a', 'allure-results/a.xml', '.pi/subagents/a', '.pi/npm/a', '.pi/git/a', '.pi/mcp-traces/a', '.pi/mcp-oauth/a', 'nested/.pi/subagents/a']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', name], { cwd: home, env }).status, 0, name);
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'CONVENTIONS.md', '.pi/settings.json', '.agents/skills/a', 'scripts/a.sh', 'docs/a.md']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', name], { cwd: home, env }).status, 1, name);
  }
});

test('respects configured paths and replaces only the managed block', t => {
  const { home, git, run } = fixture(t);
  const path = join(home, 'custom ignores');
  git('config', '--global', 'core.excludesFile', '~/custom ignores');
  writeFileSync(path, 'before\n# BEGIN rcs pi generated artifacts\nstale/\n# END rcs pi generated artifacts\nafter\n');
  run();
  const result = readFileSync(path, 'utf8');
  assert.ok(result.startsWith('before\n'));
  assert.ok(result.endsWith('after\n'));
  assert.ok(!result.includes('stale/'));
  assert.equal(git('config', '--global', '--get', 'core.excludesFile'), '~/custom ignores');
});

test('preserves the existing default XDG excludes file', t => {
  const { home, git, run } = fixture(t);
  mkdirSync(join(home, '.config/git'), { recursive: true });
  const path = join(home, '.config/git/ignore');
  writeFileSync(path, 'existing/\n');
  run();
  assert.ok(readFileSync(path, 'utf8').startsWith('existing/\n'));
  assert.equal(git('config', '--global', '--get', 'core.excludesFile'), path);
});

test('rejects malformed managed markers without modifying the file', t => {
  const { home, run } = fixture(t);
  const path = join(home, '.gitignore');
  const original = '# BEGIN rcs pi generated artifacts\nkeep-me\n';
  writeFileSync(path, original);
  assert.throws(run);
  assert.equal(readFileSync(path, 'utf8'), original);
});
