import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { embeddingHome, validVector } from './embedding-config.mjs';

/** One process, one request, no queue. Cold start never blocks a recall call. */
export class LocalEmbedding {
  home: string;
  child?: ChildProcess;
  ready = false;
  closed = false;
  cancelled = false;
  status = 'FTS: model not loaded';
  pending?: { done: (value?: number[][]) => void };
  timer?: ReturnType<typeof setTimeout>;
  constructor(agent: string) { this.home = embeddingHome(agent); }

  start() {
    if (this.closed || this.child || this.status.startsWith('FTS: unavailable')) return;
    if (!existsSync(join(this.home, 'ready'))) { this.status = 'FTS: unavailable (run embedding setup, then /reload)'; return; }
    this.cancelled = false;
    this.status = 'FTS: model loading';
    try {
      const child = this.child = fork(fileURLToPath(new URL('./embedding-worker.mjs', import.meta.url)), [this.home], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      child.unref(); child.channel?.unref();
      this.timer = setTimeout(() => this.fail(), 15000); this.timer.unref();
      child.on('message', (message: any) => {
        if (this.child !== child) return;
        if (message.ready) { clearTimeout(this.timer); this.ready = true; this.status = 'hybrid'; }
        else if (message.error || !Array.isArray(message.vectors) || !message.vectors.every(validVector)) this.fail();
        else this.pending?.done(message.vectors);
      });
      child.on('error', () => { if (this.child === child) this.fail(); });
      child.on('exit', () => { if (this.child === child) this.fail(); });
    } catch { this.fail(); }
  }

  async embed(texts: string[], signal?: AbortSignal, timeout = 150): Promise<number[][] | undefined> {
    if (this.closed || this.cancelled || signal?.aborted) return undefined;
    this.start();
    if (!this.ready || this.pending) return undefined;
    return new Promise(resolve => {
      const cancel = () => {
        this.cancelled = true;
        this.fail('FTS: cancelled (idle restart pending)');
      };
      const timer = setTimeout(() => this.fail('FTS: unavailable (timeout; /reload to retry)'), timeout);
      this.pending = { done: value => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending = undefined;
        resolve(value?.length === texts.length ? value : undefined);
      } };
      signal?.addEventListener('abort', cancel, { once: true });
      const child = this.child!;
      child.send({ texts }, error => { if (error && this.child === child) this.fail(); });
    });
  }

  fail(reason = 'FTS: unavailable (model error; /reload to retry)') {
    this.status = reason; this.ready = false; clearTimeout(this.timer);
    const child = this.child; this.child = undefined;
    child?.kill('SIGKILL'); this.pending?.done();
  }
  close() { this.closed = true; this.fail('FTS: closed'); }
}
