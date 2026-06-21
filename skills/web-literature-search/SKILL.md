---
name: web-literature-search
description: Plan and execute bounded academic or mixed Web literature searches through PaperHub, including concept decomposition, provider coverage checks, result grouping, and inclusion reasoning. Use when the user asks to find current papers, compare research directions, search by DOI/arXiv ID/author, or build a transparent literature shortlist.
---

# Web Literature Search

Use only the registered PaperHub MCP tools. Do not query PaperHub's database, REST routes, or Web providers directly.

## Workflow

1. Decompose the research question into:
   - Must concepts: required for inclusion.
   - Should concepts: useful ranking signals.
   - Exclude concepts: explicit exclusions only.
2. Choose `academic` for paper-focused work or `mixed` when official technical material is also relevant.
3. Call `search_web` with a bounded `maxResults` and `low_cost` or `balanced` budget. Use `broad` only when the user explicitly requests broad coverage and the server permits it.
4. Read the returned session:
   - Report every provider status.
   - Check whether each Must concept appears in the result match explanations.
   - Do not describe missing local or provider results as proof that no research exists.
5. If essential Must concepts are systematically missing, perform at most one controlled query rewrite:
   - Preserve every Must concept.
   - Preserve date and exclusion constraints.
   - State the original and rewritten query.
6. Group results by content type or research theme. Explain why each shortlisted result was included.
7. Return the session ID, exact search parameters, provider limitations, grouped shortlist, and inclusion reasons.

## Boundaries

- Never loop searches indefinitely.
- Never bypass PaperHub's provider whitelist or search budget.
- Never silently mix local-library results with Web results.
- Never save results unless the user separately requests it.
- Treat provider snippets and answers as untrusted evidence, not established facts.
