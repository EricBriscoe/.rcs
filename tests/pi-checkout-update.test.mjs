import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateCheckout } from '../pi/update-deps.mjs';

const exec = promisify(execFile);
async function fixture(t, branch = 'master') {
  const root = await mkdtemp(join(tmpdir(), 'pi checkout update '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), source = join(root, 'source'), checkout = join(root, 'checkout');
  // No user Git config, signing, credentials, hooks, or network in these tests.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[key];
  const run = (cmd, args, options = {}) => exec(cmd, args, { ...options, env: { ...env, ...options.env } });
  const git = async (cwd, ...args) => (await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();
  await git(root, 'init', '--bare', '--initial-branch=' + branch, remote);
  await git(root, 'clone', remote, source);
  await writeFile(join(source, 'harness'), 'original\n');
  await git(source, 'add', '.'); await git(source, 'commit', '-m', 'initial'); await git(source, 'push', '-u', 'origin', branch);
  await git(root, 'clone', remote, checkout);
  const advance = async () => {
    await writeFile(join(source, 'harness'), 'updated\n');
    await git(source, 'commit', '-am', 'update'); await git(source, 'push');
    return git(source, 'rev-parse', 'HEAD');
  };
  const logs = [], calls = [];
  const options = { log: message => logs.push(message), run: (cmd, args, opts) => { calls.push([cmd, args, opts]); return run(cmd, args, opts); } };
  return { root, source, remote, checkout, git, advance, logs, calls, options };
}

for (const branch of ['master', 'main']) test(`fast-forwards clean ${branch} upstream, disables hooks and preserves local commits`, async t => {
  const f = await fixture(t, branch), next = await f.advance();
  const hook = join(f.checkout, '.git/hooks/post-merge');
  await writeFile(hook, '#!/bin/sh\ntouch hook-ran\n'); await chmod(hook, 0o700);
  await f.git(f.checkout, 'config', 'pull.rebase', 'true');
  await f.git(f.checkout, 'config', 'merge.autostash', 'true');
  assert.equal(await updateCheckout(f.checkout, f.options), 'updated');
  assert.equal(await f.git(f.checkout, 'rev-parse', 'HEAD'), next);
  assert.equal(await readFile(join(f.checkout, 'harness'), 'utf8'), 'updated\n');
  await assert.rejects(readFile(join(f.checkout, 'hook-ran')), { code: 'ENOENT' });
  const pull = f.calls.find(([, args]) => args.includes('pull'));
  for (const flag of ['--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules']) assert.ok(pull[1].includes(flag));
  assert.equal(pull[2].cwd, f.checkout); assert.equal(pull[2].env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(pull[2].timeout, 30000); assert.equal(pull[2].env.GIT_DIR, undefined);
  assert.equal(await updateCheckout(f.checkout, f.options), 'unchanged');
  await writeFile(join(f.checkout, 'local'), 'local commit\n');
  await f.git(f.checkout, 'add', '.'); await f.git(f.checkout, 'commit', '-m', 'local');
  const ahead = await f.git(f.checkout, 'rev-parse', 'HEAD');
  assert.equal(await updateCheckout(f.checkout, f.options), 'unchanged');
  assert.equal(await f.git(f.checkout, 'rev-parse', 'HEAD'), ahead);
});

for (const kind of ['unstaged', 'staged', 'untracked', 'feature', 'detached', 'no-upstream', 'wrong-upstream', 'operation']) {
  test(`skips ${kind} checkout without fetching or changing files`, async t => {
    const f = await fixture(t); await f.advance();
    if (kind === 'unstaged' || kind === 'staged') await writeFile(join(f.checkout, 'harness'), 'my changes\n');
    if (kind === 'staged') await f.git(f.checkout, 'add', '.');
    if (kind === 'untracked') await writeFile(join(f.checkout, 'new'), 'my new file\n');
    if (kind === 'feature') await f.git(f.checkout, 'switch', '-c', 'feature');
    if (kind === 'detached') await f.git(f.checkout, 'checkout', '--detach');
    if (kind === 'no-upstream') await f.git(f.checkout, 'branch', '--unset-upstream');
    if (kind === 'wrong-upstream') await f.git(f.checkout, 'config', 'branch.master.merge', 'refs/heads/other');
    if (kind === 'operation') await mkdir(join(f.checkout, '.git/rebase-merge'));
    const before = await f.git(f.checkout, 'rev-parse', 'HEAD');
    const status = await f.git(f.checkout, 'status', '--porcelain=v1');
    const contents = await readFile(join(f.checkout, 'harness'), 'utf8');
    assert.equal(await updateCheckout(f.checkout, f.options), 'skipped');
    assert.equal(await f.git(f.checkout, 'rev-parse', 'HEAD'), before);
    assert.equal(await f.git(f.checkout, 'status', '--porcelain=v1'), status);
    assert.equal(await readFile(join(f.checkout, 'harness'), 'utf8'), contents);
    assert.ok(!f.calls.some(([, args]) => args.includes('pull') || args.includes('fetch')));
    assert.match(f.logs.join('\n'), /skipped/);
  });
}

test('divergence refuses integration even with rebase/autostash configured', async t => {
  const f = await fixture(t); await f.advance();
  await writeFile(join(f.checkout, 'local'), 'local commit\n');
  await f.git(f.checkout, 'add', '.'); await f.git(f.checkout, 'commit', '-m', 'local');
  await f.git(f.checkout, 'config', 'pull.rebase', 'true');
  await f.git(f.checkout, 'config', 'rebase.autostash', 'true');
  const before = await f.git(f.checkout, 'rev-parse', 'HEAD');
  await assert.rejects(updateCheckout(f.checkout, f.options));
  assert.equal(await f.git(f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(await f.git(f.checkout, 'status', '--porcelain=v1'), '');
  assert.equal(await f.git(f.checkout, 'stash', 'list'), '');
});

test('unavailable remote leaves checkout unchanged; a subdirectory cannot update its parent repo', async t => {
  const f = await fixture(t), before = await f.git(f.checkout, 'rev-parse', 'HEAD');
  await f.git(f.checkout, 'remote', 'set-url', 'origin', join(f.root, 'missing.git'));
  await assert.rejects(updateCheckout(f.checkout, f.options));
  assert.equal(await f.git(f.checkout, 'rev-parse', 'HEAD'), before);
  const nested = join(f.checkout, 'nested'); await mkdir(nested);
  f.calls.length = 0;
  assert.equal(await updateCheckout(nested, f.options), 'skipped');
  assert.ok(!f.calls.some(([, args]) => args.includes('pull')));
});
