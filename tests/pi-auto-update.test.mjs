import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateDependencies, updateLock, latestRtk } from '../pi/update-deps.mjs';
import { effectiveRtk, autoUpdateEnabled, packageInstallEnvironment } from '../pi/extensions/efficiency/runtime.mjs';
import { nativeEnvironment } from '../pi/native-resources.mjs';

const CORE = '@earendil-works/pi-coding-agent', WEB = '@playwright/cli';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi auto update '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), agent = join(root, 'agent'), global = join(root, 'global');
  const put = async (file, value) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  await put(join(checkout, 'pi/settings.json'), { packages: ['npm:pi-subagents'] });
  await put(join(checkout, 'pi/rtk.json'), { version: '1.0.0', assets: {} });
  const manifest = name => [CORE, WEB].includes(name) ? join(global, name, 'package.json') : name === 'proper-lockfile' ? join(checkout, 'pi/extensions/codex-account-pool/node_modules', name, 'package.json') : join(agent, 'npm/node_modules', name, 'package.json');
  for (const name of [CORE, WEB, 'pi-subagents', 'proper-lockfile']) await put(manifest(name), { name, version: '1.0.0' });
  const calls = [], logs = []; let metadata = 0;
  const options = { agent, checkoutUpdate: async () => {}, npmLatest: async () => { metadata++; return '2.0.0'; }, rtkLatest: async () => ({ version: '2.0.0', assets: {} }),
    rtkInstall: async (_agent, pins) => { calls.push(['rtk', pins.version]); },
    log: line => logs.push(line), run: async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      if (cmd === 'npm' && args[0] === 'root') return { stdout: global + '\n' };
      if (cmd === 'npm' && args[0] === 'install') {
        const spec = args.at(-1), at = spec.lastIndexOf('@');
        await put(manifest(spec.slice(0, at)), { name: spec.slice(0, at), version: spec.slice(at + 1) });
      }
      if (cmd === process.execPath && args[1] === 'update') {
        const name = args[2].slice(4);
        await put(manifest(name), { name, version: '2.0.0' });
      }
      return { stdout: '' };
    },
  };
  return { root, checkout, agent, global, calls, logs, options, put, manifest, metadata: () => metadata };
}

test('every top-level launch checks; explicit bypass/offline/children never update', () => {
  assert.equal(autoUpdateEnabled([], {}), true);
  assert.equal(autoUpdateEnabled(['--version'], {}), true);
  for (const env of [{ PI_AUTO_UPDATE: '0' }, { PI_OFFLINE: '1' }, { PI_AUTO_UPDATE_ACTIVE: '1' }, { PI_SUBAGENT_CHILD: '1' }]) assert.equal(autoUpdateEnabled([], env), false);
  assert.equal(autoUpdateEnabled(['--offline'], {}), false);
});

test('only explicit stock knowledge package operations enable install scripts', () => {
  const allowed = packageInstallEnvironment('npm:pi-knowledge');
  assert.equal(allowed.npm_config_ignore_scripts, 'false');
  for (const source of [undefined, 'npm:pi-subagents', 'npm:pi-knowledge-extra']) {
    assert.equal(packageInstallEnvironment(source).npm_config_ignore_scripts, 'true');
  }
  const env = nativeEnvironment('/missing-checkout', { PI_KNOWLEDGE_AUTO_INJECT: 'true' });
  assert.equal(env.PI_KNOWLEDGE_AUTO_INJECT, 'false');
  assert.equal(env.PI_KNOWLEDGE_EMBEDDING, 'local:multilingual-e5-small');
});

test('real launcher invokes updater every time, bypasses it for repair and preserves stock argv', async t => {
  const f = await fixture(t), count = join(f.root, 'checks');
  for (const path of ['launch.mjs', 'settings.mjs', 'native-resources.mjs', 'extensions/efficiency/runtime.mjs']) {
    await mkdir(join(f.checkout, 'pi', path, '..'), { recursive: true });
    await cp(new URL('../pi/' + path, import.meta.url), join(f.checkout, 'pi', path));
  }
  await f.put(join(f.checkout, 'pi/update-deps.mjs'), `import {appendFileSync} from 'node:fs'; export async function updateDependencies(){appendFileSync(${JSON.stringify(count)},'check\\n');}`);
  await f.put(join(f.global, CORE, 'dist/cli.js'), `console.log(JSON.stringify({args:process.argv.slice(2),nested:process.env.PI_AUTO_UPDATE_ACTIVE,telemetry:process.env.RTK_TELEMETRY_DISABLED,ignoreScripts:process.env.npm_config_ignore_scripts,audit:process.env.npm_config_audit,fund:process.env.npm_config_fund}));`);
  const npm = join(f.root, 'bin/npm'); await f.put(npm, '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_GLOBAL"\n'); await chmod(npm, 0o700);
  const env = { ...process.env, PATH: join(f.root, 'bin') + ':' + process.env.PATH, PI_CODING_AGENT_DIR: f.agent, FIXTURE_GLOBAL: f.global };
  delete env.PI_AUTO_UPDATE; delete env.PI_AUTO_UPDATE_ACTIVE; delete env.PI_SUBAGENT_CHILD; delete env.PI_OFFLINE;
  const launch = (args, extra = {}) => promisify(execFile)(process.execPath, [join(f.checkout, 'pi/launch.mjs'), ...args], { env: { ...env, ...extra } });
  const bypass = await launch(['--no-extensions', '--version'], { PI_AUTO_UPDATE: '0' });
  assert.deepEqual(JSON.parse(bypass.stdout), { args: ['--no-extensions', '--version'], nested: '1', telemetry: '1', ignoreScripts: 'true', audit: 'false', fund: 'false' });
  await assert.rejects(readFile(count), { code: 'ENOENT' });
  for (const args of [['install', 'npm:pi-knowledge'], ['update', 'npm:pi-knowledge']]) {
    const result = await launch(args, { PI_AUTO_UPDATE: '0' });
    assert.equal(JSON.parse(result.stdout).ignoreScripts, 'false');
  }
  for (const args of [['install', 'npm:pi-subagents'], ['update', '--all'], ['install', 'npm:pi-knowledge', '--unexpected']]) {
    const result = await launch(args, { PI_AUTO_UPDATE: '0' });
    assert.equal(JSON.parse(result.stdout).ignoreScripts, 'true');
  }
  await launch(['--version']); await launch(['--version']);
  assert.equal(await readFile(count, 'utf8'), 'check\ncheck\n');
  await launch(['--offline']); assert.equal(await readFile(count, 'utf8'), 'check\ncheck\n');
  await f.put(join(f.checkout, 'pi/update-deps.mjs'), `export async function updateDependencies(){throw Error('PRIVATE_UPDATER_FAILURE');}`);
  const failed = await launch(['--version']);
  assert.match(failed.stderr, /dependency update failed/); assert.doesNotMatch(failed.stderr, /PRIVATE_UPDATER_FAILURE/);
  assert.deepEqual(JSON.parse(failed.stdout).args, ['--version']);
  const runtime = join(f.root, 'pinned node');
  await f.put(runtime, '#!/bin/sh\nprintf "pinned\\n%s\\n%s\\n" "$2" "$PATH"\n');
  await chmod(runtime, 0o700);
  await f.put(join(f.agent, 'runtime-node'), runtime + '\n');
  const pinned = await launch(['--version'], { PI_AUTO_UPDATE: '0' });
  assert.equal(pinned.stdout, `pinned\n--version\n${env.PATH}\n`, 'runtime pin wins without changing the project PATH');
  await rm(runtime);
  await assert.rejects(launch(['--version']), error => {
    assert.match(error.stderr, /configured Node runtime is unavailable/);
    return true;
  });
});

test('updates only owned dependencies, uses stock package update and leaves checked-in definitions untouched', async t => {
  const f = await fixture(t);
  const paths = ['pi/settings.json', 'pi/rtk.json'];
  const before = await Promise.all(paths.map(path => readFile(join(f.checkout, path), 'utf8')));
  const result = await updateDependencies(f.checkout, f.options);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.npm[CORE], '2.0.0'); assert.equal(result.npm['proper-lockfile'], '2.0.0');
  assert.ok(f.calls.some(([cmd, args]) => cmd === process.execPath && args[1] === 'update' && args[2] === 'npm:pi-subagents'));
  for (const [cmd, args] of f.calls) if (cmd === 'npm' && args[0] === 'install') assert.ok(args.includes('--ignore-scripts'));
  const pool = f.calls.find(([cmd, args]) => cmd === 'npm' && Array.isArray(args) && args.includes('proper-lockfile@2.0.0'));
  assert.ok(pool[1].includes('--no-save')); assert.ok(pool[1].includes('--package-lock=false'));
  assert.ok(!f.calls.some(([cmd]) => cmd === 'brew' || cmd.endsWith('/brew')));
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(f.checkout, path), 'utf8'))), before);
  assert.equal(effectiveRtk(f.checkout, f.agent).version, '2.0.0');
  assert.ok(nativeEnvironment(f.checkout, { PI_CODING_AGENT_DIR: f.agent, PATH: '/usr/bin' }).PATH.startsWith(join(f.agent, 'tooling/rtk/2.0.0')));
  const count = f.metadata(); f.calls.length = 0;
  await updateDependencies(f.checkout, f.options);
  assert.equal(f.metadata(), count * 2, 'no daily TTL: check again immediately');
  assert.ok(!f.calls.some(([cmd, args]) => cmd === 'npm' && args[0] === 'install'));
  assert.ok(!f.calls.some(([cmd]) => cmd === process.execPath || cmd === 'playwright-cli'));
});

test('knowledge native repair runs even with unchanged versions and unavailable registry metadata', async t => {
  const f = await fixture(t);
  await f.put(join(f.checkout, 'pi/settings.json'), { packages: ['npm:pi-knowledge'] });
  const run = f.options.run;
  let probes = 0;
  f.options.npmLatest = async () => { throw Error('offline'); };
  f.options.run = async (cmd, args, opts) => {
    if (cmd === process.execPath && args[0] === '-e') {
      probes++;
      if (probes === 1) throw Error('ABI mismatch');
    }
    return run(cmd, args, opts);
  };
  const result = await updateDependencies(f.checkout, f.options);
  assert.equal(probes, 2);
  const rebuild = f.calls.find(([cmd, args]) => cmd === 'npm' && args[0] === 'rebuild');
  assert.deepEqual(rebuild[1], ['rebuild', '--prefix', join(f.agent, 'npm'), '--ignore-scripts=false', 'better-sqlite3']);
  assert.equal(rebuild[2].cwd, join(f.agent, 'updates'));
  assert.equal(rebuild[2].env.npm_config_ignore_scripts, 'false');
  assert.ok(!result.warnings.includes('pi-knowledge native SQLite'));
  f.calls.length = 0;
  await updateDependencies(f.checkout, f.options);
  assert.ok(!f.calls.some(([cmd, args]) => cmd === 'npm' && args[0] === 'rebuild'), 'healthy runtime is not rebuilt');
  f.options.run = async (cmd, args, opts) => {
    if (cmd === process.execPath && args[0] === '-e') throw Error('ABI mismatch');
    return run(cmd, args, opts);
  };
  const failed = await updateDependencies(f.checkout, f.options);
  assert.ok(failed.warnings.includes('pi-knowledge native SQLite'), 'failed repair warns without preventing launch');
});

test('checkout sync runs under the lock before reading dependency definitions; failures are nonfatal', async t => {
  const f = await fixture(t);
  let locked = false, synced = false;
  const result = await updateDependencies(f.checkout, { ...f.options,
    lock: (directory, fn) => updateLock(directory, async () => { locked = true; try { return await fn(); } finally { locked = false; } }),
    checkoutUpdate: async (checkout) => {
      assert.equal(locked, true); assert.equal(checkout, f.checkout);
      await f.put(join(checkout, 'pi/settings.json'), { packages: ['npm:pi-knowledge'] }); synced = true;
    },
    npmLatest: async () => { assert.equal(synced, true); return '2.0.0'; },
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.npm['pi-knowledge'], '2.0.0');
  const failed = await updateDependencies(f.checkout, { ...f.options, checkoutUpdate: async () => { throw Error('PRIVATE_GIT_REMOTE'); } });
  assert.ok(failed.warnings.includes('.rcs'));
  assert.equal(failed.npm[CORE], '2.0.0');
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE_GIT_REMOTE/);
});

test('Bigpowers updates filtered packages without changing filters, retries failures and skips current versions', async t => {
  const f = await fixture(t);
  const settings = { packages: ['npm:pi-subagents', { source: 'npm:bigpowers', extensions: [], themes: [] }] };
  await f.put(join(f.checkout, 'pi/settings.json'), settings);
  let attempts = 0;
  const options = { ...f.options, run: async (cmd, args, opts) => {
    if (cmd === process.execPath && args[2] === 'npm:bigpowers' && ++attempts === 1) throw Error('PRIVATE_PACKAGE_FAILURE');
    return f.options.run(cmd, args, opts);
  } };
  assert.ok((await updateDependencies(f.checkout, options)).warnings.includes('bigpowers'));
  assert.ok(!f.logs.join('\n').includes('PRIVATE_PACKAGE_FAILURE'));
  const state = await updateDependencies(f.checkout, options);
  assert.equal(attempts, 2);
  assert.equal(state.npm.bigpowers, '2.0.0');
  assert.deepEqual(state.warnings, []);
  await updateDependencies(f.checkout, options);
  assert.equal(attempts, 2, 'current version needs no reinstall');
  assert.deepEqual(JSON.parse(await readFile(join(f.checkout, 'pi/settings.json'), 'utf8')), settings);
});

test('all configured unpinned npm packages update, including scoped and filtered entries', async t => {
  const f = await fixture(t);
  const names = ['pi-mcp-adapter', 'pi-vim', 'pi-chrome', 'pi-knowledge', '@example/skills'];
  await f.put(join(f.checkout, 'pi/settings.json'), { packages: [
    ...names.map(name => `npm:${name}`), { source: 'npm:@example/skills', extensions: [] },
    'npm:pinned@1.0.0', 'npm:@example/pinned@1.0.0', 'git:github.com/example/skills@v1', './local',
  ] });
  const queried = [];
  const state = await updateDependencies(f.checkout, { ...f.options, npmLatest: async name => { queried.push(name); return '2.0.0'; } });
  const updated = f.calls.filter(([cmd, args]) => cmd === process.execPath && args[1] === 'update').map(([, args]) => args[2]);
  assert.deepEqual(updated, names.map(name => `npm:${name}`));
  for (const name of names) {
    assert.equal(queried.filter(value => value === name).length, 1);
    assert.equal(state.npm[name], '2.0.0');
  }
  assert.ok(!queried.includes('pinned') && !queried.includes('@example/pinned'));
  for (const [cmd, args, opts] of f.calls) if (cmd === process.execPath && args[1] === 'update') {
    assert.equal(opts.env.npm_config_ignore_scripts, args[2] === 'npm:pi-knowledge' ? 'false' : 'true');
  }
  assert.ok(!queried.some(name => /ast-grep|typescript|language-server/.test(name)));
});

test('shipped package sources preserve the stock memory pin and Bigpowers resource filters', async () => {
  const settings = JSON.parse(await readFile(new URL('../pi/settings.json', import.meta.url), 'utf8'));
  const sources = settings.packages.map(entry => typeof entry === 'string' ? entry : entry.source);
  assert.deepEqual(sources, ['npm:pi-subagents', 'npm:pi-mcp-adapter', 'npm:pi-vim', 'npm:pi-chrome', 'npm:bigpowers', 'npm:pi-context-view', 'npm:pi-memory@0.4.2', 'npm:pi-knowledge', 'npm:pi-condense']);
  assert.deepEqual(settings.packages.find(entry => entry.source === 'npm:bigpowers'), { source: 'npm:bigpowers', extensions: [], themes: [] });
});

test('absent and pinned Bigpowers are not queried or updated', async t => {
  const f = await fixture(t);
  for (const entry of [null, 'npm:bigpowers@2.88.2', { source: 'npm:bigpowers@2.88.2', extensions: [] }]) {
    await f.put(join(f.checkout, 'pi/settings.json'), { packages: entry ? [entry] : [] });
    const queried = [];
    await updateDependencies(f.checkout, { ...f.options, npmLatest: async name => { queried.push(name); return '2.0.0'; } });
    assert.ok(!queried.includes('bigpowers'));
    assert.ok(!queried.includes('pi-subagents'));
  }
  assert.ok(!f.calls.some(([cmd, args]) => cmd === process.execPath && args[1] === 'update'));
});

test('offline metadata keeps installed selections, failures retry and errors never expose provider output', async t => {
  const f = await fixture(t);
  await updateDependencies(f.checkout, f.options);
  f.calls.length = 0;
  const result = await updateDependencies(f.checkout, { ...f.options, npmLatest: async () => { throw Error('PRIVATE_ERROR_BODY'); }, rtkLatest: async () => { throw Error('PRIVATE_ERROR_BODY'); } });
  assert.equal(result.rtk.version, '2.0.0'); assert.equal(result.npm[CORE], '2.0.0');
  assert.ok(result.warnings.includes('RTK'));
  assert.ok(!f.logs.join('\n').includes('PRIVATE_ERROR_BODY'));
  assert.equal(effectiveRtk(f.checkout, f.agent).version, '2.0.0');
});

test('failed browser installation is retried without reinstalling unchanged npm package', async t => {
  const f = await fixture(t); let browser = 0;
  const options = { ...f.options, run: async (cmd, args, opts) => {
    if (cmd === 'playwright-cli' && ++browser === 1) throw Error('network failure');
    return f.options.run(cmd, args, opts);
  } };
  assert.ok((await updateDependencies(f.checkout, options)).warnings.includes('Chromium'));
  const state = await updateDependencies(f.checkout, options);
  assert.equal(browser, 2); assert.equal(state.chromium, '2.0.0'); assert.deepEqual(state.warnings, []);
});

test('invalid registry versions are not passed to installers', async t => {
  const f = await fixture(t);
  const result = await updateDependencies(f.checkout, { ...f.options, npmLatest: async () => 'latest; echo unsafe' });
  assert.ok(result.warnings.includes(CORE));
  assert.ok(!f.calls.some(([cmd, args]) => cmd === 'npm' && args[0] === 'install'));
});

test('update locking serializes launches, survives exceptions and rejects symlink state', async t => {
  const f = await fixture(t), dir = join(f.agent, 'updates');
  let release, entered;
  const started = new Promise(resolve => entered = resolve);
  const first = updateLock(dir, async () => { entered(); await new Promise(resolve => release = resolve); });
  await started;
  await assert.rejects(updateLock(dir, async () => assert.fail('must not overlap'), { waitMs: 1 }), /still running/);
  release(); await first;
  await assert.rejects(updateLock(dir, async () => { throw Error('fixture'); }), /fixture/);
  assert.equal(await updateLock(dir, async () => 'recovered'), 'recovered');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, 'lock.sqlite'));
  db.exec("INSERT INTO owner VALUES(1,2147483647,'dead-owner')"); db.close();
  assert.equal(await updateLock(dir, async () => 'dead owner recovered'), 'dead owner recovered');
  const destination = join(f.root, 'elsewhere'); await mkdir(destination);
  await symlink(destination, join(f.agent, 'linked'));
  await assert.rejects(updateLock(join(f.agent, 'linked'), async () => {}), /symlink/);
});

test('RTK discovery uses public stable releases and requires both unambiguous checksums', async () => {
  const urls = [];
  const checksum = name => `${'a'.repeat(64)}  ${name}\n`;
  let body = checksum('rtk-aarch64-apple-darwin.tar.gz') + checksum('rtk-x86_64-apple-darwin.tar.gz');
  let tag = 'v2.0.0';
  const request = async url => {
    urls.push(url);
    return url.endsWith('/latest') ? { ok: true, url: `https://github.com/rtk-ai/rtk/releases/tag/${tag}` } : { ok: true, text: async () => body };
  };
  assert.equal((await latestRtk(request)).version, '2.0.0');
  assert.ok(urls.every(url => url.startsWith('https://github.com/rtk-ai/rtk/releases/')));
  body += checksum('rtk-x86_64-apple-darwin.tar.gz');
  await assert.rejects(latestRtk(request), /unambiguous/);
  tag = 'v2.1.0-beta.1';
  await assert.rejects(latestRtk(request), /stable/);
});

test('RTK terminal launcher follows the same machine-local release without triggering upgrades', async t => {
  const f = await fixture(t);
  const binary = join(f.agent, 'tooling/rtk/2.0.0/rtk');
  await f.put(binary, '#!/bin/sh\nprintf "%s\\n" "$RTK_TELEMETRY_DISABLED" "$@"\n'); await chmod(binary, 0o700);
  await f.put(join(f.agent, 'updates/current.json'), { rtk: { version: '2.0.0' } });
  const launcher = new URL('../pi/rtk.mjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [launcher.pathname, 'gain', '--daily'], { env: { ...process.env, PI_CODING_AGENT_DIR: f.agent } });
  assert.equal(stdout, '1\ngain\n--daily\n');
});
