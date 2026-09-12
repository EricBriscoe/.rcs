import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateDependencies, updateLock, updateNavigation, latestRtk } from '../pi/update-deps.mjs';
import { effectiveNavigation, effectiveRtk, autoUpdateEnabled } from '../pi/extensions/efficiency/runtime.mjs';
import { nativeEnvironment } from '../pi/native-resources.mjs';
import { NavState, digest } from '../pi/extensions/code-navigation/state.ts';

const CORE = '@earendil-works/pi-coding-agent', WEB = '@playwright/cli';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi auto update '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), agent = join(root, 'agent'), global = join(root, 'global');
  const baseline = { astGrepVersion: '1.0.0', servers: { typescript: { packages: ['typescript-language-server@1.0.0', 'typescript@1.0.0'], package: 'typescript-language-server', bin: 'typescript-language-server', args: ['--stdio'], languages: { '.ts': 'typescript' } }, go: { command: ['gopls'] } } };
  const put = async (file, value) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  await put(join(checkout, 'pi/settings.json'), { packages: ['npm:pi-subagents'] });
  await put(join(checkout, 'pi/code-navigation.json'), baseline);
  await put(join(checkout, 'pi/rtk.json'), { version: '1.0.0', assets: {} });
  const manifest = name => name === 'pi-subagents' ? join(agent, 'npm/node_modules', name, 'package.json') : name === 'proper-lockfile' ? join(checkout, 'pi/extensions/codex-account-pool/node_modules', name, 'package.json') : join(global, name, 'package.json');
  for (const name of [CORE, WEB, 'pi-subagents', 'proper-lockfile']) await put(manifest(name), { name, version: '1.0.0' });
  const calls = [], logs = []; let metadata = 0;
  const options = { agent, checkoutUpdate: async () => {}, npmLatest: async () => { metadata++; return '2.0.0'; }, rtkLatest: async () => ({ version: '2.0.0', assets: {} }),
    rtkInstall: async (_agent, pins) => { calls.push(['rtk', pins.version]); }, navigationInstall: async (_agent, _baseline, versions) => { calls.push(['navigation', versions]); },
    log: line => logs.push(line), run: async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      if (cmd === 'npm' && args[0] === 'root') return { stdout: global + '\n' };
      if (cmd === 'npm' && args[0] === 'install') {
        const spec = args.at(-1), at = spec.lastIndexOf('@');
        await put(manifest(spec.slice(0, at)), { name: spec.slice(0, at), version: spec.slice(at + 1) });
      }
      if (cmd === process.execPath && args[1] === 'update') await put(manifest('pi-subagents'), { name: 'pi-subagents', version: '2.0.0' });
      return { stdout: '' };
    },
  };
  return { root, checkout, agent, global, baseline, calls, logs, options, put, manifest, metadata: () => metadata };
}

test('every top-level launch checks; explicit bypass/offline/children never update', () => {
  assert.equal(autoUpdateEnabled([], {}), true);
  assert.equal(autoUpdateEnabled(['--version'], {}), true);
  for (const env of [{ PI_AUTO_UPDATE: '0' }, { PI_OFFLINE: '1' }, { PI_AUTO_UPDATE_ACTIVE: '1' }, { PI_SUBAGENT_CHILD: '1' }]) assert.equal(autoUpdateEnabled([], env), false);
  assert.equal(autoUpdateEnabled(['--offline'], {}), false);
});

test('real launcher invokes updater every time, bypasses it for repair and preserves stock argv', async t => {
  const f = await fixture(t), count = join(f.root, 'checks');
  for (const path of ['launch.mjs', 'native-resources.mjs', 'extensions/efficiency/runtime.mjs']) {
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
  await launch(['--version']); await launch(['--version']);
  assert.equal(await readFile(count, 'utf8'), 'check\ncheck\n');
  await launch(['--offline']); assert.equal(await readFile(count, 'utf8'), 'check\ncheck\n');
  await f.put(join(f.checkout, 'pi/update-deps.mjs'), `export async function updateDependencies(){throw Error('PRIVATE_UPDATER_FAILURE');}`);
  const failed = await launch(['--version']);
  assert.match(failed.stderr, /dependency update failed/); assert.doesNotMatch(failed.stderr, /PRIVATE_UPDATER_FAILURE/);
  assert.deepEqual(JSON.parse(failed.stdout).args, ['--version']);
});

test('updates only owned dependencies, uses stock package update and leaves checked-in definitions untouched', async t => {
  const f = await fixture(t);
  const paths = ['pi/settings.json', 'pi/code-navigation.json', 'pi/rtk.json'];
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
  assert.deepEqual(effectiveNavigation(f.checkout, f.agent).servers.typescript.packages, ['typescript-language-server@2.0.0', 'typescript@2.0.0']);
  assert.deepEqual(effectiveNavigation(f.checkout, f.agent).servers.go.command, ['gopls']);
  assert.ok(nativeEnvironment(f.checkout, { PI_CODING_AGENT_DIR: f.agent, PATH: '/usr/bin' }).PATH.startsWith(join(f.agent, 'tooling/rtk/2.0.0')));
  const count = f.metadata(); f.calls.length = 0;
  await updateDependencies(f.checkout, f.options);
  assert.equal(f.metadata(), count * 2, 'no daily TTL: check again immediately');
  assert.ok(!f.calls.some(([cmd, args]) => cmd === 'npm' && args[0] === 'install'));
  assert.ok(!f.calls.some(([cmd]) => cmd === process.execPath || cmd === 'playwright-cli'));
});

test('checkout sync runs under the lock before reading dependency definitions; failures are nonfatal', async t => {
  const f = await fixture(t);
  let locked = false, synced = false;
  const result = await updateDependencies(f.checkout, { ...f.options,
    lock: (directory, fn) => updateLock(directory, async () => { locked = true; try { return await fn(); } finally { locked = false; } }),
    checkoutUpdate: async (checkout) => {
      assert.equal(locked, true); assert.equal(checkout, f.checkout);
      await f.put(join(checkout, 'pi/code-navigation.json'), { servers: {} }); synced = true;
    },
    npmLatest: async () => { assert.equal(synced, true); return '2.0.0'; },
    navigationInstall: async (_agent, baseline) => assert.deepEqual(baseline, { servers: {} }),
  });
  assert.deepEqual(result.warnings, []);
  const failed = await updateDependencies(f.checkout, { ...f.options, checkoutUpdate: async () => { throw Error('PRIVATE_GIT_REMOTE'); } });
  assert.ok(failed.warnings.includes('.rcs'));
  assert.equal(failed.npm[CORE], '2.0.0');
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE_GIT_REMOTE/);
});

test('offline metadata keeps installed selections, failures retry and errors never expose provider output', async t => {
  const f = await fixture(t);
  await updateDependencies(f.checkout, f.options);
  f.calls.length = 0;
  const result = await updateDependencies(f.checkout, { ...f.options, npmLatest: async () => { throw Error('PRIVATE_ERROR_BODY'); }, rtkLatest: async () => { throw Error('PRIVATE_ERROR_BODY'); } });
  assert.equal(result.rtk.version, '2.0.0'); assert.equal(result.npm[CORE], '2.0.0');
  assert.ok(!f.calls.some(([cmd]) => cmd === 'navigation'), 'unavailable metadata must not downgrade coupled tooling');
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

test('navigation upgrades only installed managed recipes, preserves custom options and skips system/custom commands', async t => {
  const f = await fixture(t), dir = join(f.agent, 'code-navigation');
  const old = f.baseline.servers.typescript.packages, next = old.map(spec => spec.replace('1.0.0', '2.0.0'));
  async function installed(packages) {
    const root = join(dir, 'packages', digest(JSON.stringify([...packages].sort())).slice(0, 24));
    await f.put(join(root, 'ready.json'), packages);
    await f.put(join(root, 'node_modules/typescript-language-server/package.json'), { bin: { 'typescript-language-server': 'cli.mjs' } });
    await f.put(join(root, 'node_modules/typescript/package.json'), { bin: { tsc: 'bin/tsc' } });
    return join(root, 'node_modules/typescript-language-server/cli.mjs');
  }
  const before = await installed(old), after = await installed(next);
  const state = new NavState(dir); t.after(() => state.close());
  const config = { id: 'typescript', directory: '.', command: [process.execPath, before, '--stdio'], version: old.join(', '), languages: { '.ts': 'typescript' }, settings: { retained: true }, initializationOptions: { retained: true } };
  state.save(f.root, config);
  state.save(f.root, { ...config, id: 'custom', command: [process.execPath, before, '--custom'] });
  state.save(f.root, { id: 'system', directory: '.', command: ['gopls'], languages: { '.go': 'go' }, version: 'system' });
  await updateNavigation(f.agent, f.baseline, { 'typescript-language-server': '2.0.0', typescript: '2.0.0' });
  const upgraded = state.servers(f.root).find(row => row.id === 'typescript');
  assert.deepEqual(upgraded, { ...config, command: [process.execPath, after, '--stdio'], version: next.join(', ') });
  assert.equal(state.servers(f.root).find(row => row.id === 'custom').command.at(-1), '--custom');
  assert.deepEqual(state.servers(f.root).find(row => row.id === 'system').command, ['gopls']);
  for (const version of ['7.0.2', '8.0.0']) {
    const packages = ['typescript-language-server@6.0.0', `typescript@${version}`];
    const entry = await installed(packages);
    await updateNavigation(f.agent, f.baseline, { 'typescript-language-server': '6.0.0', typescript: version });
    const native = state.servers(f.root).find(row => row.id === 'typescript');
    assert.deepEqual(native.command, [process.execPath, join(entry, '../../typescript/bin/tsc'), '--lsp', '--stdio']);
    assert.equal(native.version, packages.join(', '));
  }
});
