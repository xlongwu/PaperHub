---
name: daily-web-research-digest
description: Produce a bounded daily research digest from PaperHub Web Search sessions for one or more topics, including new papers, repositories, provider coverage, and save candidates. Use when the user asks for a daily digest, daily scan, or recurring research watchlist.
---

# Daily Web Research Digest

Use only PaperHub MCP tools. Do not call feeds, search engines, REST routes, SQLite, or provider SDKs directly.

## Workflow

1. Convert the user's watchlist into 1 to 5 concrete search topics.
2. For each topic, call `search_web` with a recent date range, bounded `maxResults`, and `sort: "recent"`.
3. Read every session with `get_web_search_session` and record provider successes, failures, and partial results.
4. Group results into papers, repositories, official updates, and technical articles.
5. Mark save candidates but do not call `save_web_result` unless the user explicitly confirms exact items and modes.
6. Return a digest with topic sections, notable changes, linked result IDs, and coverage limitations.

## Boundaries

- Do not run broad searches unless the user explicitly opts in.
- Do not claim daily completeness; this is provider-limited current discovery.
- Do not include uncited claims.
- Do not persist results without a separate confirmation step.
