# PaperHub W7 Manual Acceptance Checklist

## Security

- [ ] SQLite contains no plaintext LLM, embedding, Tavily, Brave, or OpenAlex keys.
- [ ] API connection responses expose `hasApiKey` only.
- [ ] Logs and error dialogs contain no Authorization header or credential value.
- [ ] External HTTP/HTTPS links open in the system browser.
- [ ] `file:`, `javascript:`, custom protocols, popups, and in-app external navigation are blocked.
- [ ] Camera, microphone, location, and notification permissions are denied.
- [ ] Private, loopback, metadata, and redirect-to-private Safe Fetch targets fail.

## Reliability

- [ ] Fresh v24 database initialization succeeds.
- [ ] v23 upgrade creates a backup and preserves documents and preferences.
- [ ] Restarting an already migrated profile is idempotent.
- [ ] Interrupted searches become partial when results exist and failed otherwise.
- [ ] A result left in `saving` becomes retryable after restart.
- [ ] Hourly cache cleanup leaves saved Documents and downloaded PDFs intact.

## Monitoring

- [ ] `/api/web-search/health` returns provider, cache, and maintenance status.
- [ ] `/api/web-search/metrics` returns a bounded local time range.
- [ ] User Center shows seven-day searches, failure rate, credits, cache counts, and provider P95.
- [ ] Metrics do not contain query text, page content, keys, or local filesystem paths.

## Windows artifacts

- [ ] NSIS installer launches and completes Web search → save → local search.
- [ ] Portable x64 launches and completes Web search → save → local search.
- [ ] MCP server and the three Skills exist in both packaged artifacts.
- [ ] Uninstall does not remove the user's PaperHub data directory.
- [ ] Known non-blocking issues are recorded before release approval.
