// Deterministic stdio LSP fixture. Never calls a provider or modifies source files.
import { writeFileSync } from 'node:fs';
const pidFlag = process.argv.indexOf('--pid-file');
if (pidFlag >= 0) writeFileSync(process.argv[pidFlag + 1], String(process.pid));
let buffer = Buffer.alloc(0);
const documents = new Map(), events = [], waiting = new Map();
function send(value) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }));
  const framed = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  // Exercise fragmented headers and UTF-8 bodies.
  process.stdout.write(framed.subarray(0, 13)); process.stdout.write(framed.subarray(13));
}
function message(m) {
  if (!m.method) { const id = waiting.get(m.id); if (id !== undefined) { waiting.delete(m.id); send({ id, result: m.result ?? m.error }); } return; }
  if (m.method === 'initialize') return send({ id: m.id, result: { capabilities: { positionEncoding: 'utf-16', textDocumentSync: 2, definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true } } });
  if (m.method === 'shutdown') return send({ id: m.id, result: null });
  if (m.method === 'exit') return process.exit(0);
  if (m.method === 'test/hang') return;
  if (m.method === 'test/malformed') return process.stdout.write('Content-Length: nope\r\n\r\n{}');
  if (m.method === 'test/oversized') return process.stdout.write('Content-Length: 99999999\r\n\r\n');
  if (m.method === 'test/echo') return send({ id: m.id, result: m.params });
  if (m.method === 'test/events') return send({ id: m.id, result: events });
  if (m.method === 'test/request') { waiting.set('server', m.id); return send({ id: 'server', method: m.params.method, params: m.params.params }); }
  if (m.method === 'textDocument/didOpen') documents.set(m.params.textDocument.uri, m.params.textDocument.text);
  if (m.method === 'textDocument/didChange') {
    const uri = m.params.textDocument.uri, change = m.params.contentChanges[0];
    const old = documents.get(uri).split(/\r?\n/);
    if (change.range && (change.range.end.line !== old.length - 1 || change.range.end.character !== old.at(-1).length)) throw Error('Incorrect whole-document incremental range');
    documents.set(uri, change.text);
  }
  if (m.method === 'textDocument/didClose') documents.delete(m.params.textDocument.uri);
  if (m.id === undefined) { events.push(m); return; }
  const uri = m.params?.textDocument?.uri;
  if (m.method === 'textDocument/hover') return send({ id: m.id, result: { contents: '🦄 ' + documents.get(uri) } });
  if (m.method === 'textDocument/definition' || m.method === 'textDocument/references') {
    const text = documents.get(uri) || '', lines = text.split(/\r?\n/);
    const line = Math.max(0, lines.findIndex(line => line.includes('function')));
    const location = { uri, range: { start: { line, character: 0 }, end: { line, character: lines[line].length } } };
    return send({ id: m.id, result: m.method.endsWith('references') ? [location] : location });
  }
  if (m.method === 'textDocument/documentSymbol') return send({ id: m.id, result: [{ name: 'fixture', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } }] });
  if (m.method === 'workspace/symbol') return send({ id: m.id, result: [] });
  send({ id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } });
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const value = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size); message(value);
  }
});
