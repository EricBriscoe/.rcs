import { watch, type FSWatcher } from "node:fs";
import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { LspClient } from "./lsp.ts";
import { inside, target, matches, fileKind, type ServerConfig } from "./state.ts";

const methods: Record<string, [string, string]> = {
  definition: ["textDocument/definition", "definitionProvider"],
  references: ["textDocument/references", "referencesProvider"],
  implementation: ["textDocument/implementation", "implementationProvider"],
  type_definition: ["textDocument/typeDefinition", "typeDefinitionProvider"],
  hover: ["textDocument/hover", "hoverProvider"],
  document_symbols: ["textDocument/documentSymbol", "documentSymbolProvider"],
  workspace_symbols: ["workspace/symbol", "workspaceSymbolProvider"],
};
type Entry = { client: LspClient; root: string; config: ServerConfig; capabilities: any; docs: Map<string, { text: string; version: number }>; watcher?: FSWatcher; changes: Map<string, number>; restart: boolean };

export function bounded(value: any, max = 16000) {
  const text = JSON.stringify(value, null, 2);
  const notice = "\n[Truncated; narrow the query or request fewer symbols.]";
  return text.length > max ? text.slice(0, Math.max(0, max - notice.length)) + notice.slice(0, max) : text;
}
function span(range: any) {
  return { line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1 };
}
export function location(value: any, root: string): any {
  const uri = value.targetUri ?? value.uri;
  const range = value.targetSelectionRange ?? value.range;
  if (typeof uri !== "string" || !uri.startsWith("file:")) return { uri, external: true };
  const path = fileURLToPath(uri);
  return { path: inside(path, root) ? relative(root, path) : path, external: !inside(path, root),
    ...(range ? span(range) : {}) };
}
export function results(action: string, value: any, root: string, limit: number): any {
  if (action === "hover") return value ? { contents: value.contents, ...(value.range ? { range: span(value.range) } : {}), coordinates: "1-based UTF-16" } : null;
  const list = value == null ? [] : Array.isArray(value) ? value : [value];
  let count = 0, truncated = false;
  const symbols = (entries: any[], depth = 0): any[] => {
    const found = [];
    for (const symbol of entries) {
      if (count >= limit || depth > 8) { truncated = true; break; }
      count++;
      found.push({ name: symbol.name, kind: symbol.kind, detail: symbol.detail,
        ...(symbol.location ? location(symbol.location, root) : { line: symbol.selectionRange?.start.line + 1, column: symbol.selectionRange?.start.character + 1, endLine: symbol.range?.end.line + 1 }),
        ...(symbol.children?.length ? { children: symbols(symbol.children, depth + 1) } : {}) });
    }
    return found;
  };
  if (action.endsWith("symbols")) { const found = symbols(list); return { symbols: found, truncated, coordinates: "1-based UTF-16" }; }
  return { locations: list.slice(0, limit).map(item => location(item, root)), truncated: list.length > limit, coordinates: "1-based UTF-16" };
}

export class Navigation {
  entries = new Map<string, Entry>();
  closed = false;
  async start(root: string, config: ServerConfig, signal?: AbortSignal) {
    if (this.closed) throw new Error("Navigation session is closed.");
    const key = JSON.stringify([root, config]);
    let entry = this.entries.get(key);
    if (entry && (entry.client.closed || entry.restart)) { await this.stopEntry(key); entry = undefined; }
    if (entry) { this.entries.delete(key); this.entries.set(key, entry); return entry; }
    while (this.entries.size >= 3) await this.stopEntry(this.entries.keys().next().value!);
    const directory = await target(root, config.directory);
    const uri = pathToFileURL(directory).href;
    const client = new LspClient(config.command, directory, (method, params) => {
      if (method === "workspace/configuration") return (params?.items || []).map((item: any) => item.section ? item.section.split(".").reduce((value: any, key: string) => value && Object.hasOwn(value, key) ? value[key] : undefined, config.settings || {}) ?? null : config.settings || {});
      if (method === "workspace/workspaceFolders") return [{ uri, name: directory }];
      if (method === "workspace/applyEdit") return { applied: false, failureReason: "Read-only navigation client." };
      if (["client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"].includes(method)) return null;
      if (method === "window/showMessageRequest") return null;
      return undefined;
    });
    entry = { client, root: directory, config, capabilities: {}, docs: new Map(), changes: new Map(), restart: false };
    this.entries.set(key, entry);
    try {
      const response = await client.request("initialize", {
        processId: process.pid, clientInfo: { name: "pi-native-navigation", version: "1" }, rootUri: uri, rootPath: directory,
        workspaceFolders: [{ uri, name: directory }], initializationOptions: config.initializationOptions || {},
        capabilities: { general: { positionEncodings: ["utf-16"] }, workspace: { configuration: true, workspaceFolders: true, applyEdit: false, didChangeWatchedFiles: { dynamicRegistration: true } },
          textDocument: { synchronization: { didSave: true }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, definition: { linkSupport: true }, hover: { contentFormat: ["plaintext", "markdown"] } } },
      }, signal, 30000);
      if (response?.capabilities?.positionEncoding && response.capabilities.positionEncoding !== "utf-16") throw new Error("Server did not negotiate UTF-16 positions.");
      entry.capabilities = response?.capabilities || {};
      client.notify("initialized", {});
      client.notify("workspace/didChangeConfiguration", { settings: config.settings || {} });
      const current = entry;
      current.watcher = watch(directory, { recursive: true }, (event, filename) => {
        if (!filename) { current.restart = true; return; }
        const path = String(filename);
        if (path.split(/[\\/]/).some(part => [".git", "node_modules", ".venv", "venv", "target"].includes(part))) return;
        if (current.changes.size > 1000) { current.restart = true; return; }
        const absolute = resolve(directory, path);
        if (inside(absolute, directory)) current.changes.set(absolute, event === "rename" ? 1 : 2);
      });
      current.watcher.on("error", () => { current.restart = true; current.watcher?.close(); });
      signal?.throwIfAborted();
      return entry;
    } catch (error) {
      this.entries.delete(key); entry.watcher?.close(); await client.close(); throw error;
    }
  }
  async sync(entry: Entry, path: string) {
    let text: string;
    try {
      const safe = await target(entry.root, path);
      if ((await stat(safe)).size > 2 * 1024 * 1024) throw new Error("Source file exceeds 2 MB; use text search instead.");
      text = await readFile(safe, "utf8");
    } catch (error) {
      if (entry.docs.has(path)) { entry.client.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(path).href } }); entry.docs.delete(path); }
      throw error;
    }
    const uri = pathToFileURL(path).href;
    const previous = entry.docs.get(path);
    if (!previous) {
      if (entry.docs.size >= 32) {
        const oldest = entry.docs.keys().next().value!;
        entry.client.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(oldest).href } }); entry.docs.delete(oldest);
      }
      entry.client.notify("textDocument/didOpen", { textDocument: { uri, languageId: entry.config.languages[fileKind(path)], version: 1, text } });
      entry.docs.set(path, { text, version: 1 });
    } else if (previous.text !== text) {
      const oldText = previous.text;
      previous.version++; previous.text = text;
      const sync = entry.capabilities.textDocumentSync;
      const kind = typeof sync === "number" ? sync : sync?.change;
      // A whole-document range is a valid incremental edit. Full-sync servers
      // receive a range-less replacement instead.
      const change: any = { text };
      if (kind === 2) {
        const oldLines = oldText.split(/\r?\n/);
        change.range = { start: { line: 0, character: 0 }, end: { line: oldLines.length - 1, character: oldLines.at(-1)!.length } };
      }
      entry.client.notify("textDocument/didChange", { textDocument: { uri, version: previous.version }, contentChanges: [change] });
      entry.client.notify("textDocument/didSave", { textDocument: { uri }, text });
    }
    return text;
  }
  async query(root: string, configs: ServerConfig[], params: any, signal?: AbortSignal) {
    const action = params.action;
    if (!methods[action]) throw new Error("Unknown navigation action.");
    const path = params.path ? await target(root, params.path) : undefined;
    let candidates = configs.filter(config => (!params.server || config.id === params.server) && (!path || matches(config, root, path)));
    candidates.sort((a, b) => b.directory.length - a.directory.length);
    if (!candidates.length) throw new Error("No configured server for this file. Run code_nav status, then setup/configure the relevant language.");
    if (!path && candidates.length !== 1) throw new Error(`Choose a server for workspace symbol search: ${candidates.map(c => c.id).join(", ")}`);
    const entry = await this.start(root, candidates[0], signal);
    const [method, capability] = methods[action];
    if (!entry.capabilities[capability]) throw new Error(`Server '${entry.config.id}' does not support ${action}; use another navigation method or grep.`);
    for (const opened of [...entry.docs.keys()]) {
      try { await this.sync(entry, opened); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
    const events = [];
    for (const [changed, type] of entry.changes) {
      try { const safe = await realpath(changed); if (inside(safe, entry.root)) events.push({ uri: pathToFileURL(safe).href, type }); }
      catch { events.push({ uri: pathToFileURL(changed).href, type: 3 }); }
    }
    entry.changes.clear();
    if (events.length) entry.client.notify("workspace/didChangeWatchedFiles", { changes: events });
    let request: any;
    if (action === "workspace_symbols") request = { query: params.query || "" };
    else {
      if (!path) throw new Error("This navigation action requires a source path.");
      const text = await this.sync(entry, path);
      request = { textDocument: { uri: pathToFileURL(path).href } };
      if (action !== "document_symbols") {
        const lines = text.split(/\r?\n/);
        if (!Number.isInteger(params.line) || !Number.isInteger(params.column) || params.line < 1 || params.line > lines.length || params.column < 1 || params.column > lines[params.line - 1].length + 1) throw new Error("Provide valid 1-based line and UTF-16 column positions.");
        request.position = { line: params.line - 1, character: params.column - 1 };
      }
      if (action === "references") request.context = { includeDeclaration: true };
    }
    const value = await entry.client.request(method, request, signal);
    return { server: entry.config.id, root, result: results(action, value, root, params.limit ?? 30) };
  }
  async stopEntry(key: string) {
    const entry = this.entries.get(key); if (!entry) return;
    this.entries.delete(key); entry.watcher?.close(); await entry.client.close();
  }
  async reset() { await Promise.all([...this.entries.keys()].map(key => this.stopEntry(key))); }
  async close() { this.closed = true; await this.reset(); }
}
