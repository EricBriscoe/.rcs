import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  BrowserSession, WebTools, extractSearchPage, httpUrl, pageSlice, parseResponse,
} from "../pi/extensions/web/browser.mjs";

const response = (value = {}) => ({ stdout: JSON.stringify(value) });

function cleanDirectories(t, ...sessions) {
  t.after(async () => {
    for (const session of sessions) {
      if (session.directory) await rm(session.directory, { recursive: true, force: true });
    }
  });
}

function searchFixture({ engine = "bing", body = "Search results", cards = [], challenge = false, limit = 5 } = {}) {
  const document = {
    body: { innerText: body },
    querySelector: () => challenge ? {} : null,
    querySelectorAll: (selector) => {
      assert.equal(selector, engine === "bing" ? "li.b_algo" : ".result:not(.result--ad)");
      return cards.map(({ href, title = "Result", snippet = "Description" }) => ({
        querySelector: (selector) => {
          if (["h2 a", ".result__a"].includes(selector)) {
            return href === undefined ? null : { href, textContent: title };
          }
          return { textContent: snippet };
        },
      }));
    },
  };
  const result = runInNewContext(`(${extractSearchPage.toString()})(engine, limit)`, {
    document, engine, limit, URL, atob,
    location: { href: engine === "bing" ? "https://www.bing.com/search?q=fixture" : "https://html.duckduckgo.com/html/?q=fixture" },
  });
  return JSON.parse(JSON.stringify(result));
}

test("HTTP URL validation permits local development and rejects other schemes", () => {
  assert.equal(httpUrl("http://localhost:3456"), "http://localhost:3456/");
  assert.equal(httpUrl("http://127.0.0.1:8080/path?q=test"), "http://127.0.0.1:8080/path?q=test");
  assert.equal(httpUrl("https://example.com/a b"), "https://example.com/a%20b");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,test", "ftp://example.com"]) {
    assert.throws(() => httpUrl(url), /HTTP or HTTPS/);
  }
  assert.throws(() => httpUrl("not a URL"));
});

test("text pagination caps output and reports the next unread character", () => {
  const text = "0123456789".repeat(5000);
  assert.deepEqual(pageSlice(text, 7, 4), { text: "7890", totalCharacters: 50000, nextOffset: 11 });
  assert.equal(pageSlice(text).text.length, 12000);
  assert.equal(pageSlice(text, 0, 100000).text.length, 20000);
  assert.deepEqual(pageSlice("abc", 2, 100), { text: "c", totalCharacters: 3, nextOffset: null });
  assert.deepEqual(pageSlice("abc", 99, 100), { text: "", totalCharacters: 3, nextOffset: null });
  assert.deepEqual(pageSlice("abc", -1, 0), { text: "a", totalCharacters: 3, nextOffset: 1 });
});

test("CLI responses distinguish successful JSON from JSON and plain-text failures", () => {
  assert.deepEqual(parseResponse('{"result":"done"}'), { result: "done" });
  assert.throws(() => parseResponse('{"isError":true,"result":"No such element"}'), /No such element/);
  assert.throws(() => parseResponse('{"error":"Browser is closed"}'), /Browser is closed/);
  assert.throws(() => parseResponse("Unknown option --bad"), /invalid JSON: Unknown option --bad/);
  assert.throws(() => parseResponse("x".repeat(5000)), (error) => error.message.length < 2100);
});

test("Bing extraction decodes destination URLs, rejects unsafe links, and deduplicates", () => {
  const destination = "https://example.com/docs?q=browser";
  const encoded = Buffer.from(destination).toString("base64url");
  const data = searchFixture({ cards: [
    { href: `https://www.bing.com/ck/a?u=a1${encoded}`, title: "  Browser docs  ", snippet: "  Read this page  " },
    { href: destination },
    { href: "javascript:alert(1)" },
    {},
    { href: "https://example.org/second", title: "x".repeat(500), snippet: "y".repeat(1400) },
    { href: "https://example.net/third" },
  ], limit: 2 });
  assert.equal(data.status, "ok");
  assert.equal(data.results.length, 2);
  assert.deepEqual(data.results[0], { title: "Browser docs", url: destination, snippet: "Read this page" });
  assert.equal(data.results[1].title.length, 300);
  assert.equal(data.results[1].snippet.length, 1200);
});

test("DuckDuckGo extraction unwraps redirect links and deduplicates destinations", () => {
  const destination = "https://example.com/page?one=1&two=2";
  const data = searchFixture({ engine: "duckduckgo", cards: [
    { href: `//duckduckgo.com/l/?uddg=${encodeURIComponent(destination)}`, title: "Duck result" },
    { href: destination },
    { href: "https://example.org/direct" },
  ] });
  assert.equal(data.status, "ok");
  assert.deepEqual(data.results.map((item) => item.url), [destination, "https://example.org/direct"]);
});

test("search challenges and unknown layouts cannot masquerade as zero results", () => {
  assert.equal(searchFixture({ challenge: true, cards: [{ href: "https://example.com" }] }).status, "challenge");
  assert.equal(searchFixture({ body: "Please verify that you are human" }).status, "challenge");
  assert.equal(searchFixture({ body: "No results found for this query" }).status, "no_results");
  assert.equal(searchFixture({ body: "Welcome to a redesigned search page" }).status, "unrecognized_page");
});

test("browser commands preserve argv and cancellation without shell evaluation", async () => {
  const calls = [];
  const session = new BrowserSession({ runner: async (...args) => { calls.push(args); return response({ result: "ok" }); } });
  const controller = new AbortController();
  const payload = '--flag; $(printf unsafe) `echo unsafe` "quoted" & | >';
  await session.command(["fill", "e17", "--", payload], controller.signal);
  assert.equal(calls[0][0], "playwright-cli");
  assert.deepEqual(calls[0][1], [`-s=${session.name}`, "--json", "fill", "e17", "--", payload]);
  assert.equal(calls[0][2].signal, controller.signal);
  assert.equal(calls[0][2].shell, undefined);
  assert.equal(calls[0][2].timeout, 35000);
  controller.abort(new Error("User cancelled"));
  await assert.rejects(session.command(["snapshot"], controller.signal), /User cancelled/);
  assert.equal(calls.length, 1);
});

test("browser command failures report CLI diagnostics and missing installation", async () => {
  const failed = new BrowserSession({ runner: async () => {
    throw Object.assign(new Error("Command failed"), { stdout: '{"isError":true,"result":"Invalid ref e999"}' });
  } });
  await assert.rejects(failed.command(["click", "e999"]), /Invalid ref e999/);
  const missing = new BrowserSession({ runner: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  await assert.rejects(missing.command(["open"]), /Run setup-pi.sh/);
});

test("in-flight aborts and timeouts close the owned session and reset its state", async (t) => {
  for (const kind of ["abort", "timeout"]) {
    await t.test(kind, async () => {
      const calls = [];
      const controller = new AbortController();
      const session = new BrowserSession({ runner: async (...args) => {
        calls.push(args);
        if (args[1][2] === "click") {
          if (kind === "abort") controller.abort(new Error("User cancelled action"));
          throw Object.assign(new Error("Action timed out"), { killed: true });
        }
        return response();
      } });
      session.opened = true;
      await assert.rejects(session.command(["click", "e1"], controller.signal),
        kind === "abort" ? /User cancelled action/ : /Action timed out/);
      assert.deepEqual(calls[1][1], [`-s=${session.name}`, "--json", "close"]);
      assert.equal(calls[1][2].signal, undefined);
      assert.equal(calls.length, 2);
      assert.equal(session.opened, false);
    });
  }
});

test("read operations retry transient navigation errors with a bounded attempt count", async () => {
  let attempts = 0;
  const recovered = new BrowserSession({ runner: async () => {
    if (++attempts < 3) return response({ isError: true, result: "Execution context was destroyed during navigation" });
    return response({ result: JSON.stringify({ title: "Loaded" }) });
  } });
  assert.deepEqual(await recovered.evaluate("() => document.title"), { title: "Loaded" });
  assert.equal(attempts, 3);

  attempts = 0;
  const failed = new BrowserSession({ runner: async () => {
    attempts++;
    return response({ isError: true, result: "Cannot find context during navigation" });
  } });
  await assert.rejects(failed.readCommand(["snapshot"]), /Cannot find context/);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(failed.command(["click", "e1"]), /Cannot find context/);
  assert.equal(attempts, 1);
});

test("browser startup writes isolated config and cleanup closes only its owned session", async (t) => {
  const calls = [];
  const session = new BrowserSession({ runner: async (...args) => { calls.push(args); return response(); } });
  cleanDirectories(t, session);
  await session.open();
  const configPath = calls[0][1].find((arg) => arg.startsWith("--config=")).slice("--config=".length);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.browser.isolated, true);
  assert.equal(config.browser.launchOptions.headless, true);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal(calls[0][2].cwd, session.directory);
  await session.open();
  assert.equal(calls.length, 1);
  await assert.rejects(session.open(true), /changing headed mode/);
  await session.close();
  await session.close();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], [`-s=${session.name}`, "--json", "close"]);
  assert.equal(session.opened, false);
});

test("failed browser startup attempts owned cleanup without the aborted signal", async (t) => {
  const calls = [];
  const controller = new AbortController();
  const session = new BrowserSession({ runner: async (...args) => {
    calls.push(args);
    if (args[1].includes("open")) {
      controller.abort(new Error("Cancelled launch"));
      throw new Error("Process aborted");
    }
    return response();
  } });
  cleanDirectories(t, session);
  await assert.rejects(session.open(false, controller.signal), /Cancelled launch/);
  assert.deepEqual(calls[1][1], [`-s=${session.name}`, "--json", "close"]);
  assert.equal(calls[1][2].signal, undefined);
  assert.equal(session.opened, false);
});

test("session tasks serialize and recover after a failed operation", async () => {
  const session = new BrowserSession();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = session.task(async () => {
    events.push("first started");
    await gate;
    events.push("first failed");
    throw new Error("Fixture failure");
  });
  const second = session.task(async () => { events.push("second started"); return "recovered"; });
  await Promise.resolve();
  assert.deepEqual(events, ["first started"]);
  release();
  await assert.rejects(first, /Fixture failure/);
  assert.equal(await second, "recovered");
  assert.deepEqual(events, ["first started", "first failed", "second started"]);
});

test("browse validates snapshot refs and passes option-like fill text literally", async (t) => {
  const calls = [];
  const web = new WebTools({ runner: async (_file, args) => {
    calls.push(args);
    if (args[2] === "eval") return response({ result: JSON.stringify({ title: "Fixture", url: "http://localhost/" }) });
    return response({ snapshot: "textbox [ref=e1]" });
  } });
  cleanDirectories(t, web.browser, web.searchBrowser);
  t.after(() => web.close());
  await web.browse({ action: "open", url: "http://localhost/" });
  const payload = "--text; $(touch should-not-exist) & 'quotes'";
  await web.browse({ action: "fill", ref: "f1e2", text: payload });
  assert.deepEqual(calls.find((args) => args[2] === "fill").slice(2), ["fill", "f1e2", "--", payload]);
  await web.browse({ action: "press", key: "--option-like-key" });
  assert.deepEqual(calls.find((args) => args[2] === "press").slice(2), ["press", "--", "--option-like-key"]);
  const count = calls.length;
  await assert.rejects(web.browse({ action: "click", ref: "--help" }), /element ref/);
  assert.equal(calls.length, count);
});

test("live local browser supports refs, literal fill, clicking, reads, screenshots, and tabs", {
  skip: process.env.PI_WEB_LIVE !== "1", timeout: 120000,
}, async (t) => {
  const server = createServer((request, reply) => {
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.end(request.url === "/second" ? "<!doctype html><title>Second fixture</title><main>Second tab fixture</main>" : `<!doctype html>
      <title>Browser fixture</title><main>
      <label>Message <input id="message"></label><button id="apply">Apply</button>
      <p id="output">Waiting for input</p></main>
      <script>document.getElementById('apply').onclick = () => {
        document.getElementById('output').textContent = document.getElementById('message').value;
      };</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const web = new WebTools();
  t.after(async () => {
    try { await web.close(); }
    finally {
      await new Promise((resolve) => server.close(resolve));
      for (const session of [web.browser, web.searchBrowser]) {
        if (session.directory) await rm(session.directory, { recursive: true, force: true });
      }
    }
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const findRef = (nodes, role) => {
    for (const node of nodes) {
      if (node.role === role) return node.ref;
      const found = findRef(node.children || [], role);
      if (found) return found;
    }
  };
  await web.browse({ action: "open", url });
  const snapshot = await web.browse({ action: "snapshot" });
  const inputRef = findRef(JSON.parse(snapshot.details.text), "textbox");
  assert.ok(inputRef, snapshot.details.text);
  const payload = '--flag; $(printf unsafe) `echo unsafe` "quoted" & | >';
  const filled = await web.browse({ action: "fill", ref: inputRef, text: payload });
  const buttonRef = findRef(JSON.parse(filled.details.text), "button");
  assert.ok(buttonRef, filled.details.text);
  await web.browse({ action: "click", ref: buttonRef });
  const page = await web.browse({ action: "read" });
  assert.equal(page.details.title, "Browser fixture");
  assert.ok(page.details.text.includes(payload), page.details.text);
  const screenshot = await web.browse({ action: "screenshot" });
  const png = screenshot.content.find((item) => item.type === "image");
  assert.equal(png.mimeType, "image/png");
  assert.deepEqual(Buffer.from(png.data, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await web.browse({ action: "new_tab", url: `${url}second` });
  assert.equal((await web.browse({ action: "read" })).details.title, "Second fixture");
  const tabs = await web.browse({ action: "tabs" });
  assert.match(JSON.stringify(tabs.details), /Browser fixture/);
  assert.match(JSON.stringify(tabs.details), /Second fixture/);
  await web.browse({ action: "select_tab", tab: 0 });
  assert.equal((await web.browse({ action: "read" })).details.title, "Browser fixture");
});
