import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFilter } from '../pi/extensions/efficiency/output.ts';

const enabled = process.env.PI_RTK_LIVE === '1';
test('real checksum-pinned RTK filters stdin without hooks or another command execution', { skip: !enabled }, async t => {
  const pins = JSON.parse(await readFile(new URL('../pi/rtk.json', import.meta.url), 'utf8'));
  const binary = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'tooling/rtk', pins.version, 'rtk');
  const home = await mkdtemp(join(tmpdir(), 'pi RTK live ')); t.after(() => rm(home, { recursive: true, force: true }));
  const raw = Array.from({ length: 120 }, (_, i) => `src/components/representative-search-file.ts:${i + 1}:matching source line`).join('\n') + '\n';
  const filtered = await runFilter(binary, 'grep', raw, home, new AbortController().signal);
  assert.ok(filtered.trim()); assert.ok(Buffer.byteLength(filtered) < Buffer.byteLength(raw) / 2);
  console.log(`RTK grep fixture: ${Buffer.byteLength(raw)} → ${Buffer.byteLength(filtered)} bytes (before recovery metadata; not provider tokens).`);
  await assert.rejects(runFilter(binary, 'unknown-filter', raw, home, new AbortController().signal));
});
