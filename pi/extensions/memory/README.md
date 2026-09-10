# Memory

**State:** `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/memory/memory.sqlite` (0700 directory, 0600 DB/WAL). Worktrees share scope; clones do not. Outside Git: starting cwd, not shell `cd`. Untrusted projects blocked; not a sandbox.

**Visibility:** **Recalled N memories** above the editor counts capped/revalidated notes; otherwise empty/no-match/off/unavailable. `/memory`/tool status: scope, budgets, last learning outcome since startup/reload (empty ≠ error). Footer: learning queue, failures, pauses.

**Recall:** local semantic vectors + stemmed FTS5/BM25, reciprocal rank fusion (k=60, ≤30/branch, cosine ≥0.40). Same ≤8 records/4 pins/6,500 characters, ephemeral context. SQLite revalidates active IDs/revisions/scopes; search/get retains provenance, never authorization.

**Learning:** selected provider/model/auth only. Fresh user/completed assistant text; no tools/files/web/thinking/custom messages/history import. Same-session/scope/generation batches deduplicate IDs, separate revisions. Caps: 5,000 chars/entry, 18,000 evidence chars, 30 KB JSON/request/output, 60s/request, 3 failed/interrupted attempts, 50 outstanding jobs/project. Codex ignores the requested 4096 output-token cap. Payloads expire after 7 days/success. Work/model changes pause; reload/exit requeues; print may exit first.

**Budget:** <5-minute pool quota allows spare-quota mode: every window (including weekly) retains ≥30%, recovery ≥40%. Denial/exhaustion overrides credits. Known-low stays blocked when stale/missing; exhaustion needs newer telemetry after any known reset. Idle work refreshes the pinned account ≤once/minute across processes. Background quota429 holds until reset recovery or foreground/user rerouting; never background failover.

Absent/disabled pool, unknown quota or other providers: 20 requests/rolling 24h globally; spare-quota: 100. Atomic counts include submitted interruptions; unsent deferrals refund. Quota deferrals preserve retries/work until reset (60s if unknown); stock unknown-identity holds span sessions. `/tokens` records returned usage; memory totals count completed batches.

**Consolidation:** Unicode/spacing dedupe; the same learning call classifies ≤12 related same-scope candidates as add/ignore/merge/supersede. Updates need offered IDs/revisions and fresh citations; supersession needs user evidence. Manual/pinned notes, lease/generation fences and tombstones remain protected. Merges retain ≤12 sources (overflow skips); supersession archives old sources. Retired aliases never enter recall. Shares hybrid candidates with recall, project-only; similarity is not equivalence. No model sweep.

**Retention:** hourly startup/learning cleanup keeps 10 revisions and 10 undo snapshots/note (undo ≤90 days). Payload-free terminal jobs expire after 30 days; requests after 2 (beyond budgets). Token totals, hashed receipts, fingerprints, consolidation links and tombstones remain. Notes never expire; no VACUUM. Restart other sessions for this schema.

## Controls

```text
/memory list|search <query>|show <id>|export
/memory retired|changes
/memory undo <change-id>
/memory remember <topic> | <text>
/memory forget <id>
/memory restore <topic> | <replacement>
/memory pin <id> / unpin <id>
/memory read on|off
/memory learn on|off
/memory retry
/memory budget
/memory budget pause|resume|fallback|quota <number>
/memory global remember <topic> | <text>
/memory global forget <id>
```

Budget: machine-local/user-only; `pause < resume`, `fallback ≤ quota`. Confirm tool saves/deletions; globals are user-only. Read-off leaves learning independent; learn-off discards jobs. Export: ≤100 records, not a backup. Undo refuses newer edits, restores manual notes and cancels learning jobs.

Forget removes records/history/index, connected consolidations and undo snapshots; cancels jobs; retains topic/digest tombstones (even pruned revisions). Global forget removes exact scoped copies. Explicit restore clears matching tombstones. Chats/backups/exports/paraphrases remain. Filtering is best effort, not DLP/forensic erasure; disable learning for sensitive work.

## Local embeddings

`./setup-pi.sh` installs runtime/model; `--skip-install` only relinks. Recovery: `node pi/install-memory-embedding.mjs`, then `/reload`. **Setup-only downloads**, never foreground/launch/recall. Model faults use FTS until reload; `/memory` shows retrieval status, degraded states also show in the footer. Read-off blocks automatic/tool recall; command inspection and learning remain independent.

One killable process/session, one request/no queue, one CPU inference thread. Cold loading returns FTS immediately (15s startup ceiling); ready queries have a 150ms deadline. Idle backfill: 16 notes/pass, 5s deadline. Cancellation kills/fences work, allowing one cold restart on a later idle pass. Model errors/timeouts wait for `/reload`. Above 2,000 scoped vectors use FTS; partial backfill augments FTS.

Only active curated **topic/text/keywords** become SQLite vectors (384 floats; 1,536 bytes/note plus metadata). No chat/file/tool/history indexing. Redacted queries/current user evidence use transient local IPC (≤1,000 chars), never disk/logs/network APIs/paid fallback. Triggers delete vectors on edit/retire/undo/pin/forget; model/digest/revision and cross-process mutation/control epochs fence late results. Trust/lifecycle gates retrieval and cache writes. Vectors remain sensitive; erasure/backups caveats apply.

Pins: `embedding-runtime/package{,-lock}.json` and `embedding-model.json`. [Transformers.js 4.2.0](https://github.com/huggingface/transformers.js/tree/4.2.0) and [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9), Apache-2.0; pinned revision in the model link, q8, mean/L2, 256-token truncation. sharp 0.35.4 / adm-zip 0.6.0 overrides fix [libvips](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) / [ZIP allocation](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) advisories; install scripts disabled, clean audit: zero vulnerabilities.

State: agent-directory `tooling/memory-embedding/<pin-hash>/`, outside Git. macOS arm64: ~153 MB download, ~416 MB installed. No privileged install. New pins require setup/restart; helpers support `/reload`.

Tests: `node --test tests/pi-memory*.test.mjs`. Offline model tests/evaluation: set `PI_MEMORY_EMBEDDING_AGENT` to a setup-completed agent directory; stores are synthetic. `pi-memory-retrieval-eval.test.mjs`: 33 notes/19 queries, FTS→hybrid recall@8 9/13→11/13, MRR .654→.769; identifiers top-1 3/3, unrelated false hits 0/6. Warm ~2–3ms, cold .18–1.42s here. Two paraphrases miss; lexical distractors remain; negation ≠ equivalence. The .40 gate is uncalibrated; this fixture is not a held-out guarantee. `PI_MEMORY_LIVE=1` separately enables authenticated extraction.
