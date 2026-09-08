import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  addAccount, eligibleAccounts, emptyState, isModelAccessError, loginAndAdd,
  isQuotaExhaustion, markExhausted, quotaResetAt, readPoolState, replaceAccountCredentials,
  resolveAccount, shouldFailover, updatePoolState,
} from "../pi/extensions/codex-account-pool/pool.mjs";
import { compactQuota, formatQuota, normalizeQuotaPayload, QUOTA_STALE_AFTER_MS, quotaFreshness } from "../pi/extensions/codex-account-pool/quota.mjs";
import { createFooterController, MAX_TIMER_DELAY_MS, nextFooterUpdateMs } from "../pi/extensions/codex-account-pool/footer.mjs";

const exec = promisify(execFile);
const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent/dist/cli.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-pool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "agent", "codex-account-pool", "state.json");
  return { root, path };
}

function account(label, accountId = label, expires = Date.now() + 86_400_000) {
  return { label, accountId, access: `fixture-access-${label}`, refresh: `fixture-refresh-${label}`, expires, enabled: true };
}

test("cancelled login leaves account storage unchanged", async t => {
  const { path } = await fixture(t);
  await assert.rejects(loginAndAdd("cancelled", async () => { throw new Error("Login cancelled"); }, path), /Login cancelled/);
  assert.deepEqual(await readPoolState(path), emptyState());
});

test("priority, quota reset, and model compatibility routing are deterministic", async t => {
  const { path } = await fixture(t);
  await updatePoolState(state => { state.enabled = true; state.accounts.push(account("first"), account("second")); }, path);
  assert.deepEqual(eligibleAccounts(await readPoolState(path)).map(value => value.label), ["first", "second"]);
  const reset = quotaResetAt(JSON.stringify({ error: { resets_at: 77 } }), { "retry-after": "9" }, 1_000);
  assert.equal(reset, 77_000, "structured reset is authoritative over rounded retry data");
  assert.equal(quotaResetAt("unstructured", { "retry-after-ms": "250" }, 1_000), 1_250);
  await markExhausted("first", reset, path);
  assert.deepEqual(eligibleAccounts(await readPoolState(path), 2_000).map(value => value.label), ["second"]);
  assert.deepEqual(eligibleAccounts(await readPoolState(path), reset).map(value => value.label), ["first", "second"]);
  assert.equal(isModelAccessError("The model is not available for this account"), true);
  assert.equal(shouldFailover({ started: false, status: 429, message: "GoUsageLimitError: quota exceeded" }), true);
  assert.equal(shouldFailover({ started: true, status: 429, message: "GoUsageLimitError: quota exceeded" }), false, "never replay partial streams/tools");
  assert.equal(shouldFailover({ started: false, status: 429, message: "rate limit exceeded" }), false, "throttling is not quota exhaustion");
  assert.equal(isQuotaExhaustion(JSON.stringify({ error: { code: "usage_limit_reached" } }), 429), true);
  assert.equal(isQuotaExhaustion(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), 429), false);
  assert.equal(shouldFailover({ started: false, status: 401, message: "unauthorized" }), false, "authentication never rotates");
  assert.equal(shouldFailover({ started: false, aborted: true, status: 429, message: JSON.stringify({ error: { code: "usage_limit_reached" } }) }), false, "aborted requests never rotate");
  assert.equal(isQuotaExhaustion(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "temporary quota exceeded" } }), 429), false, "explicit throttle code wins over broad message text");
});

test("explicit re-login preserves account settings and rejects a changed identity", async t => {
  const { path } = await fixture(t);
  await updatePoolState(state => {
    state.enabled = true;
    state.accounts.push({ ...account("work", "account-1"), enabled: false, exhausted: true, resetAt: 99, quota: { fetchedAt: 1, windows: [] } });
  }, path);
  await replaceAccountCredentials("work", { accountId: "account-1", access: "new-access", refresh: "new-refresh", expires: 2 }, path);
  const replaced = (await readPoolState(path)).accounts[0];
  assert.deepEqual({ label: replaced.label, accountId: replaced.accountId, enabled: replaced.enabled, exhausted: replaced.exhausted, resetAt: replaced.resetAt, quota: replaced.quota }, { label: "work", accountId: "account-1", enabled: false, exhausted: true, resetAt: 99, quota: { fetchedAt: 1, windows: [] } });
  assert.equal(replaced.access, "new-access");
  await assert.rejects(replaceAccountCredentials("work", { accountId: "other", access: "x", refresh: "y", expires: 3 }, path), /same ChatGPT account/);
});

test("quota displays official usage windows without token-budget inference", () => {
  const quota = normalizeQuotaPayload({
    rate_limit: { allowed: true, primary_window: { used_percent: 42, limit_window_seconds: 300, reset_at: 1_700_000_000 }, secondary_window: { used_percent: 5, limit_window_seconds: 10_080, reset_at: 1_700_050_000 } },
    additional_rate_limits: [{ metered_feature: "codex_other", rate_limit: { primary_window: { used_percent: 80, limit_window_seconds: 60, reset_at: 1_700_010_000 } } }],
  }, 1_699_999_000_000);
  assert.equal(quota.ordinaryUsageAllowed, true);
  assert.deepEqual(quota.windows.map(window => window.limitId), ["codex", "codex_other"]);
  assert.match(formatQuota(quota, 1_699_999_001_000), /58% left.*95% left.*20% left/);
  assert.match(compactQuota(quota, 1_699_999_001_000), /58% left/);
  assert.deepEqual(quotaFreshness(undefined), { state: "unknown" });
  assert.match(formatQuota(quota, 1_700_000_000_001), /stale/);
  assert.doesNotMatch(formatQuota(quota), /token|budget/i);
});

test("atomic storage serializes concurrent writes and refreshes", async t => {
  const { path } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => addAccount(`account-${index}`, account(`account-${index}`), path)));
  const stored = await readPoolState(path);
  assert.equal(stored.accounts.length, 12);
  await updatePoolState(state => { state.enabled = true; state.accounts = [account("refresh", "refresh", 0)]; }, path);
  let refreshes = 0;
  const oauth = { async refresh(credential) { refreshes++; return { ...credential, access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 86_400_000 }; } };
  await Promise.all(Array.from({ length: 8 }, () => resolveAccount("refresh", oauth, undefined, path)));
  assert.equal(refreshes, 1, "one cross-process-style lock owner refreshes rotated credentials");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
});

test("compromised lock aborts a suspended refresh and never persists rotated credentials", { timeout: 10000 }, async t => {
  const { path } = await fixture(t);
  await updatePoolState(state => { state.enabled = true; state.accounts.push(account("refresh", "refresh", 0)); }, path);
  let entered;
  let resume;
  let refreshSignal;
  const pending = resolveAccount("refresh", {
    async refresh(credential, signal) {
      refreshSignal = signal;
      entered();
      await new Promise(resolve => { resume = resolve; });
      return { ...credential, access: "rotated-access", refresh: "rotated-refresh", expires: Date.now() + 86_400_000 };
    },
  }, undefined, path);
  await new Promise(resolve => { entered = resolve; });
  await rm(`${path}.lock`, { recursive: true, force: true });
  const deadline = Date.now() + 4_000;
  while (!refreshSignal?.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(refreshSignal?.aborted, true, "ownership loss aborts the in-flight refresh signal");
  resume();
  await assert.rejects(pending, /lock ownership was lost/);
  const stored = (await readPoolState(path)).accounts[0];
  assert.equal(stored.access, "fixture-access-refresh");
  assert.equal(stored.refresh, "fixture-refresh-refresh");
});

test("expired enabled credentials refresh exactly once across concurrent processes", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const count = join(root, "refresh-count");
  const moduleUrl = pathToFileURL(join(checkout, "pi/extensions/codex-account-pool/pool.mjs")).href;
  await updatePoolState(state => { state.enabled = true; state.accounts.push(account("refresh", "refresh", 0)); }, path);
  const worker = `import {readFile,writeFile} from 'node:fs/promises'; import {resolveAccount} from ${JSON.stringify(moduleUrl)}; const path=${JSON.stringify(path)}, count=${JSON.stringify(count)}; const oauth={refresh:async credential=>{let n=0;try{n=Number(await readFile(count,'utf8'))}catch{};await writeFile(count,String(n+1)); return {...credential,access:'rotated',refresh:'rotated-refresh',expires:4102444800000}}}; await resolveAccount('refresh',oauth,undefined,path);`;
  const runWorker = () => new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ["--input-type=module", "-e", worker], { stdio: "ignore" });
    childProcess.once("error", reject);
    childProcess.once("exit", code => code === 0 ? resolve(undefined) : reject(new Error("refresh worker exited " + code)));
  });
  await Promise.all([runWorker(), runWorker()]);
  assert.equal(await readFile(count, "utf8"), "1");
  const stored = (await readPoolState(path)).accounts[0];
  assert.equal(stored.access, "rotated");
  assert.equal(stored.expires, 4_102_444_800_000);
});

test("simultaneous recoverers cannot steal a live replacement lock", { timeout: 30000 }, async t => {
  const { path } = await fixture(t);
  const moduleUrl = pathToFileURL(join(checkout, "pi/extensions/codex-account-pool/pool.mjs")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { updatePoolState } from ${JSON.stringify(moduleUrl)}; await updatePoolState(async () => { console.log('locked'); await new Promise(() => {}); }, ${JSON.stringify(path)});`], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", value => value.toString().includes("locked") ? resolve() : reject(new Error("lock child did not acquire lock")));
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`lock child exited early (${code}, ${signal})`)));
  });
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("exit", resolve));
  const worker = `import { updatePoolState } from ${JSON.stringify(moduleUrl)}; await updatePoolState(state => { state.recovered = (state.recovered || 0) + 1; }, ${JSON.stringify(path)});`;
  const runWorker = () => new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ["--input-type=module", "-e", worker], { stdio: "ignore" });
    childProcess.once("error", reject);
    childProcess.once("exit", code => code === 0 ? resolve(undefined) : reject(new Error("recoverer exited " + code)));
  });
  await Promise.all([runWorker(), runWorker()]);
  assert.equal((await readPoolState(path)).recovered, 2);
});

test("footer timing uses millisecond reset deadlines and exact stale boundaries", () => {
  const now = 1_000_000;
  assert.equal(nextFooterUpdateMs({ accounts: [{ resetAt: now + 250 }] }, now), 250);
  assert.equal(nextFooterUpdateMs({ accounts: [{ quota: { fetchedAt: now - QUOTA_STALE_AFTER_MS + 1 } }] }, now), 1);
  assert.equal(quotaFreshness({ fetchedAt: now - QUOTA_STALE_AFTER_MS, windows: [] }, now).state, "stale");
  assert.equal(nextFooterUpdateMs({ accounts: [{ quota: { fetchedAt: now - QUOTA_STALE_AFTER_MS } }] }, now), undefined);
  assert.equal(nextFooterUpdateMs({ accounts: [{ resetAt: now + MAX_TIMER_DELAY_MS + 10_000 }] }, now), MAX_TIMER_DELAY_MS);
});

test("footer shutdown invalidates a suspended read before stale context UI access", async () => {
  let completeRead;
  const rendered = [];
  const timers = [];
  const footer = createFooterController({
    readState: () => new Promise(resolve => { completeRead = resolve; }),
    statusLine: () => "active",
    renderStatus(ctx, value) { rendered.push([ctx.name, value]); },
    setTimer: (...args) => { timers.push(args); return 1; },
    clearTimer: () => {},
  });
  const pending = footer.update({ name: "stale" });
  footer.shutdown({ name: "shutdown" });
  completeRead({ enabled: true, accounts: [] });
  await pending;
  assert.deepEqual(rendered, [["shutdown", undefined]]);
  assert.equal(timers.length, 0);
});

test("adapter source only delegates to Codex OAuth transport, never paid OpenAI fallback", async () => {
  const source = await readFile(join(checkout, "pi/extensions/codex-account-pool/index.ts"), "utf8");
  assert.match(source, /openAICodexResponsesApi/);
  assert.doesNotMatch(source, /OPENAI_API_KEY|openai-responses|api\.openai\.com\/v1/);
  assert.match(source, /\/backend-api\/wham\/usage/);
  assert.match(source, /Codex quota read was unavailable/);
});

test("installed adapter routing retains structured quota evidence and simple reasoning", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "route.json"), probe = join(root, "route.ts");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
  const token = `x.${payload}.x`;
  const loginToken = `login.${payload}.x`;
  await mkdir(cwd, { recursive: true });
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "settings.json"), "{}");
  await writeFile(join(agent, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: loginToken, refresh: "fixture-refresh", expires: 4_102_444_800_000, accountId: "fixture" } }));
  await updatePoolState(state => {
    state.enabled = true;
    state.accounts.push({ ...account("first", "first", 4_102_444_800_000), access: token }, { ...account("second", "second", 4_102_444_800_000), access: token });
  }, path);
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; import {zstdDecompressSync} from 'node:zlib'; export default function(pi) { pi.registerCommand('pool-route',{handler:async(_args,ctx)=>{const provider=ctx.modelRegistry.getProvider('openai-codex'); const model=provider.getModels()[0]; const auth=await ctx.modelRegistry.getApiKeyAndHeaders(model); if(!auth.ok || auth.apiKey!==${JSON.stringify(loginToken)}) throw Error('Stored subscription OAuth did not resolve'); let calls=0; const efforts=[]; const events=[]; const stream=provider.streamSimple(model,{messages:[]},{reasoning:'high',apiKey:auth.apiKey,fetch:async(_url,init)=>{if(init.headers.get('authorization')!==${JSON.stringify('Bearer '+token)}) throw Error('Pool did not use its subscription token'); calls++; let body=Buffer.from(init.body); if(init.headers.get('content-encoding')==='zstd') body=zstdDecompressSync(body); efforts.push(JSON.parse(body.toString()).reasoning?.effort); return new Response(JSON.stringify({error:{code:'usage_limit_reached',message:'quota'}}),{status:429,headers:{'retry-after':'1'}});}}); for await(const event of stream) events.push(event.type); writeFileSync(${JSON.stringify(output)},JSON.stringify({calls,efforts,events}));}}); }`);
  const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/pool-route"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 });
  run.child.stdin.end();
  const { stdout, stderr } = await run;
  assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module|Stored subscription OAuth did not resolve|Pool did not use its subscription token/);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { calls: 2, efforts: ["high", "high"], events: ["error"] });
  assert.equal((await readPoolState(path)).accounts.every(value => value.exhausted), true);
});

test("pooled attempts disable adapter retries so stale quota evidence cannot authorize a later failure", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "retry.json"), probe = join(root, "retry.ts");
  const jwt = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true }); await writeFile(join(agent, "settings.json"), "{}");
  await updatePoolState(state => { state.enabled = true; state.accounts.push({ ...account("one", "one", 4_102_444_800_000), access: `x.${jwt}.x` }); }, path);
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi){pi.registerCommand('retry',{handler:async(_a,ctx)=>{const p=ctx.modelRegistry.getProvider('openai-codex'),m=p.getModels()[0];let calls=0;for await(const _ of p.streamSimple(m,{messages:[]},{maxRetries:1,fetch:async()=>{calls++;return new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429});}})){};writeFileSync(${JSON.stringify(output)},String(calls));}})}`);
  const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/retry"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 }); run.child.stdin.end(); await run;
  assert.equal(await readFile(output, "utf8"), "1");
});

test("foreign account tool history remaps matching result IDs in the captured adapter payload", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "tool-payload.json"), probe = join(root, "tool-payload.ts");
  const jwt = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true }); await writeFile(join(agent, "settings.json"), "{}");
  await updatePoolState(state => { state.enabled = true; state.accounts.push({ ...account("one", "one", 4_102_444_800_000), access: `x.${jwt}.x` }); }, path);
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; import {zstdDecompressSync} from 'node:zlib'; export default function(pi){pi.registerCommand('tool-payload',{handler:async(_a,ctx)=>{const p=ctx.modelRegistry.getProvider('openai-codex'),m=p.getModels()[0],usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},messages=[{role:'assistant',api:m.api,provider:m.provider,model:m.id,responseId:'foreign',content:[{type:'toolCall',id:'call_1|fc_item',name:'echo',arguments:{x:1}}],usage,stopReason:'toolUse',timestamp:1},{role:'toolResult',toolCallId:'call_1|fc_item',toolName:'echo',content:[{type:'text',text:'ok'}],isError:false,timestamp:2}];let input;for await(const _ of p.streamSimple(m,{messages},{fetch:async(_u,init)=>{let body=Buffer.from(init.body);if(init.headers.get('content-encoding')==='zstd')body=zstdDecompressSync(body);input=JSON.parse(body.toString()).input;return new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429});}})){};writeFileSync(${JSON.stringify(output)},JSON.stringify(input));}})} `);
  const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/tool-payload"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 }); run.child.stdin.end(); await run;
  const input = JSON.parse(await readFile(output, "utf8"));
  const calls = input.filter(item => item.type === "function_call");
  const results = input.filter(item => item.type === "function_call_output");
  assert.deepEqual(calls.map(item => item.call_id), ["call_1"]);
  assert.deepEqual(results.map(item => item.call_id), ["call_1"]);
  assert.equal(results.filter(item => item.output.includes("No result provided")).length, 0);
});

test("a started adapter stream never rotates to the next account", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "started.json"), probe = join(root, "started.ts");
  const jwt = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true }); await writeFile(join(agent, "settings.json"), "{}");
  await updatePoolState(state => { state.enabled = true; state.accounts.push({ ...account("one", "one", 4_102_444_800_000), access: `x.${jwt}.x` }, { ...account("two", "two", 4_102_444_800_000), access: `x.${jwt}.x` }); }, path);
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi){pi.registerCommand('started',{handler:async(_a,ctx)=>{const p=ctx.modelRegistry.getProvider('openai-codex'),m=p.getModels()[0];let calls=0,events=[];for await(const event of p.streamSimple(m,{messages:[]},{fetch:async()=>{calls++;return new Response('',{status:200});}}))events.push(event.type);writeFileSync(${JSON.stringify(output)},JSON.stringify({calls,events}));}})}`);
  const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/started"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 }); run.child.stdin.end(); await run;
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { calls: 1, events: ["start", "error"] });
});

for (const enabled of [false, true]) {
  test(`installed Pi/jiti loads the pool adapter with pool ${enabled ? "enabled" : "disabled"} without network`, { timeout: 30000 }, async t => {
    const { root, path } = await fixture(t);
    const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "probe.json"), probe = join(root, "probe.ts");
    await mkdir(cwd, { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "settings.json"), "{}");
    if (enabled) {
      await updatePoolState(state => { state.enabled = true; state.accounts.push(account("fixture", "fixture", 4_102_444_800_000)); }, path);
    }
    await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi) { pi.registerCommand('pool-probe',{handler:async(_args,ctx)=>{const provider=ctx.modelRegistry.getProvider('openai-codex'); writeFileSync(${JSON.stringify(output)},JSON.stringify({name:provider?.name,models:provider?.getModels().length}));}}); }`);
    const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/pool-probe"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 });
    run.child.stdin.end();
    const { stdout, stderr } = await run;
    assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module/);
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.ok(result.models > 0);
    assert.equal(result.name, enabled ? "OpenAI Codex (account pool)" : "OpenAI Codex");
  });
}

for (const deferBeforeFetch of [false, true]) {
  test(`public registry completion pins background account and ${deferBeforeFetch ? "rechecks admission before fetch" : "never fails over a submitted quota response"}`, { timeout: 30000 }, async t => {
    const { root, path } = await fixture(t);
    const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "background.json"), probe = join(root, "background.ts");
    const jwt = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
    await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true }); await writeFile(join(agent, "settings.json"), "{}");
    await updatePoolState(state => {
      state.enabled = true;
      state.accounts = ["first", "second"].map(id => ({ ...account(id), access: `x.${jwt}.x` }));
    }, path);
    await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi){pi.registerCommand('background',{handler:async(_args,ctx)=>{
      const request={};pi.events.emit('rcs-memory:pool',request);
      let checks=0,calls=0,payloads=0;
      const registration=request.service.register('synthetic-memory','first',async()=>({allowed:!${deferBeforeFetch} || ++checks<3,mode:'quota',reason:'working'}));
      const model=ctx.modelRegistry.getProvider('openai-codex').getModels()[0];
      const result=await ctx.modelRegistry.complete(model,{messages:[]},{sessionId:'synthetic-memory',cacheRetention:'none',maxRetries:0,onPayload:()=>{payloads++},fetch:async()=>{calls++;return new Response(JSON.stringify({error:{code:'usage_limit_reached'}}),{status:429,headers:{'retry-after':'60'}})}});
      writeFileSync(${JSON.stringify(output)},JSON.stringify({calls,payloads,deferred:!!registration.entry.deferred,submitted:registration.entry.submitted,provider:result.provider,model:result.model===model.id}));registration.release();
    }})}`);
    const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/background"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 });
    run.child.stdin.end();
    const { stdout, stderr } = await run;
    assert.doesNotMatch(stdout + stderr, /Failed to load extension|Cannot find module/);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { calls: deferBeforeFetch ? 0 : 1, payloads: 1, deferred: true, submitted: !deferBeforeFetch, provider: "openai-codex", model: true });
    assert.equal((await readPoolState(path)).accounts[1].exhausted, undefined);
    assert.equal((await readPoolState(path)).backgroundHoldAccountId, deferBeforeFetch ? undefined : "first");
  });
}

test("explicit priority change releases a background hold without any model request", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const agent = join(root, "agent"), cwd = join(root, "project");
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "settings.json"), "{}");
  await updatePoolState(state => { state.enabled = true; state.accounts = [account("a"), account("b")]; state.backgroundHoldAccountId = "a"; }, path);
  const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-p", "/codex-pool priority b 1"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 });
  run.child.stdin.end(); await run;
  const state = await readPoolState(path);
  assert.equal(state.accounts[0].accountId, "b");
  assert.equal(state.backgroundHoldAccountId, undefined);
});

test("passive secondary-only named-family headers deny background admission without rejuvenating omitted primary", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "secondary.json"), probe = join(root, "secondary.ts");
  const jwt = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true }); await writeFile(join(agent, "settings.json"), "{}");
  const before = Date.now() - 10000;
  await updatePoolState(state => { state.enabled = true; state.accounts = [{ ...account("a"), access: `x.${jwt}.x`, quota: { fetchedAt: before, windows: [{ limitId: "codex_bengalfox", primary: { usedPercent: 10 }, secondary: { usedPercent: 10 } }] } }]; }, path);
  await writeFile(probe, `import {writeFileSync} from 'node:fs'; export default function(pi){pi.registerCommand('secondary',{handler:async(_args,ctx)=>{
    const model=ctx.modelRegistry.getProvider('openai-codex').getModels()[0];
    await ctx.modelRegistry.complete(model,{messages:[]},{fetch:async()=>new Response(JSON.stringify({error:{code:'rate_limit_exceeded'}}),{status:429,headers:{'x-codex-bengalfox-secondary-used-percent':'99'}})});
    const request={};pi.events.emit('rcs-memory:pool',request);
    const admission=await request.service.prepare({pause:30,resume:40},new AbortController().signal,()=>true,'a',false);
    writeFileSync(${JSON.stringify(output)},JSON.stringify(admission));
  }})}`);
  const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/secondary"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 });
  run.child.stdin.end(); await run;
  assert.equal(JSON.parse(await readFile(output, "utf8")).allowed, false);
  const limit = (await readPoolState(path)).accounts[0].quota.windows[0];
  assert.equal(limit.primary.usedPercent, 10); assert.equal(limit.secondary.usedPercent, 99); assert.equal(limit.fetchedAt, before);
});

test("confirmed background quota on third attempt survives cancellation during delayed exhaustion persistence exactly once", { timeout: 30000 }, async t => {
  const { root, path } = await fixture(t);
  const agent = join(root, "agent"), cwd = join(root, "project"), output = join(root, "quota-cancel.json"), probe = join(root, "quota-cancel.ts");
  const jwt = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url");
  await mkdir(cwd, { recursive: true }); await mkdir(agent, { recursive: true }); await writeFile(join(agent, "settings.json"), "{}");
  await updatePoolState(state => { state.enabled = true; state.accounts = ["a", "b"].map(id => ({ ...account(id), access: `x.${jwt}.x` })); }, path);
  await writeFile(probe, `import {writeFileSync,mkdirSync,rmSync} from 'node:fs';
    import {MemoryStore} from ${JSON.stringify(join(checkout, "pi/extensions/memory/store.ts"))};
    import {Learner} from ${JSON.stringify(join(checkout, "pi/extensions/memory/learner.ts"))};
    import {BackgroundDeferred} from ${JSON.stringify(join(checkout, "pi/extensions/memory/budget.ts"))};
    export default function(pi){pi.registerCommand('quota-cancel',{handler:async(_args,ctx)=>{
      const store=new MemoryStore(${JSON.stringify(join(root, "memory/memory.sqlite"))});
      store.enqueue('A',{session:'s',entries:[{id:'u',role:'user',text:'Use pnpm.'}]});
      for(let i=0;i<2;i++)store.fail(store.claim('A'),true);
      const request={};pi.events.emit('rcs-memory:pool',request);
      const model=ctx.modelRegistry.getProvider('openai-codex').getModels()[0];
      let calls=0,notifications=0,completion;
      const learner=new Learner(store,'A',async(_system,_input,signal,_admission,onDeferred)=>{
        const registration=request.service.register('quota-cancel','a',async()=>({allowed:true,mode:'quota',accountId:'a'}),(admission,submitted)=>{
          notifications++;const error=new BackgroundDeferred(admission);error.submitted=submitted;onDeferred(error);
          mkdirSync(${JSON.stringify(path + ".lock")});learner.pause();
        });
        completion=ctx.modelRegistry.complete(model,{messages:[]},{signal,sessionId:'quota-cancel',fetch:async()=>{calls++;return new Response(JSON.stringify({error:{code:'usage_limit_reached'}}),{status:429,headers:{'retry-after':'120'}})}}).finally(()=>registration.release());
        await completion;throw new Error('completion must not save');
      },()=>true,()=>{},async()=>({allowed:true,mode:'quota',accountId:'a'}));
      await learner.run();await learner.close();
      const during=store.db.prepare('SELECT state,attempts,payload,ready_at FROM jobs').get();
      rmSync(${JSON.stringify(path + ".lock")},{recursive:true});
      await completion;
      const after=store.db.prepare('SELECT state,attempts,payload,ready_at FROM jobs').get();
      writeFileSync(${JSON.stringify(output)},JSON.stringify({during,after,calls,notifications,used:store.dailyBudget().used}));store.close();
    }})}`);
  const run = exec(process.execPath, [cli, "--offline", "--no-session", "--no-context-files", "--approve", "-e", join(checkout, "pi/extensions/codex-account-pool"), "-e", probe, "-p", "/quota-cancel"], { cwd, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent }, timeout: 25000 });
  run.child.stdin.end(); await run;
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.during.state, "pending"); assert.equal(result.during.attempts, 2);
  assert.ok(JSON.parse(result.during.payload).entries.length); assert.ok(result.during.ready_at > Date.now() + 60000);
  assert.deepEqual(result.after, result.during);
  assert.equal(result.calls, 1); assert.equal(result.notifications, 1); assert.equal(result.used, 3);
  const state = await readPoolState(path);
  assert.equal(state.backgroundHoldAccountId, "a"); assert.equal(state.accounts[1].exhausted, undefined);
});
