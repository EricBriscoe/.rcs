import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { installMemoryEmbedding } from '../pi/install-memory-embedding.mjs';
import { MODEL, embeddingHome } from '../pi/extensions/memory/embedding-config.mjs';

test('setup pins exact local-only dependencies and model bytes, rejects corrupt downloads, and cleans only its temporary install', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-embedding-install-')), bin = join(root, 'bin'); mkdirSync(bin);
  const script = join(bin, 'npm');
  writeFileSync(script, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + root + '/npm-args"\n'); chmodSync(script, 0o700);
  const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
  t.after(() => { process.env.PATH = previous; rmSync(root, { recursive: true, force: true }); });
  const agent = join(root, 'agent');
  const calls = [];
  await assert.rejects(installMemoryEmbedding(agent, async (url, options) => {
    calls.push(url); assert.ok(options.signal);
    return new Response('not the pinned model');
  }), /checksum/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(MODEL.revision));
  assert.deepEqual(readFileSync(join(root, 'npm-args'), 'utf8').trim().split('\n'), ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']);
  assert.deepEqual(readdirSync(join(embeddingHome(agent), '..')), []);
  const manifest = JSON.parse(readFileSync(new URL('../pi/extensions/memory/embedding-runtime/package.json', import.meta.url)));
  assert.deepEqual(manifest.dependencies, { '@huggingface/transformers': '4.2.0' });
  assert.deepEqual(manifest.overrides, { sharp: '0.35.4', 'adm-zip': '0.6.0' });
  assert.equal(Object.values(MODEL.files).reduce((n, f) => n + f.bytes, 0), 23685172);
  assert.equal(MODEL.dimensions, 384);
});

test('setup refuses symlink tooling before touching its target', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-embedding-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'), target = join(root, 'target'); mkdirSync(agent); mkdirSync(target);
  symlinkSync(target, join(agent, 'tooling'));
  await assert.rejects(installMemoryEmbedding(agent, async () => { throw Error('must not download'); }), /symlink/);
  assert.deepEqual(readdirSync(target), []);
});

test('completed machine-local setup validates pins and reruns without network/downloads', { skip: !process.env.PI_MEMORY_EMBEDDING_AGENT }, async () => {
  assert.equal(await installMemoryEmbedding(process.env.PI_MEMORY_EMBEDDING_AGENT, async () => { throw Error('Unexpected download'); }), embeddingHome(process.env.PI_MEMORY_EMBEDDING_AGENT));
});
