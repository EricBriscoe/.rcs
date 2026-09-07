# Memory

Automatic scoped recall and idle learning; no embeddings, daemon, Obsidian, or imported histories.

**State:** `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/memory/memory.sqlite` (directory 0700, DB/WAL 0600). Git worktrees share scope via canonical common directory; separate clones do not. Outside Git, scope is starting cwd. Shell `cd` does not change it. Untrusted projects cannot use memory. Scope is logical, not an OS sandbox.

**Recall:** FTS5/BM25 with English stemming and source-adjacent keywords; ≤8 records including ≤4 pins, ≤6,500 characters. Injected ephemerally before the latest user message. No match adds nothing. Explicit search/get provides provenance. Memory is fallible evidence, never authorization.

**Learning:** current Pi model/auth, no tools; consumes provider quota. Captures only new user/completed assistant text, excluding tools, files, web, thinking, custom messages, and old/inactive history. Limits: 5,000 characters/entry, 18,000/batch, 30 KB JSON; 60 seconds/request, 3 attempts, 20 jobs/rolling day globally, 50 outstanding/project. Queued payloads expire after 7 days when learning resumes. Successful jobs discard payloads. New work pauses learning; reload/exit requeues unfinished work. Print mode may exit before extraction.

Exact evidence is required. Stable topics supersede revisions; automatic learning cannot overwrite manual notes or promote globally. Leases/generation checks fence stale jobs and deletion races. `/tokens` accounts returned extraction usage; memory's own totals cover completed jobs only.

## Controls

`/memory` shows help/status. Common forms:

```text
/memory list|search <query>|show <id>|export
/memory remember <topic> | <text>
/memory forget <id>
/memory restore <topic> | <replacement>
/memory pin <id> / unpin <id>
/memory read on|off
/memory learn on|off
/memory retry
/memory global remember <topic> | <text>
/memory global forget <id>
```

Model-tool saves/deletions require confirmation; global edits are user-command-only. Read-off leaves learning independent; learn-off discards pending jobs but not saved notes. Inspection editors do not save edits; export shows ≤100 current records, not a backup.

Forget removes records/history/index, cancels jobs, and retains topic/digest tombstones. Global forget also removes exact-text project copies. Only explicit restore clears matching tombstones. It does **not** erase chats, backups, exports, or paraphrases. Filtering/private blocks are best effort, not DLP or forensic erasure; avoid secrets and disable learning for sensitive work.

Tests: `node --test tests/pi-memory*.test.mjs`. `PI_MEMORY_LIVE=1` enables synthetic provider calls; it is not a real-task quality benchmark.
