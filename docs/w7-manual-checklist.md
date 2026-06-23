# PaperHub W7 Manual Acceptance Checklist

## Security

- [ ] SQLite contains no plaintext LLM, embedding, Tavily, Brave, or OpenAlex keys.
- [ ] API connection responses expose `hasApiKey` only.
- [ ] Logs and error dialogs contain no Authorization header or credential value.
- [ ] External HTTP/HTTPS links open in the system browser.
- [ ] `file:`, `javascript:`, custom protocols, popups, and in-app external navigation are blocked.
- [ ] Camera, microphone, location, and notification permissions are denied.
- [ ] Private, loopback, metadata, and redirect-to-private Safe Fetch targets fail.
- [ ] `save_content` respects robots.txt and refuses detected paywalled full text.
- [ ] Evidence excerpts are bounded and batch export remains metadata-only.

## Reliability

- [ ] Fresh v26 database initialization succeeds.
- [ ] v23 upgrade through v26 creates a backup and preserves documents and preferences.
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
- [ ] MCP server and all nine Skills exist in both packaged artifacts.
- [ ] Uninstall does not remove the user's PaperHub data directory.
- [ ] Known non-blocking issues are recorded before release approval.

## Real Provider verification

Run `PAPERHUB_VERIFY_PROVIDERS=arxiv,crossref,github pnpm verify:web-providers`,
then repeat with configured commercial and MCP providers.

- [ ] arXiv, Crossref, and GitHub return healthy.
- [ ] Configured OpenAlex, Tavily, and Brave connections return healthy.
- [ ] Configured stdio and HTTP MCP connections discover and call their search tool.
- [ ] Rate limit, timeout, partial result, and selected-provider retry behavior is manually verified.
