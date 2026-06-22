---
name: systematic-review-lite
description: Run a bounded lightweight systematic review through PaperHub Web Search, with explicit research question, inclusion criteria, provider coverage, screening notes, and cited synthesis. Use when the user asks for a quick systematic review, evidence map, or structured literature review.
---

# Systematic Review Lite

Use only PaperHub MCP tools. Do not query databases, REST routes, SQLite, or provider SDKs directly.

## Workflow

1. Convert the request into a review question, inclusion criteria, exclusion criteria, date range, and required concepts.
2. Call `search_web` with `scope: "academic"` or `mixed`, bounded `maxResults`, and `searchBudget: "balanced"` unless the user explicitly approves broader coverage.
3. Read the session with `get_web_search_session`; report provider status and failed providers.
4. Screen results using DOI/arXiv/title deduplication, content type, date range, and must-concept coverage.
5. Call `summarize_web_results` for the included session when a synthesis is needed.
6. Return included studies, excluded near-misses with reasons, evidence themes, limitations, and follow-up searches.

## Boundaries

- This is not a full PRISMA-grade review; label it as lightweight and bounded.
- Do not run unbounded iterative searches.
- Do not save or favorite results without explicit user confirmation.
- Every substantive finding must cite PaperHub result IDs or local document IDs.
