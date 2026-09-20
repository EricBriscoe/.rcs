import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { nativeEnvironment } from '../pi/native-resources.mjs';

const core = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const stock = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'npm/node_modules/pi-knowledge');
const live = process.env.PI_KNOWLEDGE_LIVE === '1';

for (const exercise of [false, true]) test(`stock pi-knowledge ${exercise ? 'local indexing and retrieval' : 'discovery and native runtime'}`, { skip: exercise && !live, timeout: exercise ? 240000 : 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-stock-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, 'agent'), cwd = join(root, 'project'), output = join(root, 'result.json'), probe = join(root, 'probe.ts');
  await mkdir(agent); await mkdir(cwd);
  const source = join(cwd, 'refresh.ts');
  const text = 'export function renewSessionToken() { return "Expired credentials are renewed with a refresh token."; }\n';
  await writeFile(source, text);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: exercise ? [] : [stock] }));
  assert.equal(JSON.parse(await readFile(join(stock, 'package.json'), 'utf8')).name, 'pi-knowledge');
  // Capture definitions only inside this isolated test. Production loads stock directly.
  await writeFile(probe, `import {writeFileSync} from 'node:fs';
    ${exercise ? `import knowledge from ${JSON.stringify(join(stock, 'extension.js'))};` : ''}
    export default function(pi) {
      const tools = new Map();
      ${exercise ? 'knowledge({...pi, registerTool: tool => { tools.set(tool.name, tool); pi.registerTool(tool); }});' : ''}
      pi.registerCommand('knowledge-probe', {handler: async (_args, ctx) => {
        const names = pi.getAllTools().map(t => t.name);
        ${exercise ? `
          const call = (name, args) => tools.get(name).execute('fixture', args, undefined, undefined, ctx);
          const plan = await call('knowledge_plan', {source:${JSON.stringify(cwd)}});
          const added = await call('knowledge_add', {source:${JSON.stringify(cwd)},name:'Synthetic fixture'});
          const fast = await call('knowledge_search', {query:'renewSessionToken',mode:'fast',diagnostics:true});
          const semantic = await call('knowledge_search', {query:'recover from expired login credentials',mode:'semantic',diagnostics:true});
          const symbols = await call('knowledge_symbol_search', {query:'renewSessionToken'});
          writeFileSync(${JSON.stringify(output)},JSON.stringify({names,plan,added,fast,semantic,symbols}));
        ` : `writeFileSync(${JSON.stringify(output)},JSON.stringify({names}));`}
      }});
    }`);
  const env = nativeEnvironment(root, { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent,
    PI_KNOWLEDGE_DIR: join(root, 'knowledge'), PI_KNOWLEDGE_WATCH: 'false', PI_KNOWLEDGE_EMBEDDING: 'local:multilingual-e5-small',
    // Models are reusable cache only; indexed source and DB remain temporary.
    PI_KNOWLEDGE_MODEL_CACHE_DIR: join(homedir(), '.cache/pi-knowledge-test-models'),
    PI_KNOWLEDGE_OFFLINE: exercise ? '' : 'true' });
  const pending = promisify(execFile)(process.execPath, [join(core, 'dist/cli.js'), '--offline', '--no-session', '-nc', '-ns', '-np', '--approve', '-e', probe, '-p', '/knowledge-probe'], { cwd, env, timeout: exercise ? 230000 : 25000 });
  pending.child.stdin.end();
  const { stdout, stderr } = await pending;
  assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module|Could not locate the bindings|Extension error/i);
  const result = JSON.parse(await readFile(output, 'utf8'));
  for (const name of ['knowledge_plan', 'knowledge_add', 'knowledge_search', 'knowledge_symbol_search', 'knowledge_status', 'knowledge_doctor']) assert.ok(result.names.includes(name), name);
  // Session-start initializes native SQLite, even without an LLM request.
  assert.ok((await readFile(join(root, 'knowledge/knowledge.db'))).length > 0);
  if (exercise) {
    assert.match(result.added.content[0].text, /Indexed.*Synthetic fixture/);
    for (const search of [result.fast, result.semantic]) {
      assert.ok(search.details.results.length > 0);
      assert.equal(search.details.results[0].file_path, 'refresh.ts');
    }
    assert.match(JSON.stringify(result.symbols), /renewSessionToken/);
    assert.equal(await readFile(source, 'utf8'), text);
  }
});
