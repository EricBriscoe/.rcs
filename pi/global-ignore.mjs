import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const begin = '# BEGIN rcs pi generated artifacts';
const end = '# END rcs pi generated artifacts';
const block = [begin,
  'specs/', '.bigpowers/', 'allure-results/',
  '**/.pi/subagents/', '**/.pi/npm/', '**/.pi/git/',
  '**/.pi/mcp-traces/', '**/.pi/mcp-oauth/',
  end].join('\n');

const config = spawnSync('git', ['config', '--global', '--path', '--get', 'core.excludesFile'], { encoding: 'utf8' });
if (config.error || ![0, 1].includes(config.status)) {
  throw config.error ?? new Error(`Cannot read global Git excludes: ${config.stderr}`);
}
const configured = config.stdout.trim();
if (config.status === 0 && !configured) throw new Error('Global core.excludesFile is empty; choose a path before running setup.');
const defaultPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'ignore');
const target = resolve(configured || (existsSync(defaultPath) ? defaultPath : join(homedir(), '.gitignore')));
const original = existsSync(target) ? readFileSync(target, 'utf8') : '';
const lines = original.split('\n');
const starts = lines.flatMap((line, i) => line.replace(/\r$/, '') === begin ? [i] : []);
const ends = lines.flatMap((line, i) => line.replace(/\r$/, '') === end ? [i] : []);
let updated;
if (starts.length === 0 && ends.length === 0) {
  updated = original + (original && !original.endsWith('\n') ? '\n' : '') + block + '\n';
} else {
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error(`Malformed managed ignore block in ${target}; left unchanged.`);
  }
  lines.splice(starts[0], ends[0] - starts[0] + 1, block);
  updated = lines.join('\n');
}
if (updated !== original) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, updated);
}
if (!configured) execFileSync('git', ['config', '--global', 'core.excludesFile', target]);
console.log(`Pi generated-artifact ignores reconciled in ${target}`);
