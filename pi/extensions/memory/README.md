# Pi memory

A native Pi extension with one local SQLite/FTS5 store, automatic scoped recall, and idle-time learning. No daemon, MCP server, embeddings service, Obsidian integration, or extra npm dependencies. Requires the Node version already checked by `setup-pi.sh` (>=22.19).

## Storage and scope

State lives in `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/memory/memory.sqlite`, **not** this checkout. The directory is mode 0700 and the database/WAL files are 0600. SQLite uses WAL, a busy timeout, transactions, and secure deletion. State is not automatically synced between Macs.

Project identity is the canonical Git common directory: worktrees and symlink aliases share memories; different clones do not. Outside Git, the exact canonical working directory is the scope. Moving a repository changes its identity. Start Pi in the repository you are working on, and use separate sessions for unrelated projects. Shell `cd`, editing another repository, and tasks spanning repositories do not change the session's scope. Scoping applies to all memory tool lookups, not just search defaults.

This is **logical isolation**, not a security sandbox: all scopes share the same local database, and Pi's shell runs with your OS permissions. Use separate OS/config environments if you need a hard work/personal boundary. Untrusted projects cannot open the store, read notes, capture evidence, or run extraction; review the project and use `/trust`, then `/reload` if needed.

Global notes are available across projects, but only the user can create or modify them with `/memory global ...`. Background learning and the model's memory tool cannot promote a project fact globally. No Claude/Codex history or previous Pi conversations are imported. All existing session entries, including inactive branches, are a baseline on startup/resume/reload and `/tree` navigation, not backfill input.

## How it works

### Recall

Before each new agent request, search the request using FTS5/BM25 across the current project and approved global notes. English stemming handles inflections such as dependency/dependencies. The index combines model-generated identifiers/synonyms with bounded original terms surrounding the cited evidence, so compression cannot silently drop all the vocabulary used to retrieve a lesson. Combined keywords are capped at 600 characters. Lexical matching remains the baseline; this is not semantic vector search. Schema migrations rebuild disposable indexes without discarding canonical notes or tombstones.

Load up to four pins plus relevant results, deduplicate to eight records, and cap the whole injected block at 6,500 characters. No matches means no injected block. Notes are ephemeral custom context immediately before the latest user message: the system prefix stays unchanged, and automatic recall is not appended to the session JSONL. Tool-use ordering is preserved. The assistant can use `memory search` and `memory get` for deeper lookup and evidence. Generic requests may require that explicit search; automatic retrieval is not guaranteed to find every relevant memory.

Memory is fallible context, not instructions, permission, or a replacement for inspecting current code. Session-derived lessons are labelled accordingly. No generated notes are written into `AGENTS.md` or installed as skills.

### Learning

Settled turns, pre-compaction checkpoints, and shutdown capture **new user text and completed assistant answers only**. Tool/file/web bodies, custom/injected messages, images, and thinking are excluded. Capture filters private blocks and common credential formats before queueing, reserves space for user evidence, and limits each entry to 5,000 characters and each batch to 18,000 characters / 30 KB of JSON. Long conversations are sampled, not exhaustively retained.

While idle, an isolated request to **Pi's currently configured model/provider** extracts at most four useful memories, using relevant existing records for consolidation. It has no tools. Requests use Pi's model registry and existing authentication, not a hard-coded model or copied credentials. This consumes that provider's quota; local storage does not make the model request local. There is no separate embeddings account.

Prefer explicit corrections, accepted decisions and rationale, and hard-to-rediscover lessons. Ordinary requests, routine acknowledgements, temporary task status, and facts easily read from code should yield no memory. Non-lesson records must cite user evidence; lessons may cite assistant text but are not represented as independently verified. Every generated quote must exactly match the supplied filtered source. Bad responses are rejected atomically, not saved as raw text.

Stable topic keys supersede old versions while preserving provenance and revision history. Explicitly saved notes cannot be overwritten by automatic consolidation. Old retried jobs cannot overwrite newer evidence. A single project lease prevents overlapping extraction for that project; concurrent sessions coordinate through SQLite. Job IDs deduplicate checkpoints.

Limits: 60-second extraction timeout, three attempts per job, 20 completed/failed or currently running jobs per rolling day across the store, and 50 outstanding jobs per project. Failed jobs back off; `/memory retry` retries final failures. Pending payloads expire after seven days when the worker next runs. Successful/cancelled jobs retain metadata receipts, not conversation payloads. Reported token totals currently cover completed jobs, not interrupted or invalid responses.

New agent work pauses extraction. Quit/reload/switch aborts it promptly, even if a provider ignores abort, and durably requeues unfinished work. No background process survives the Pi session. Print mode may exit before learning runs; pending work resumes in a later trusted session for that project. Memory failures do not prevent ordinary coding.

## Controls

Run `/memory` for current status, storage, scope, and command help. The footer shows recalled/saved/queued counts and whether reading or learning is off.

```text
/memory list
/memory search reload helper
/memory show <id>
/memory remember pi/reload | Local extension helpers that must refresh during reload should use .ts; verify against the current loader and reload regression test.
/memory pin <id>
/memory unpin <id>
/memory forget <id>
/memory restore pi/reload | A newly approved replacement for that forgotten topic.
/memory read off
/memory learn off
/memory read on
/memory learn on
/memory retry
/memory export
/memory global remember communication/detail | Prefer brief summaries unless more detail is requested.
/memory global forget <id>
```

- Commands are explicit user operations; inspection opens a text editor whose edits are **not** saved. Use `remember` with the same topic to edit. `export` displays a scoped JSON snapshot of up to 100 current records for copying, not a complete database backup.
- Global explicit notes start pinned. At most four pins are recalled, newest first, within the same overall context budget.
- `read off` disables automatic and model-tool recall, but the user can still inspect through commands. `learn off` discards outstanding learning and stops capturing new evidence. Neither deletes existing memories. Both settings persist per project. Re-enabling learning advances the generation too, so another instance cannot retrospectively capture its disabled-period conversation.
- The model's `memory save` and `memory forget` require a native confirmation. Cancellation, unavailable UI, and blank answers are not approval. Commands provide a direct alternative.
- Forgetting removes the record, its full version history and FTS entries; cancels pending/in-flight project learning; and advances a transactionally checked generation so older capture cannot be requeued after deletion. Content-free topic/digest tombstones and retained job IDs block exact-topic/exact-text regeneration. Global forgetting also removes exact-text project copies/history and cancels queued learning across scopes.
- Other Pi instances notice generation changes and discard their pre-revocation evidence. Active automatic recall and prior memory tool results recheck IDs, so deleted records disappear from those contexts on the next model call without editing the original chat. Only explicit `restore` clears a matching tombstone. Reworded duplicates can still require a search and separate deletion; no semantic erasure guarantee is made.
- Forgetting **does not delete original Pi chats, explicit tool results already in chats, copied exports, OS backups, or independently worded notes**. Secure deletion and FTS optimization reduce SQLite remnants, but are not a forensic erasure guarantee on SSDs/backups. Do not remove tombstones while keeping old queued work.
- Secret detection is defense in depth, not complete DLP. Avoid entering secrets into chat; use `<private>...</private>` to exclude sensitive passages from automatic capture. Disable learning for sensitive work. Source quotes and generated text/topic/keywords are checked again before persistence.

## Verification

From the checkout:

```sh
bash -n setup-pi.sh setup.sh
python3 -m unittest discover -s tests -v
node --test tests/pi-*.test.mjs
git diff --check
# Optional, uses the configured provider for three synthetic requests:
PI_MEMORY_LIVE=1 node --test tests/pi-memory-live.test.mjs
```

Tests cover persistence/permissions, keyword/synonym recall and no-match abstention, project boundaries, provenance, corrections, manual protection, revocation races and copies, branch replay, cross-instance pause/resume, lease recovery and stale workers, bounded retries/usage/capture, privacy filters, untrusted projects, worktrees, native Pi lifecycle/context injection, and same-process reload through the installed symlink layout. Live tests check real-model extraction, a changed decision using the same topic, and abstention on routine chat with an echoed retrieved directive, using temporary state with no tools or personal context. This synthetic check is not a general prompt-injection resistance guarantee.

These tests establish behavior, not an uplift on real coding tasks. Revisit retrieval quality, memory precision, repeated-correction avoidance, stale advice, and total costs on representative multi-session tasks before adding embeddings, graph storage, or more automatic reflection.
