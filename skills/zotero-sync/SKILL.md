---
name: zotero-sync
description: Prepare PaperHub results for user-controlled Zotero synchronization by finding local or Web records, checking metadata quality, and saving confirmed PaperHub entries. Use when the user asks to sync, export, or stage papers for Zotero from PaperHub.
---

# Zotero Sync

Use only PaperHub MCP tools. PaperHub currently exposes no direct Zotero write tool, so this skill stages and verifies PaperHub records rather than writing to Zotero directly.

## Workflow

1. Identify requested papers from local document IDs, Web result IDs, DOI/arXiv IDs, or titles.
2. Use `get_local_document`, `search_local_library`, `get_web_result`, or `search_web` to resolve each item.
3. Check metadata completeness: title, authors, year, DOI/arXiv ID, URL, abstract, venue, and PDF availability.
4. If an item is only a Web result, ask for explicit confirmation before calling `save_web_result`.
5. Return a Zotero staging table with PaperHub document IDs, identifiers, metadata gaps, and recommended export fields.
6. Tell the user when a direct Zotero action cannot be performed because no PaperHub MCP Zotero tool exists.

## Boundaries

- Do not call Zotero APIs, local Zotero databases, REST routes, SQLite, or provider SDKs directly.
- Do not save Web results without explicit confirmation.
- Do not hide metadata gaps; list them before sync/export handoff.
- Do not imply Zotero was updated unless an explicit Zotero-capable PaperHub MCP tool is added later.
