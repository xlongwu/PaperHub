---
name: save-to-library
description: Review selected PaperHub Web Search results, check their current local state, obtain explicit user confirmation, and save them through PaperHub's unified ingestion service using metadata-only, content, or PDF mode. Use when the user asks to save, favorite, download, or add Web results to the local PaperHub library.
---

# Save To Library

Saving is a write operation. Use only PaperHub MCP tools and require explicit confirmation before calling `save_web_result`.

## Workflow

1. Read every requested item with `get_web_result`.
2. Show the user:
   - Title and source URL.
   - Session ID and result ID.
   - Existing local save state.
   - Proposed save mode.
   - Whether it will be favorited.
3. Explain save modes:
   - `metadata_only`: persist metadata and indexable abstract/snippet.
   - `save_content`: safely fetch and persist cleaned page content.
   - `download_pdf`: safely download an available PDF and attempt text extraction.
4. Ask for explicit confirmation of the exact selected results and modes.
5. After confirmation, call `save_web_result` once per selected result.
6. Return each `documentId`, duplicate/inserted status, favorite state, PDF state, and any per-item failure.

## Boundaries

- Never pass an arbitrary URL to a save tool.
- Never save a result outside its valid Session.
- Never perform unconfirmed bulk saves.
- Never automatically download PDFs for all results.
- Never write directly to SQLite or bypass PaperHub's ingestion, tagging, summary, or indexing services.
- A favorite must reference the saved local Document.
- Keep successful saves even if a later favorite or summary step fails; report the partial outcome.
