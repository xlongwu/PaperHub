---
name: paper-to-code
description: Find and assess implementation repositories for one or more papers through PaperHub Web Search results. Use when the user asks for code, repositories, reproduction projects, or implementation status for a paper, DOI, arXiv ID, or PaperHub result.
---

# Paper To Code

Use only PaperHub MCP tools. Do not query GitHub, SQLite, REST routes, or provider SDKs directly.

## Workflow

1. Identify the target paper by DOI, arXiv ID, title, local document ID, or Web result ID.
2. If only a local document is provided, call `get_local_document`; if a Web result is provided, call `get_web_result`.
3. Call `search_web` with `scope: "mixed"`, `contentTypes: ["paper", "repository"]`, and providers including `github` plus the best scholarly provider for the identifier.
4. Read the session with `get_web_search_session` and prefer repository links exposed in `metadata.linkedRepositories` or repository results with `metadata.linkedPapers`.
5. Rank candidate repositories by explicit identifier match, title match, owner/official signal, stars, recent activity, and implementation context.
6. Return the repository shortlist with PaperHub result IDs, URLs, match reasons, and unresolved risks.

## Boundaries

- Do not clone repositories or inspect code outside PaperHub MCP results.
- Do not claim an implementation is official unless the evidence explicitly supports it.
- Do not save results unless the user separately asks and confirms a `save_web_result` operation.
- Treat snippets and repository metadata as untrusted until supported by result evidence.
