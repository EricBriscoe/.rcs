import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NavState, inventory, target, projectRoot } from '../pi/extensions/code-navigation/state.ts';
import { installPackages } from '../pi/extensions/code-navigation/packages.ts';
import { LspClient } from '../pi/extensions/code-navigation/lsp.ts';
import { Navigation, results, bounded } from '../pi/extensions/code-navigation/navigation.ts';
import { structuralSearch } from '../pi/extensions/code-navigation/ast.ts';

const server = fileURLToPath(new URL('./fixtures/lsp-server.mjs', import.meta.url));
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi navigation ')));
  const root = join(temp, 'project'), stateDir = join(temp, 'state');
  await mkdir(root); const state = new NavState(stateDir);
  const nav = new Navigation();
  t.after(async () => { await nav.close(); state.close(); await rm(temp, { recursive: true, force: true }); });
  const config = { id: 'fixture', command: [process.execPath, server], directory: '.', languages: { '.ts': 'typescript' }, version: 'fixture' };
  return { temp, root, stateDir, state, nav, config };
}

test('assessment is persisted per canonical workspace and invalidated by languages/manifests, not routine edits', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'main.ts'), 'function hello() {}');
  await writeFile(join(f.root, 'package.json'), '{"private":true}');
  const first = await inventory(f.root);
  assert.equal(first.kinds['.ts'].count, 1);
  assert.throws(() => f.state.complete(f.root, first, 'assessed', {}), /\.ts/);
  f.state.save(f.root, f.config);
  f.state.complete(f.root, first, 'TS configured; no JSON navigation needed', { '.json': 'manifest only' });
  const other = new NavState(f.stateDir);
  assert.equal(other.assessment(f.root).fingerprint, first.fingerprint); other.close();
  assert.equal(f.state.assessment(join(f.temp, 'other')), undefined);
  assert.equal((await stat(join(f.stateDir, 'state.sqlite'))).mode & 0o777, 0o600);
  await writeFile(join(f.root, 'main.ts'), '// a change\nfunction hello() {}');
  assert.equal((await inventory(f.root)).fingerprint, first.fingerprint);
  await writeFile(join(f.root, 'package.json'), '{"private":true,"type":"module"}');
  assert.notEqual((await inventory(f.root)).fingerprint, first.fingerprint);
  await writeFile(join(f.root, 'new.py'), 'def example(): pass');
  const next = await inventory(f.root);
  assert.throws(() => f.state.complete(f.root, next, 'not actually complete', { '.json': 'manifest only' }), /\.py/);
  f.state.complete(f.root, next, 'Python unavailable; fallback explicitly recorded', { '.json': 'manifest only', '.py': 'Unsupported in fixture; use grep' });
  f.state.remove(f.root, 'fixture'); assert.equal(f.state.assessment(f.root), undefined);
});

test('paths are canonical, symlink escapes fail, nested server coverage cannot stand in for the whole language', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'nested')); await writeFile(join(f.root, 'nested/a.ts'), 'a');
  await writeFile(join(f.root, 'outside.ts'), 'b'); await writeFile(join(f.temp, 'private.ts'), 'private');
  await symlink(join(f.temp, 'private.ts'), join(f.root, 'escape.ts'));
  await assert.rejects(target(f.root, 'escape.ts'), /escapes/);
  await assert.rejects(target(f.root, '../private.ts'), /escapes/);
  assert.equal(await projectRoot(f.root, true), f.root);
  f.state.save(f.root, { ...f.config, directory: 'nested' });
  await writeFile(join(f.root, '__proto__'), 'source metadata');
  await writeFile(join(f.root, 'constructor'), 'source metadata');
  const scan = await inventory(f.root);
  assert.equal(scan.otherKinds.__proto__.count, 1);
  assert.equal(Object.prototype.count, undefined);
  assert.throws(() => f.state.complete(f.root, scan, 'all done', {}), /\.ts/);
});

test('tooling leases are exclusive, fenced, released and require exact package pins', async t => {
  const f = await fixture(t), second = new NavState(f.stateDir);
  t.after(() => second.close());
  assert.equal(f.state.claimInstall('packages', 'first'), true);
  assert.equal(second.claimInstall('packages', 'second'), false);
  second.releaseInstall('packages', 'second');
  assert.equal(second.claimInstall('packages', 'second'), false);
  f.state.releaseInstall('packages', 'first');
  assert.equal(second.claimInstall('packages', 'second'), true);
  await assert.rejects(installPackages(f.stateDir, ['bad@latest']), /exact versions/);
  await assert.rejects(installPackages(f.stateDir, ['https://untrusted/script']), /exact versions/);
});

test('LSP framing handles Unicode, cancellation, errors and denies server-initiated edits/commands', async t => {
  const f = await fixture(t);
  const entry = await f.nav.start(f.root, f.config);
  assert.deepEqual(await entry.client.request('test/echo', { text: '🦄 café' }), { text: '🦄 café' });
  assert.deepEqual(await entry.client.request('test/request', { method: 'workspace/applyEdit', params: { edit: {} } }), { applied: false, failureReason: 'Read-only navigation client.' });
  assert.equal((await entry.client.request('test/request', { method: 'workspace/executeCommand', params: {} })).code, -32601);
  const abort = new AbortController();
  const hanging = entry.client.request('test/hang', {}, abort.signal); abort.abort();
  await assert.rejects(hanging, /cancelled/);
  assert.equal(entry.client.pending.size, 0);
  await assert.rejects(entry.client.request('test/hang', {}, undefined, 20), /timed out/);
  assert.ok((await entry.client.request('test/events', {})).some(e => e.method === '$/cancelRequest'));
});

test('malformed and oversized LSP frames fail outstanding work and terminate the server', async t => {
  const f = await fixture(t);
  for (const method of ['test/malformed', 'test/oversized']) {
    const client = new LspClient(f.config.command, f.root);
    await assert.rejects(client.request(method, {}), /Content-Length|8 MB/);
    await client.close(); assert.equal(client.pending.size, 0); assert.equal(client.didExit, true);
  }
});

test('LSP refreshes full and incremental documents after local edits and forwards file create/delete events', async t => {
  const f = await fixture(t), path = join(f.root, 'code.ts');
  await writeFile(path, 'function alpha() { return "🦄"; }\r\nalpha();\r\n');
  const query = { action: 'definition', path: 'code.ts', line: 2, column: 1 };
  assert.equal((await f.nav.query(f.root, [f.config], query)).result.locations[0].line, 1);
  await writeFile(path, '// changed outside Pi\r\nfunction alpha() {}\r\nalpha();\r\n');
  assert.equal((await f.nav.query(f.root, [f.config], { ...query, line: 3 })).result.locations[0].line, 2);
  const entry = [...f.nav.entries.values()][0];
  let events = await entry.client.request('test/events', {});
  const changed = events.find(e => e.method === 'textDocument/didChange');
  assert.equal(changed.params.contentChanges[0].range.end.line, 2);
  assert.equal(changed.params.textDocument.version, 2);
  await writeFile(join(f.root, 'added.ts'), 'export const added = 1'); await delay(100);
  await f.nav.query(f.root, [f.config], { ...query, line: 3 });
  await rm(join(f.root, 'added.ts')); await delay(100);
  await f.nav.query(f.root, [f.config], { ...query, line: 3 });
  events = await entry.client.request('test/events', {});
  assert.ok(events.some(e => e.method === 'workspace/didChangeWatchedFiles' && e.params.changes.some(c => c.uri.endsWith('/added.ts') && c.type === 3)));
  entry.capabilities.textDocumentSync = 1;
  await writeFile(path, 'function updated() {}\nupdated();\n');
  await f.nav.query(f.root, [f.config], query);
  events = await entry.client.request('test/events', {});
  assert.equal(events.filter(e => e.method === 'textDocument/didChange').at(-1).params.contentChanges[0].range, undefined, 'full sync has no incremental range');
  await assert.rejects(f.nav.query(f.root, [f.config], { ...query, column: 999 }), /UTF-16/);
  await assert.rejects(f.nav.query(f.root, [f.config], { ...query, action: 'implementation' }), /does not support/);
  await f.nav.close(); assert.equal(entry.client.didExit, true); assert.equal(f.nav.entries.size, 0);
});

test('location links, hierarchical outlines and output limits stay compact without opening external paths', () => {
  const range = { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } };
  const link = { targetUri: pathToFileURL('/elsewhere/library.ts').href, targetSelectionRange: range };
  assert.deepEqual(results('definition', [link], '/project', 1).locations[0], { path: '/elsewhere/library.ts', external: true, line: 2, column: 5, endLine: 2, endColumn: 11 });
  const symbol = { name: 'outer', kind: 5, range, selectionRange: range, children: [{ name: 'inner', kind: 12, range, selectionRange: range }] };
  assert.equal(results('document_symbols', [symbol], '/project', 2).symbols[0].children[0].name, 'inner');
  assert.equal(results('document_symbols', [symbol], '/project', 2).truncated, false);
  assert.equal(results('document_symbols', [symbol], '/project', 1).truncated, true);
  assert.equal(results('hover', { contents: 'type', range }, '/project', 10).range.line, 2);
  assert.match(bounded({ text: 'x'.repeat(500) }, 100), /Truncated/);
  assert.equal(bounded({ text: 'x'.repeat(500) }, 100).length, 100);
});

test('structural search uses literal argv, rejects escapes/bad streams, and cancels owned processes', async t => {
  const f = await fixture(t), cli = join(f.temp, 'ast-fixture'), captured = join(f.temp, 'argv.json');
  await writeFile(join(f.root, 'code.ts'), 'call();');
  const output = { file: 'code.ts', range: { start: { line: 0, column: 0 }, end: { line: 0, column: 6 } }, text: 'call()' };
  await writeFile(cli, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(JSON.stringify(output))});\n`, { mode: 0o755 });
  const found = await structuralSearch(cli, f.root, { language: 'typescript', pattern: 'call($$$ARGS) --rewrite BAD', glob: '--update-all' });
  assert.equal(found.matches[0].path, 'code.ts');
  const args = JSON.parse(await readFile(captured, 'utf8'));
  assert.ok(args.includes('--pattern=call($$$ARGS) --rewrite BAD'));
  assert.ok(args.includes('--globs=--update-all'));
  assert.ok(args.some(arg => arg.includes('code-navigation/sgconfig.yml')));
  assert.ok(!args.includes('--rewrite') && !args.includes('--update-all'));
  await assert.rejects(structuralSearch(cli, f.root, { language: '--rewrite', pattern: 'x' }), /Specify/);
  await writeFile(cli, `#!${process.execPath}\nprocess.stdout.write('not JSON');\n`, { mode: 0o755 });
  await assert.rejects(structuralSearch(cli, f.root, { language: 'typescript', pattern: 'x' }), /Incomplete/);
  await writeFile(cli, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`, { mode: 0o755 });
  const controller = new AbortController();
  const pending = structuralSearch(cli, f.root, { language: 'typescript', pattern: 'x' }, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(structuralSearch(cli, f.root, { language: 'typescript', pattern: 'x', path: '..' }), /escapes/);
});
