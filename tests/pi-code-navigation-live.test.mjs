import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { effectiveNavigation } from '../pi/extensions/efficiency/runtime.mjs';
import { fileURLToPath } from 'node:url';
import { Navigation } from '../pi/extensions/code-navigation/navigation.ts';
import { recipeCommand, astCommand } from '../pi/extensions/code-navigation/packages.ts';
import { structuralSearch } from '../pi/extensions/code-navigation/ast.ts';

// Opt-in uses locally selected versions, or bootstrap pins, in machine-local tooling.
// No model/API calls; source fixtures are disposable and never leave this Mac.
test('actual pinned TypeScript/Python LSP navigation and ast-grep search', { skip: process.env.PI_CODE_NAV_LIVE !== '1', timeout: 180000 }, async t => {
  const pins = effectiveNavigation(fileURLToPath(new URL('../', import.meta.url)));
  const tooling = process.env.PI_CODE_NAV_TOOLING_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'code-navigation');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi navigation live ')));
  const nav = new Navigation();
  t.after(async () => { await nav.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["*.ts"]}');
  await writeFile(join(root, 'library.ts'), 'export function greet(name: string): string { return name; }\n');
  await writeFile(join(root, 'main.ts'), 'import { greet } from "./library";\nconst icon = "🦄"; greet("world");\n');
  const ts = { id: 'typescript', directory: '.', initializationOptions: pins.servers.typescript.initializationOptions, languages: pins.servers.typescript.languages, command: await recipeCommand(tooling, pins.servers.typescript), version: 'pinned' };
  const column = 'const icon = "🦄"; '.length + 1;
  const query = { path: 'main.ts', line: 2, column, action: 'definition' };
  let definition = await nav.query(root, [ts], query);
  assert.equal(definition.result.locations[0].path, 'library.ts');
  assert.equal(definition.result.locations[0].line, 1);
  const refs = await nav.query(root, [ts], { ...query, action: 'references' });
  assert.ok(refs.result.locations.some(location => location.path === 'main.ts'));
  assert.match(JSON.stringify(await nav.query(root, [ts], { ...query, action: 'hover' })), /name: string/);
  // Open the dependency, then change it externally. Both documents must refresh.
  await nav.query(root, [ts], { path: 'library.ts', action: 'document_symbols' });
  await writeFile(join(root, 'library.ts'), '// moved\n\nexport function greet(name: string): string { return name; }\n');
  definition = await nav.query(root, [ts], query);
  assert.equal(definition.result.locations[0].line, 3);
  // A newly created, previously unopened caller must appear in references.
  await writeFile(join(root, 'extra.ts'), 'import { greet } from "./library";\ngreet("extra");\n');
  let fresh;
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(100);
    fresh = await nav.query(root, [ts], { ...query, action: 'references' });
    if (fresh.result.locations.some(location => location.path === 'extra.ts')) break;
  }
  assert.ok(fresh.result.locations.some(location => location.path === 'extra.ts'), 'reference index sees new files');

  await mkdir(join(root, 'python'));
  await writeFile(join(root, 'python/lib.py'), 'def greet(name: str) -> str:\n    return name\n');
  await writeFile(join(root, 'python/main.py'), 'from lib import greet\ngreet("hello")\n');
  const py = { id: 'python', directory: 'python', languages: pins.servers.python.languages, command: await recipeCommand(tooling, pins.servers.python), version: 'pinned' };
  const pyResult = await nav.query(root, [py], { path: 'python/main.py', line: 2, column: 1, action: 'definition' });
  assert.equal(pyResult.result.locations[0].path, 'python/lib.py');

  // Smoke-test the other managed recipes, rather than claiming untested
  // bootstrap defaults work just because their binaries exist.
  for (const [id, filename, text] of [
    ['bash', 'sample.sh', '#!/bin/bash\nhello() { echo hi; }\nhello\n'],
    ['html', 'sample.html', '<html><body><h1>Hello</h1></body></html>'],
    ['css', 'sample.css', 'body { color: red; }'],
    ['json', 'sample.json', '{"name":"fixture"}'],
    ['yaml', 'sample.yaml', 'name: fixture\n'],
  ]) {
    const recipe = pins.servers[id];
    await writeFile(join(root, filename), text);
    const config = { id, directory: '.', languages: recipe.languages, settings: recipe.settings, initializationOptions: recipe.initializationOptions, command: await recipeCommand(tooling, recipe), version: 'pinned' };
    const symbols = await nav.query(root, [config], { action: 'document_symbols', path: filename });
    assert.ok(Array.isArray(symbols.result.symbols), `${id} returns document symbols`);
    assert.ok(nav.entries.size <= 3, 'bounded resident language servers');
  }

  // Repository config must not be loaded (it can register native plugins).
  await writeFile(join(root, 'sgconfig.yml'), ': deliberately invalid repository config : [');
  const ast = await astCommand(tooling, pins.astGrepVersion);
  const matches = await structuralSearch(ast, root, { language: 'typescript', pattern: 'greet($$$ARGS)', limit: 10 });
  assert.ok(matches.matches.some(match => match.path === 'main.ts' && match.line === 2));
  const empty = await structuralSearch(ast, root, { language: 'typescript', pattern: 'absentFunction($$$ARGS)' });
  assert.equal(empty.matches.length, 0);
  const limited = await structuralSearch(ast, root, { language: 'typescript', pattern: 'greet($$$ARGS)', limit: 1 });
  assert.equal(limited.matches.length, 1); assert.equal(limited.truncated, true);
  assert.equal(await readFile(join(root, 'main.ts'), 'utf8'), 'import { greet } from "./library";\nconst icon = "🦄"; greet("world");\n');
});
