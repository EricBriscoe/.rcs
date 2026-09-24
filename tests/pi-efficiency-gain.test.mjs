import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gainRecorder, trackingPath } from '../pi/extensions/efficiency/gain.ts';

const config = '[tracking]\nenabled = true\nhistory_days = 90\n\n[display]\ncolors = true\n';
test('gain follows RTK platform defaults, environment and canonical config overrides; respects opt-out', () => {
  assert.equal(trackingPath(config, { HOME: '/home/test' }, 'darwin'), '/home/test/Library/Application Support/rtk/history.db');
  assert.equal(trackingPath(config, { HOME: '/home/test' }, 'linux'), '/home/test/.local/share/rtk/history.db');
  assert.equal(trackingPath(config, { XDG_DATA_HOME: '/data' }, 'linux'), '/data/rtk/history.db');
  assert.equal(trackingPath(config, { HOME: '/home/test', XDG_DATA_HOME: 'relative' }, 'linux'), '/home/test/.local/share/rtk/history.db');
  const override = config.replace('history_days = 90', 'database_path = "/custom/my db.sqlite"');
  assert.equal(trackingPath(override, {}, 'darwin'), '/custom/my db.sqlite');
  assert.equal(trackingPath(override, { RTK_DB_PATH: '/env.sqlite' }), '/env.sqlite');
  assert.equal(trackingPath(override.replace('enabled = true', 'enabled = false'), { RTK_DB_PATH: '/env.sqlite' }), undefined);
  assert.equal(trackingPath(override.replace('"/custom/my db.sqlite"', "'/custom/my db.sqlite'"), {}), '/custom/my db.sqlite');
  assert.throws(() => trackingPath('broken config', {}));
  assert.throws(() => trackingPath(override.replace('"/custom/my db.sqlite"', '"""\nmultiline\n"""'), {}));
});

async function fixture(t, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'pi gain '));
  const previous = { ...process.env };
  process.env.RTK_DB_PATH = join(root, 'history.db');
  process.env.PI_EFFICIENCY_SECRET_FIXTURE = 'must-not-leak';
  const db = new DatabaseSync(process.env.RTK_DB_PATH);
  db.exec(`CREATE TABLE commands (timestamp TEXT, original_cmd TEXT, rtk_cmd TEXT, project_path TEXT,
    input_tokens INTEGER, output_tokens INTEGER, saved_tokens INTEGER, savings_pct REAL, exec_time_ms INTEGER)`);
  const binary = join(root, 'rtk');
  await writeFile(binary, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(root, 'calls'))}, JSON.stringify({args:process.argv.slice(2),secret:process.env.PI_EFFICIENCY_SECRET_FIXTURE??null})+'\\n');
console.log(process.argv[2]==='config'?${JSON.stringify(config.replace('enabled = true', `enabled = ${enabled}`))}:'{}');`, { mode: 0o700 });
  t.after(async () => {
    db.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  return { root, db, binary, record: gainRecorder(() => binary), signal: new AbortController().signal };
}

test('only accepted reductions are recorded, with bounded labels, byte estimates and no raw data', async t => {
  const f = await fixture(t);
  assert.equal(await f.record('raw', 1000, 100, f.root, f.signal), true);
  assert.equal(await f.record('passing-tests', 100, 100, f.root, f.signal), true);
  assert.equal(await f.record('rtk:secret command', 1000, 100, f.root, f.signal), true);
  assert.equal(await f.record('passing-tests', NaN, 100, f.root, f.signal), true);
  await assert.rejects(readFile(join(f.root, 'calls')), { code: 'ENOENT' });
  assert.equal(await f.record('passing-tests', 1001, 103, f.root, f.signal), true);
  const rows = f.db.prepare('SELECT * FROM commands').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_tokens, 251);
  assert.equal(rows[0].output_tokens, 26);
  assert.equal(rows[0].saved_tokens, 225);
  assert.equal(rows[0].rtk_cmd, 'pi passing-tests');
  assert.equal(rows[0].original_cmd, 'pi tool output');
  assert.equal(rows[0].exec_time_ms, 0, 'unknown original command duration is not invented');
  await Promise.all(Array.from({ length: 4 }, () => f.record('grouped-grep', 1000, 100, f.root, f.signal)));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM commands').get().n, 5);
  const calls = (await readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [{ args: ['config'], secret: null }, { args: ['gain', '--format', 'json'], secret: null }]);
});

test('tracking disabled performs no database initialization or insert', async t => {
  const f = await fixture(t, false);
  assert.equal(await f.record('passing-tests', 1000, 100, f.root, f.signal), true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM commands').get().n, 0);
  const calls = (await readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c => c.args), [['config']]);
});

test('unavailable binary, cancellation, locked/missing/incompatible database fail safely', async t => {
  const f = await fixture(t);
  assert.equal(await gainRecorder(() => join(f.root, 'absent'))('passing-tests', 1000, 100, f.root, f.signal), false);
  assert.equal(await f.record('passing-tests', 1000, 100, f.root, AbortSignal.abort()), false);
  assert.equal(await f.record('passing-tests', 1000, 100, f.root, f.signal), true);
  f.db.exec('BEGIN EXCLUSIVE');
  try { assert.equal(await f.record('passing-tests', 1000, 100, f.root, f.signal), false); }
  finally { f.db.exec('ROLLBACK'); }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM commands').get().n, 1);
  f.db.exec('DROP TABLE commands');
  assert.equal(await f.record('passing-tests', 1000, 100, f.root, f.signal), false);
  await rm(process.env.RTK_DB_PATH);
  assert.equal(await f.record('passing-tests', 1000, 100, f.root, f.signal), false);
});

test('symlink database is rejected before RTK can initialize it', async t => {
  const f = await fixture(t);
  const link = join(f.root, 'linked.db');
  await symlink(process.env.RTK_DB_PATH, link);
  process.env.RTK_DB_PATH = link;
  assert.equal(await f.record('passing-tests', 1000, 100, f.root, f.signal), false);
  const calls = (await readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c => c.args), [['config']]);
});
