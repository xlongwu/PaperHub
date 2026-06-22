---
name: research-gap-analysis
description: Identify evidence gaps, weakly supported claims, missing comparisons, and future work opportunities from PaperHub local and Web Search evidence. Use when the user asks for research gaps, thesis ideas, novelty checks, or unexplored directions.
---

# Research Gap Analysis

Use only PaperHub MCP tools. Do not access SQLite, REST routes, raw provider APIs, or external search engines directly.

## Workflow

1. Define the target domain, population/task, method family, and timeframe.
2. Search the local library with `search_local_library` to reuse existing PaperHub evidence.
3. Call `search_web` for current evidence when the local library is sparse or stale.
4. Read sessions with `get_web_search_session` and call `summarize_web_results` when synthesis is not already available.
5. Separate gaps into: empirical coverage, benchmark/data, method comparison, reproducibility/code, deployment/safety, and theory.
6. For each gap, cite supporting result IDs and state what evidence would falsify or narrow the gap.

## Boundaries

- Do not call a gap novel unless the searched evidence scope is stated.
- Do not treat provider absence as proof of no prior work.
- Do not recommend work that depends on unavailable evidence without marking it speculative.
- Do not save results unless separately confirmed by the user.
