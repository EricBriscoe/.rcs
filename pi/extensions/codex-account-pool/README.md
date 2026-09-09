# Codex account pool

Opt-in priority failover for ChatGPT Plus/Pro **Codex OAuth** accounts. It preserves normal `openai-codex/<model>` IDs and never uses an OpenAI API key or paid API fallback.

Open `/codex-pool` for interactive settings: add an account, choose browser or device login, enable the pool, and select an account to re-login, change priority, refresh quota, or remove it (with confirmation). Escape goes back; Done closes settings. The footer points to this menu. `/codex-pool status` remains read-only; explicit subcommands and Tab completion also work.

Pool credentials are separate from Pi’s `/login` and `/logout` store. Use `/codex-pool relogin NAME browser` to sign in again and `/codex-pool remove NAME` to remove a pool login. For ordinary single-account `/login openai-codex` and `/logout`, first run `/codex-pool disable`. A standard subscription login can coexist; enabled pooling still uses pool accounts and quota.

Use `enable NAME`, `disable NAME`, or `remove NAME` (confirmation required) for individual accounts; `disable` without a name restores stock Pi Codex behavior. `/codex-pool quota [NAME]` performs a read-only refresh for one or all accounts; `/codex-pool status` shows cached primary/secondary usage windows, update timestamp, and stale/unknown state. The compact status line shows the first eligible account's remaining percentage and reset. Login uses Pi's installed official Codex OAuth flow. `import` intentionally refuses to read an existing Pi credential; add each account explicitly.

Accounts are stored at `$PI_CODING_AGENT_DIR/codex-account-pool/state.json` (default `~/.pi/agent/...`) with a `0700` directory, `0600` file, atomic updates, and crash-recoverable cross-process refresh locks. Main Pi and background native subagents load the same ambient extension and share the pool. Foreground `pi-subagents` children do not load ambient provider extensions; use a background (`async`) child whenever pool routing is required.

Quota reads use Codex’s `GET /backend-api/wham/usage` with account OAuth headers. Only server-reported usage and reset times are retained. Reads may refresh OAuth first; quota-read failure preserves eligibility, failover state, and cached usage.

Re-login preserves the account’s label, priority, enablement, cooldown, and quota. To change account identity, remove it and add a new account.

Failover occurs only before a stream starts and only for an original structured Codex 429 quota response. It never retries partial output, tool calls, network errors, authentication failures, throttling, or model-access failures. Pool requests use Codex SSE so the adapter can retain that structured pre-start evidence. A failover gets a fresh account-scoped session/cache namespace. Response provenance is persisted as a non-secret account hash; opaque reasoning/response metadata from another or unknown account is removed while preserving transcript and tool-result pairing. The installed public Codex API has no per-account model-discovery endpoint, so server acceptance of the selected normal model request is the conservative access validation.

[Memory](../memory/README.md) pins background requests via the public event bus/session ID. Passive official headers retain omitted quota windows.
