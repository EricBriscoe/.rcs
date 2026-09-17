# Codex account pool

Opt-in routing and failover across ChatGPT Plus/Pro **Codex OAuth** accounts. It preserves normal `openai-codex/<model>` IDs and never uses an OpenAI API key or paid API fallback.

Routing is cache-aware. Subscription usage is almost entirely input context and every account switch re-reads the whole conversation on the new account, so the account that served this session's last request stays first while the provider cache is warm. The warm window reuses `efficiency.idleCompactMinutes` (default 10). At a cold boundary (first request, idle gap past the window, or after a failover) the pool ranks eligible accounts by headroom: the remaining percentage on each account's tightest window across every known limit, with a limit-reached flag counting as zero and unknown usage counting as full so a fresh account gets probed. Priority order breaks ties. A resumed session restores its warm account from the recorded response provenance. Low headroom never triggers a switch while warm: hitting the wall costs nothing because the rejected request never starts, and failover then walks the ranked list.

Open `/codex-pool` for account setup, re-login, priority, quota, and removal (confirmed). Partial commands such as `/codex-pool relogin` open pickers. Login failures offer an explanation and browser/device retry; Escape cancels. `/codex-pool status` is read-only. The footer points to settings; Tab completes commands.

Pool credentials are separate from Pi’s `/login` and `/logout` store. Use `/codex-pool relogin NAME browser` to sign in again and `/codex-pool remove NAME` to remove a pool login. For ordinary single-account `/login openai-codex` and `/logout`, first run `/codex-pool disable`. A standard subscription login can coexist; enabled pooling still uses pool accounts and quota.

Use `enable NAME`, `disable NAME`, or `remove NAME` (confirmation required) for individual accounts; `disable` without a name restores stock Pi Codex behavior. `/codex-pool quota [NAME]` performs a read-only refresh for one or all accounts; `/codex-pool status` shows cached primary/secondary usage windows, update timestamp, and stale/unknown state. The compact status line shows the account the next request would use, its tightest window's remaining percentage with that window's length, and its reset. Login uses Pi's installed official Codex OAuth flow. `import` intentionally refuses to read an existing Pi credential; add each account explicitly.

Accounts are stored at `$PI_CODING_AGENT_DIR/codex-account-pool/state.json` (default `~/.pi/agent/...`) with a `0700` directory, `0600` file, atomic updates, and crash-recoverable cross-process refresh locks. Main Pi and background native subagents load the same ambient extension and share the pool. Foreground `pi-subagents` children do not load ambient provider extensions; use a background (`async`) child whenever pool routing is required.

Quota reads use Codex’s `GET /backend-api/wham/usage` with account OAuth headers. Only server-reported usage and reset times are retained. Reads may refresh OAuth first; quota-read failure preserves eligibility, failover state, and cached usage.

Re-login preserves the account’s label, priority, enablement, cooldown, and quota. To change account identity, remove it and add a new account.

While enabled, the pool also owns pi-ai's `openai-codex-responses` API entry, so bare `stream()`/`complete()` calls from other extensions (pi-condense summaries, custom compaction) use pool accounts instead of the stock `/login` credential; disabling restores the built-in implementation.

Failover occurs only before a stream starts and only for an original structured Codex 429 quota response. It never retries partial output, tool calls, network errors, authentication failures, throttling, or model-access failures. Pool requests use Codex SSE so the adapter can retain that structured pre-start evidence. A failover gets a fresh account-scoped session/cache namespace. Response provenance is persisted as a non-secret account hash; opaque reasoning/response metadata from another or unknown account is removed while preserving transcript and tool-result pairing. The installed public Codex API has no per-account model-discovery endpoint, so server acceptance of the selected normal model request is the conservative access validation.

Passive official headers retain omitted quota windows.
