---
name: citation-verification
description: Verify whether citations, identifiers, and cited claims are supported by PaperHub local library documents or bounded Web Search sessions. Use when the user asks to check references, validate citations, verify a bibliography, or audit evidence quality.
---

# Citation Verification

Use only PaperHub MCP tools. Do not access SQLite, REST routes, publisher APIs, Crossref SDKs, or provider SDKs directly.

## Workflow

1. Parse each citation into available fields: title, authors, year, DOI, arXiv ID, venue, URL, and claim text.
2. Search the local library first with `search_local_library`; read strong matches with `get_local_document`.
3. For missing or ambiguous citations, call `search_web` with `scope: "academic"` and a bounded `maxResults`.
4. Read candidate sessions with `get_web_search_session`; use DOI, arXiv ID, canonical URL, then title/author/year to decide matches.
5. For claim verification, call `summarize_web_result` or use existing session synthesis only when it cites the relevant result ID.
6. Return a table with status: verified, mismatch, ambiguous, not found, or insufficient evidence.

## Boundaries

- Do not invent citation metadata to fill gaps.
- Do not treat a title-only fuzzy match as verified.
- Do not rewrite or save library data unless the user explicitly requests a separate save flow.
- Report provider limits and expired sessions as uncertainty, not negative proof.
