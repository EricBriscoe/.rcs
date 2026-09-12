import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, lstat, rename, rm, readdir, chmod, realpath } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentDirectory, runtimeDependencies, stableVersion } from './extensions/efficiency/runtime.mjs';
import { installRtk } from './install-rtk.mjs';

const exec = promisify(execFile);
const CORE = '@earendil-works/pi-coding-agent', WEB = '@playwright/cli';
const LOCK = 'proper-lockfile';
const nameOf = spec => spec.slice(0, spec.lastIndexOf('@'));
async function versionAt(path) { try { return JSON.parse(await readFile(path, 'utf8')).version; } catch { return undefined; } }
async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw Error('Update state must not be a symlink.');
  await chmod(path, 0o700);
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'pi-rcs-updater', Accept: 'application/json' } });
  if (!response.ok) throw Error(`Dependency metadata unavailable: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw Error('Dependency metadata exceeds limit.');
  return JSON.parse(text);
}
export async function latestNpm(name) {
  const value = await json(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
  if (value.name !== name || !stableVersion(value.version)) throw Error('No stable npm release found.');
  return value.version;
}
export async function latestRtk(request = fetch) {
  // Public release redirect avoids GitHub API credentials/rate limits. Never log
  // the checksum download's temporary signed redirect URL.
  const release = await request('https://github.com/rtk-ai/rtk/releases/latest', { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  const url = new URL(release.url);
  const version = /^\/rtk-ai\/rtk\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(url.pathname)?.[1];
  if (!release.ok || url.hostname !== 'github.com' || !stableVersion(version)) throw Error('No stable RTK release found.');
  const response = await request(`https://github.com/rtk-ai/rtk/releases/download/v${version}/checksums.txt`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('RTK release checksums unavailable.');
  const text = await response.text();
  if (text.length > 65536) throw Error('RTK checksums exceed limit.');
  const entries = [...text.matchAll(/^([a-f0-9]{64})\s+\*?(\S+)$/gm)];
  const assets = {};
  for (const [platform, name] of Object.entries({ 'darwin-arm64': 'rtk-aarch64-apple-darwin.tar.gz', 'darwin-x64': 'rtk-x86_64-apple-darwin.tar.gz' })) {
    const matches = entries.filter(entry => entry[2] === name);
    if (matches.length !== 1) throw Error(`RTK release lacks an unambiguous SHA-256 digest for ${platform}.`);
    assets[platform] = { name, sha256: matches[0][1] };
  }
  return { version, assets };
}
async function command(command, args, options = {}) {
  return exec(command, args, { timeout: 180000, maxBuffer: 1024 * 1024, ...options, env: {
    ...process.env, ...options.env, PI_AUTO_UPDATE_ACTIVE: '1', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_fetch_retries: '0', npm_config_fetch_timeout: '15000',
  } });
}

// Called under the update lock. Never stash, switch branches, or resolve conflicts.
export async function updateCheckout(checkout, { run = command, log = message => console.error(message) } = {}) {
  // A launch from another Git worktree must still update the harness checkout.
  const env = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'].map(key => [key, undefined]));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10' });
  const git = async (...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', ...args], { cwd: checkout, env, timeout: 30000 })).stdout.trim();
  const skip = reason => { log(`[pi update] .rcs: skipped (${reason}); checkout left unchanged.`); return 'skipped'; };
  if (await realpath(await git('rev-parse', '--show-toplevel')) !== await realpath(checkout)) return skip('not the checkout root');
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '');
  if (!['main', 'master'].includes(branch)) return skip('not on main/master');
  if (await git('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none')) return skip('local changes');
  const gitDir = await git('rev-parse', '--absolute-git-dir');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
    try { await lstat(join(gitDir, marker)); return skip('Git operation in progress'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const upstream = await git('for-each-ref', '--format=%(upstream:remotename)%09%(upstream:remoteref)', `refs/heads/${branch}`);
  const [remote, ref] = upstream.split('\t');
  if (!remote || remote === '.' || ref !== `refs/heads/${branch}`) return skip('no matching remote upstream');
  const before = await git('rev-parse', 'HEAD');
  await git('pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules');
  const after = await git('rev-parse', 'HEAD');
  if (after !== before) log(`[pi update] .rcs → ${after.slice(0, 12)}`);
  return after === before ? 'unchanged' : 'updated';
}

// The lock covers updates, not the Pi session. Dead owners are recoverable without
// lease expiry stealing a slow install. No package manager is needed for this lock.
export async function updateLock(directory, fn, { waitMs = 240000 } = {}) {
  await privateDir(directory);
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(directory, 'lock.sqlite');
  for (const file of [path, path + '-wal', path + '-shm']) {
    try { if ((await lstat(file)).isSymbolicLink()) throw Error('Update lock must not be a symlink.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(path);
  await chmod(path, 0o600);
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER,token TEXT);');
  const token = randomUUID(), until = Date.now() + waitMs;
  let owned = false;
  try {
    while (!owned) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT pid FROM owner WHERE id=1').get();
        let alive = !!row;
        if (row) { try { process.kill(row.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; } }
        if (!alive) { db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?,?)').run(process.pid, token); owned = true; }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (!owned) {
        if (Date.now() >= until) throw Error('Another dependency update is still running; retry or use PI_AUTO_UPDATE=0.');
        await delay(200);
      }
    }
    return await fn();
  } finally {
    if (owned) db.prepare('DELETE FROM owner WHERE token=?').run(token);
    db.close();
  }
}

export async function updateNavigation(agent, baseline, versions, log = message => console.error(message)) {
  const directory = join(agent, 'code-navigation');
  let entries;
  try { entries = await readdir(join(directory, 'packages'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const installed = new Set(), installedSpecs = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
    try {
      const packages = JSON.parse(await readFile(join(directory, 'packages', entry.name, 'ready.json'), 'utf8'));
      for (const spec of packages) { installed.add(nameOf(spec)); installedSpecs.add(spec); }
    } catch { /* Incomplete installs are not installed tools. */ }
  }
  const { recipeCommand, astCommand } = await import('./extensions/code-navigation/packages.ts');
  const { NavState } = await import('./extensions/code-navigation/state.ts');
  const state = new NavState(directory);
  try {
    for (const recipe of Object.values(baseline.servers)) {
      if (!recipe.packages || !recipe.packages.some(spec => installed.has(nameOf(spec)))) continue;
      const packages = recipe.packages.map(spec => versions[nameOf(spec)] ? `${nameOf(spec)}@${versions[nameOf(spec)]}` : spec);
      if (packages.some(spec => !installedSpecs.has(spec))) log(`[pi update] navigation → ${packages.join(', ')}`);
      const command = await recipeCommand(directory, { ...recipe, packages });
      for (const spec of packages) installedSpecs.add(spec);
      const names = recipe.packages.map(nameOf).sort().join(',');
      const rows = state.db.prepare('SELECT root,id,config FROM servers').all();
      for (const row of rows) {
        const config = JSON.parse(row.config);
        // Only stock managed commands: leave custom/system servers and custom argv alone.
        const oldPackages = config.version?.split(', ') || [];
        const legacy = config.command?.[1]?.includes(`${sep}node_modules${sep}${recipe.package}${sep}`) &&
          JSON.stringify(config.command.slice(2)) === JSON.stringify(recipe.args || []);
        const nativeTypescript = recipe.package === 'typescript-language-server' && config.command?.[1]?.endsWith(`${sep}node_modules${sep}typescript${sep}bin${sep}tsc`) &&
          JSON.stringify(config.command.slice(2)) === JSON.stringify(['--lsp', '--stdio']);
        const managed = config.command?.[1]?.startsWith(join(directory, 'packages') + sep) &&
          oldPackages.map(nameOf).sort().join(',') === names && (legacy || nativeTypescript);
        if (managed && (config.version !== packages.join(', ') || JSON.stringify(config.command) !== JSON.stringify(command))) state.save(row.root, { ...config, command, version: packages.join(', ') });
      }
    }
    for (const [name, version] of Object.entries(versions)) if (name.startsWith('@ast-grep/cli-') && installed.has(name)) {
      if (!installedSpecs.has(`${name}@${version}`)) log(`[pi update] ast-grep → ${version}`);
      await astCommand(directory, version);
    }
  } finally { state.close(); }
}

export async function updateDependencies(checkout, { agent = agentDirectory(), npmLatest = latestNpm, rtkLatest = latestRtk, run = command, rtkInstall = installRtk, navigationInstall = updateNavigation, checkoutUpdate = updateCheckout, log = message => console.error(message), lock = updateLock } = {}) {
  const directory = join(agent, 'updates');
  return lock(directory, async () => {
    const previous = runtimeDependencies(agent), current = { ...previous, npm: { ...previous.npm } };
    const latest = {}, warnings = [];
    const warn = name => { warnings.push(name); log(`[pi update] ${name}: update unavailable/failed; continuing with installed dependencies. Use PI_AUTO_UPDATE=0 to bypass.`); };
    try { await checkoutUpdate(checkout, { run, log }); }
    catch { warn('.rcs'); }
    const baseline = JSON.parse(await readFile(join(checkout, 'pi/code-navigation.json'), 'utf8'));
    const ast = `@ast-grep/cli-${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`;
    const settings = JSON.parse(await readFile(join(checkout, 'pi/settings.json'), 'utf8'));
    const sources = (settings.packages || []).map(entry => typeof entry === 'string' ? entry : entry.source);
    // Follow stable releases for every unpinned npm package, including filtered
    // entries. Explicit versions/refs and local paths remain owner-managed.
    const packages = [...new Set(sources.flatMap(source => {
      const name = /^npm:((?:@[^/]+\/)?[^@/]+)$/.exec(source)?.[1];
      return name ? [name] : [];
    }))];
    const names = [...new Set([CORE, WEB, ...packages, LOCK, ast, ...Object.values(baseline.servers).flatMap(recipe => (recipe.packages || []).map(nameOf))])];
    await Promise.all(names.map(async name => {
      try { const version = await npmLatest(name); if (!stableVersion(version)) throw Error('Invalid version'); latest[name] = version; }
      catch { warn(name); }
    }));
    const { stdout } = await run('npm', ['root', '-g'], { cwd: directory });
    const global = stdout.trim(), env = { PI_CODING_AGENT_DIR: agent };
    const install = async (name, manifest, action) => {
      if (!latest[name]) return;
      try {
        if (await versionAt(manifest) !== latest[name]) { log(`[pi update] ${name} → ${latest[name]}`); await action(); }
        const actual = await versionAt(manifest);
        if (actual !== latest[name]) throw Error('Installed version differs from release');
        current.npm[name] = actual;
      } catch { warn(name); }
    };
    await install(CORE, join(global, CORE, 'package.json'), () => run('npm', ['install', '-g', '--ignore-scripts', `${CORE}@${latest[CORE]}`], { cwd: directory, env }));
    await install(WEB, join(global, WEB, 'package.json'), () => run('npm', ['install', '-g', '--ignore-scripts', `${WEB}@${latest[WEB]}`], { cwd: directory, env }));
    // Browser payload installation is retried after partial failures, independently of npm.
    if (current.npm[WEB] && previous.chromium !== current.npm[WEB]) {
      try { await run('playwright-cli', ['install-browser', 'chromium'], { cwd: directory, env: { ...env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' } }); current.chromium = current.npm[WEB]; }
      catch { warn('Chromium'); }
    }
    for (const name of packages) await install(name, join(agent, 'npm/node_modules', name, 'package.json'), () =>
      run(process.execPath, [join(global, CORE, 'dist/cli.js'), 'update', `npm:${name}`], { cwd: directory, env }));
    // --no-save/--package-lock=false keeps the bootstrap manifest and lockfile unchanged.
    const pool = join(checkout, 'pi/extensions/codex-account-pool');
    await install(LOCK, join(pool, 'node_modules', LOCK, 'package.json'), () => run('npm', ['install', '--ignore-scripts', '--no-save', '--package-lock=false', `${LOCK}@${latest[LOCK]}`], { cwd: pool, env }));
    const navigationNames = names.filter(name => ![CORE, WEB, ...packages, LOCK].includes(name));
    // Incomplete metadata must not downgrade one member of a coupled recipe to
    // its bootstrap version. Retry the group next launch instead.
    if (navigationNames.every(name => latest[name])) {
      const navigationVersions = Object.fromEntries(navigationNames.map(name => [name, latest[name]]));
      try { await navigationInstall(agent, baseline, navigationVersions, log); Object.assign(current.npm, navigationVersions); }
      catch { warn('managed navigation'); }
    }
    try {
      const pins = await rtkLatest();
      await rtkInstall(agent, pins);
      if (previous.rtk?.version !== pins.version) log(`[pi update] RTK → ${pins.version}`);
      current.rtk = pins;
    } catch { warn('RTK'); }
    current.checkedAt = new Date().toISOString(); current.warnings = warnings;
    const temporary = join(directory, `${randomUUID()}.json`);
    try { await writeFile(temporary, JSON.stringify(current, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, join(directory, 'current.json')); }
    finally { await rm(temporary, { force: true }); }
    return current;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await updateDependencies(dirname(dirname(fileURLToPath(import.meta.url))));
}
