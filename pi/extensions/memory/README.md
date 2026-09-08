# Memory

**State:** `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/memory/memory.sqlite` (0700 directory, 0600 DB/WAL). Worktrees share scope; clones do not. Outside Git: starting cwd, not shell `cd`. Untrusted projects blocked; not a sandbox.

**Recall:** stemmed FTS5/BM25, ≤8 records/4 pins/6,500 characters, ephemeral context. Search/get includes provenance; never authorization.

**Learning:** selected provider/model/auth only. Fresh user/completed assistant text; no tools/files/web/thinking/custom messages/history import. Same-session/scope/generation batches deduplicate IDs, separate revisions. Caps: 5,000 chars/entry, 18,000 evidence chars, 30 KB JSON/request/output, 60s/request, 3 failed/interrupted attempts, 50 outstanding jobs/project. Codex ignores the requested 4096 output-token cap. Payloads expire after 7 days/success. Work/model changes pause; reload/exit requeues; print may exit first.

**Budget:** <5-minute pool quota allows spare-quota mode: every window (including weekly) retains ≥30%, recovery ≥40%. Denial/exhaustion overrides credits. Known-low stays blocked when stale/missing; exhaustion needs newer telemetry after any known reset. Idle work refreshes the pinned account ≤once/minute across processes. Background quota429 holds until reset recovery or foreground/user rerouting; never background failover.

Absent/disabled pool, unknown quota or other providers: 20 requests/rolling 24h globally; spare-quota: 100. Atomic counts include submitted interruptions; unsent deferrals refund. Quota deferrals preserve retries/work until reset (60s if unknown); stock unknown-identity holds span sessions. `/tokens` records returned usage; memory totals count completed batches.

**Consolidation:** Unicode/spacing dedupe; the same learning call classifies ≤12 related same-scope candidates as add/ignore/merge/supersede. Updates need offered IDs/revisions and fresh citations; supersession needs user evidence. Manual/pinned notes, lease/generation fences and tombstones remain protected. Merges retain ≤12 sources (overflow skips); supersession archives old sources. Retired aliases never enter recall. No embeddings or model sweep; similarity is not equivalence, and semantic accuracy depends on retrieval/model judgment.

**Retention:** hourly startup/learning cleanup keeps 10 revisions and 10 undo snapshots/note (undo ≤90 days). Payload-free terminal jobs expire after 30 days; requests after 2 (beyond budgets). Token totals, hashed receipts, fingerprints, consolidation links and tombstones remain. Notes never expire; no VACUUM. Restart other Pi sessions for this schema.

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

Tests: `node --test tests/pi-memory*.test.mjs`; `PI_MEMORY_LIVE=1` adds synthetic provider calls.
