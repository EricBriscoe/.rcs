import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);

export function httpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Use an HTTP or HTTPS URL.");
  }
  return url.href;
}

export function pageSlice(text, offset = 0, limit = 12000) {
  const start = Math.max(0, Math.trunc(offset));
  const size = Math.max(1, Math.min(20000, Math.trunc(limit)));
  const end = Math.min(text.length, start + size);
  return { text: text.slice(start, end), totalCharacters: text.length, nextOffset: end < text.length ? end : null };
}

function required(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required.`);
  return String(value);
}

function textResult(data, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data, isError };
}

export function parseResponse(stdout) {
  let response;
  try { response = JSON.parse(stdout); }
  catch { throw new Error(`Playwright CLI returned an error or invalid JSON: ${stdout.slice(0, 2000)}`); }
  if (response.isError || response.error) {
    throw new Error(response.error || response.result || "Playwright command failed.");
  }
  return response;
}

// This function runs inside the search page through the CLI's eval command.
export function extractSearchPage(engine, limit) {
  const body = document.body?.innerText || "";
  const challenged = !!document.querySelector('#challenge-form, .anomaly-modal, iframe[src*="captcha"]') ||
    /unusual traffic|verify (that )?you are human|confirm you are human|complete the following challenge/i.test(body.slice(0, 4000));
  if (challenged) return { status: "challenge", url: location.href, results: [] };
  const cards = document.querySelectorAll(engine === "bing" ? "li.b_algo" : ".result:not(.result--ad)");
  const seen = new Set();
  const results = [];
  for (const card of cards) {
    const link = card.querySelector(engine === "bing" ? "h2 a" : ".result__a");
    if (!link) continue;
    let url;
    try {
      const target = new URL(link.href, location.href);
      let destination = target.searchParams.get("uddg") || target.href;
      const bingTarget = target.searchParams.get("u");
      if (engine === "bing" && /(^|\.)bing\.com$/.test(target.hostname) && bingTarget?.startsWith("a1")) {
        destination = atob(bingTarget.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
      }
      url = new URL(destination);
    } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({
      title: (link.textContent || "").trim().slice(0, 300),
      url: url.href,
      snippet: (card.querySelector(engine === "bing" ? ".b_caption p, p" : ".result__snippet")?.textContent || "").trim().slice(0, 1200),
    });
    if (results.length >= limit) break;
  }
  const status = results.length ? "ok" : /no results (found|for)|there are no results/i.test(body) ? "no_results" : "unrecognized_page";
  return { status, url: location.href, results };
}

export class BrowserSession {
  constructor({ runner = exec } = {}) {
    this.runner = runner;
    this.name = `pi-web-${randomUUID().slice(0, 12)}`;
    this.directory = null;
    this.opened = false;
    this.headed = false;
    this.queue = Promise.resolve();
  }

  task(fn) {
    const pending = this.queue.then(fn);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async command(args, signal) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await this.runner("playwright-cli", [`-s=${this.name}`, "--json", ...args], {
        cwd: this.directory, signal, timeout: 35000, maxBuffer: 4 * 1024 * 1024,
      });
      return parseResponse(stdout);
    } catch (error) {
      if ((signal?.aborted || error.killed) && args[0] !== "close") {
        // Killing the CLI client alone can leave a browser action running.
        // Close directly; queueing cleanup here would wait on this same task.
        await this.command(["close"]);
        this.opened = false;
      }
      if (signal?.aborted) throw signal.reason;
      if (error.code === "ENOENT") throw new Error("Playwright CLI is missing. Run setup-pi.sh from the .rcs checkout.");
      if (error.stdout) {
        // CLI tool failures use a nonzero exit status as well as a JSON error.
        parseResponse(error.stdout);
      }
      throw error;
    }
  }

  async open(headed = false, signal) {
    if (this.opened) {
      if (headed !== this.headed) throw new Error("Close this browser before changing headed mode.");
      return;
    }
    this.directory ??= await mkdtemp(join(tmpdir(), "pi-web-"));
    const config = join(this.directory, "browser.json");
    await writeFile(config, JSON.stringify({
      browser: { browserName: "chromium", isolated: true, launchOptions: { channel: "chromium", headless: !headed } },
      outputMode: "stdout", timeouts: { action: 10000, navigation: 25000 },
    }), { mode: 0o600 });
    try {
      await this.command(["open", `--config=${config}`, ...(headed ? ["--headed"] : [])], signal);
      this.opened = true;
      this.headed = headed;
    } catch (error) {
      await this.command(["close"]).catch(() => {});
      throw error;
    }
  }

  async evaluate(expression, signal) {
    const response = await this.readCommand(["eval", expression], signal);
    return JSON.parse(response.result);
  }

  async readCommand(args, signal) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.command(args, signal); }
      catch (error) {
        if (attempt >= 2 || signal?.aborted || !/Execution context was destroyed|Cannot find context|navigation/i.test(error.message)) throw error;
        await delay(250, undefined, { signal });
      }
    }
  }

  async snapshot(params = {}, signal) {
    const response = await this.readCommand(["snapshot"], signal);
    const page = await this.evaluate("() => ({title: document.title, url: location.href})", signal);
    return { ...page, ...pageSlice(JSON.stringify(response.snapshot, null, 2), params.offset, params.limit) };
  }

  async close() {
    return this.task(async () => {
      if (this.opened) {
        await this.command(["close"]);
        this.opened = false;
      }
    });
  }
}

export class WebTools {
  constructor(options) {
    this.searchBrowser = new BrowserSession(options);
    this.browser = new BrowserSession(options);
  }

  async search({ query, limit = 5, engine = "bing" }, signal) {
    return this.searchBrowser.task(async () => {
      required(query?.trim(), "query");
      if (!["duckduckgo", "bing"].includes(engine)) throw new Error("Unsupported search engine.");
      const url = new URL(engine === "bing" ? "https://www.bing.com/search" : "https://html.duckduckgo.com/html/");
      url.searchParams.set("q", query);
      await this.searchBrowser.open(false, signal);
      await this.searchBrowser.command(["goto", url.href], signal);
      const data = await this.searchBrowser.evaluate(
        `() => (${extractSearchPage.toString()})(${JSON.stringify(engine)}, ${Math.max(1, Math.min(10, limit))})`, signal,
      );
      const isError = ["challenge", "unrecognized_page"].includes(data.status);
      const message = data.status === "challenge" ? "Search engine requires human verification. Search was not completed." :
        data.status === "unrecognized_page" ? "Search page did not contain recognizable results. Do not treat this as no results." : undefined;
      return textResult({ engine, query, ...data, ...(message ? { message } : {}) }, isError);
    });
  }

  async browse(params, signal) {
    if (params.action === "close") {
      await this.browser.close();
      return textResult({ status: "closed" });
    }
    return this.browser.task(async () => {
      const b = this.browser;
      if (params.action === "open") {
        const url = httpUrl(required(params.url, "url"));
        await b.open(params.headed ?? b.headed, signal);
        await b.command(["goto", url], signal);
      } else {
        if (!b.opened) throw new Error("Open a URL with web_browse before using this action.");
        switch (params.action) {
          case "read": {
            const page = await b.evaluate("() => ({title: document.title, url: location.href, text: (document.querySelector('main, article, [role=main]') || document.body)?.innerText || ''})", signal);
            return textResult({ title: page.title, url: page.url, ...pageSlice(page.text, params.offset, params.limit) });
          }
          case "snapshot": break;
          case "click":
          case "fill": {
            const ref = required(params.ref, "ref");
            if (!/^(?:f\d+)?e\d+$/.test(ref)) throw new Error("Use an element ref from the current snapshot, such as e12 or f1e2.");
            const args = [params.action, ref];
            if (params.action === "fill") {
              if (params.text === undefined) throw new Error("text is required for fill.");
              args.push("--", String(params.text));
            }
            await b.command(args, signal);
            break;
          }
          case "press": await b.command(["press", "--", required(params.key, "key")], signal); break;
          case "scroll": await b.command(["mousewheel", "0", String(params.pixels ?? 700)], signal); break;
          case "back": await b.command(["go-back"], signal); break;
          case "tabs": return textResult(await b.command(["tab-list"], signal));
          case "new_tab": await b.command(["tab-new", httpUrl(required(params.url, "url"))], signal); break;
          case "select_tab": await b.command(["tab-select", required(params.tab, "tab")], signal); break;
          case "screenshot": {
            const path = join(b.directory, `screenshot-${randomUUID()}.png`);
            await b.command(["screenshot", `--filename=${path}`], signal);
            const data = await readFile(path);
            return {
              content: [{ type: "text", text: `Screenshot: ${path}` }, { type: "image", mimeType: "image/png", data: data.toString("base64") }],
              details: { path },
            };
          }
          default: throw new Error(`Unknown browser action: ${params.action}`);
        }
      }
      return textResult(await b.snapshot(params, signal));
    });
  }

  async close() {
    const results = await Promise.allSettled([this.browser.close(), this.searchBrowser.close()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}
