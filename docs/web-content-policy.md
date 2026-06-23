# PaperHub Web Content Policy

## Scope

This policy applies to content fetched during Web Search summaries, user-requested saves,
PDF downloads, and exports.

## Discovery and summaries

- Provider metadata, snippets, identifiers, titles, authors, dates, and source URLs may be
  retained with the Web Search session.
- HTML fetching respects `robots.txt`.
- Paywalled pages are downgraded to provider metadata and snippets.
- Fetched HTML text is transient, expires after 24 hours, and is not added to the local
  knowledge base unless the user explicitly selects `save_content`.
- PDF text is not fetched or retained during ordinary search summarization. PDF download
  requires an explicit user action.
- API/UI evidence excerpts are whitespace-normalized and limited to 600 characters.

## Saving

- `metadata_only` stores metadata and the original source URL.
- `save_content` respects `robots.txt` and refuses paywalled full text. The user can fall
  back to metadata-only saving.
- `download_pdf` is an explicit single-result user action. It is never performed
  automatically for a result set.

## Export

- Batch export is metadata-and-links only.
- Fetched full text and cached evidence may not be batch exported.
- A metadata export operation is limited to 500 records.
- Original source URLs must remain attached to exported metadata.

## Retention and cleanup

- Unsaved Web sessions, evidence, summaries, provider responses, and fetched content expire
  according to their TTL and are removed by scheduled cleanup.
- Saved Documents and user-requested PDF files are not removed by Web Search cache cleanup.
