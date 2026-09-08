# Codex account pool

Opt-in priority failover for ChatGPT Plus/Pro **Codex OAuth** accounts. It preserves normal `openai-codex/<model>` IDs and never uses an OpenAI API key or paid API fallback.

`setup-pi.sh` installs the pinned `proper-lockfile` dependency from this extension's lockfile during a normal setup; `--skip-install` deliberately does not install it. After installation/restart:

```text
/codex-pool add personal browser
/codex-pool add work device
/codex-pool priority work 1
/codex-pool enable
/codex-pool quota
/codex-pool status
```

Use `enable NAME`, `disable NAME`, or `remove NAME` (confirmation required) for individual accounts; `disable` without a name restores stock Pi Codex behavior. `/codex-pool quota [NAME]` performs a read-only refresh for one or all accounts; `/codex-pool status` shows cached primary/secondary usage windows, update timestamp, and stale/unknown state. The compact status line shows the first eligible account's remaining percentage and reset. Login uses Pi's installed official Codex OAuth flow. `import` intentionally refuses to read an existing Pi credential; add each account explicitly.

Accounts are stored at `$PI_CODING_AGENT_DIR/codex-account-pool/state.json` (default `~/.pi/agent/...`) with a `0700` directory, `0600` file, atomic updates, and crash-recoverable cross-process refresh locks. Main Pi and background native subagents load the same ambient extension and share the pool. Foreground `pi-subagents` children do not load ambient provider extensions; use a background (`async`) child whenever pool routing is required.

Quota reads use OpenAI Codex's official-source ChatGPT-backend contract: `GET https://chatgpt.com/backend-api/wham/usage` with the account OAuth bearer token and `chatgpt-account-id`, as selected by Codex `PathStyle::ChatGptApi` for `/backend-api`. Only server-reported `used_percent`, window duration, and reset timestamps are retained; no token-budget or credit estimate is inferred. A quota read may first perform and persist a necessary normal OAuth refresh; a subsequent quota-read failure preserves eligibility, failover state, and the cached quota.

Use `/codex-pool relogin NAME [browser|device]` to replace credentials for the same account identity while preserving its label, priority, enablement, cooldown, and cached quota. To use a different account identity, remove it and add a new named account explicitly.

Failover occurs only before a stream starts and only for an original structured Codex 429 quota response. It never retries partial output, tool calls, network errors, authentication failures, throttling, or model-access failures. Pool requests use Codex SSE so the adapter can retain that structured pre-start evidence. A failover gets a fresh account-scoped session/cache namespace. Response provenance is persisted as a non-secret account hash; opaque reasoning/response metadata from another or unknown account is removed while preserving transcript and tool-result pairing. The installed public Codex API has no per-account model-discovery endpoint, so server acceptance of the selected normal model request is the conservative access validation.

[Memory](../memory/README.md) pins background requests via the public event bus/session ID. Passive official headers retain omitted quota windows.
