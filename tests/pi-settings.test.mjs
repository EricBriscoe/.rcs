import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncSettings } from '../pi/settings.mjs';

test('main Astra conversations use xhigh while subagents retain medium thinking', () => {
  const settings = JSON.parse(readFileSync(new URL('../pi/settings.json', import.meta.url), 'utf8'));
  assert.equal(settings.defaultModel, 'gpt-6-astra');
  assert.equal(settings.defaultThinkingLevel, 'xhigh');
  assert.equal(settings.subagents.defaultThinking, 'medium');
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'), checkout = join(root, 'checkout');
  mkdirSync(agent); mkdirSync(join(checkout, 'pi'), { recursive: true });
  const defaults = join(checkout, 'pi/settings.json'), local = join(agent, 'settings.json');
  const put = (path, value) => writeFileSync(path, JSON.stringify(value));
  const get = path => JSON.parse(readFileSync(path, 'utf8'));
  const sync = () => { syncSettings(checkout, agent); return get(local); };
  return { root, agent, checkout, defaults, local, put, get, sync };
}

test('fresh settings are local, private, idempotent and never seed runtime markers', t => {
  const f = fixture(t);
  f.put(f.defaults, { theme: 'paper', lastChangelogVersion: 'old' });
  assert.deepEqual(f.sync(), { theme: 'paper' });
  const before = lstatSync(f.local);
  f.sync();
  assert.equal(lstatSync(f.local).ino, before.ino);
  assert.equal(before.mode & 0o777, 0o600);
  assert.equal(before.isSymbolicLink(), false);
});

test('migration detaches symlink without changing target and preserves runtime state', t => {
  const f = fixture(t), initial = { theme: 'paper', lastChangelogVersion: '0.86.1' };
  f.put(f.defaults, initial); symlinkSync(f.defaults, f.local);
  assert.deepEqual(f.sync(), initial);
  assert.equal(lstatSync(f.local).isSymbolicLink(), false);
  f.put(f.local, { ...initial, lastChangelogVersion: 'new' });
  assert.deepEqual(f.get(f.defaults), initial);
  f.sync();
  assert.equal(readdirSync(f.agent).filter(name => name.startsWith('settings-backup.')).length, 1);
});

test('three-way reconciliation updates inherited defaults and preserves overrides and deletions', t => {
  const f = fixture(t);
  f.put(f.defaults, { theme: 'paper', nested: { a: 1, b: 2 }, remove: true, deleted: true, packages: ['npm:a'] });
  f.sync();
  f.put(f.local, { ...f.get(f.local), nested: { a: 9, b: 2 }, lastChangelogVersion: 'new', custom: true });
  const local = f.get(f.local); delete local.deleted; f.put(f.local, local);
  f.put(f.defaults, { theme: 'dark', nested: { a: 3, b: 4, c: 5 }, deleted: false, added: true, packages: ['npm:b'] });
  const expected = { theme: 'dark', nested: { a: 9, b: 4, c: 5 }, added: true, packages: ['npm:b'], lastChangelogVersion: 'new', custom: true };
  assert.deepEqual(f.sync(), expected);
  assert.deepEqual(f.sync(), expected);
});

test('first adoption preserves existing settings and treats arrays as whole local overrides', t => {
  const f = fixture(t);
  f.put(f.defaults, { theme: 'paper', nested: { a: 1 }, packages: ['npm:a'] });
  f.put(f.local, { theme: 'local', packages: ['npm:custom'] });
  assert.deepEqual(f.sync(), { theme: 'local', nested: { a: 1 }, packages: ['npm:custom'] });
  f.put(f.defaults, { theme: 'dark', nested: { a: 2 }, packages: ['npm:b'] });
  assert.deepEqual(f.sync(), { theme: 'local', nested: { a: 2 }, packages: ['npm:custom'] });
});

test('runtime version bumps leave the checkout clean for automatic pulls', t => {
  const f = fixture(t);
  f.put(f.defaults, { theme: 'paper' });
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: f.checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'defaults');
  symlinkSync(f.defaults, f.local);
  f.sync();
  f.put(f.local, { ...f.get(f.local), lastChangelogVersion: 'next' });
  f.sync();
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(f.get(f.local).lastChangelogVersion, 'next');
});

test('invalid settings fail without altering the local file or source', t => {
  const f = fixture(t);
  f.put(f.defaults, { theme: 'paper' });
  writeFileSync(f.local, 'not json');
  assert.throws(f.sync);
  assert.equal(readFileSync(f.local, 'utf8'), 'not json');
  assert.deepEqual(f.get(f.defaults), { theme: 'paper' });
});
