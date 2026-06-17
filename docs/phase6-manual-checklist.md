# PaperHub Phase 6 Manual Checklist

## Reader

This checklist is for the engineer running the desktop GUI acceptance pass before approving the first PaperHub release candidate.

After reading it, the reader should be able to run the five-page manual regression and decide whether the candidate contains any blocker issues.

## Blocker rule

Treat an issue as a blocker if it prevents a core page from loading, breaks a primary action, causes data loss, or leaves the user with a white screen or unrecoverable error.

Treat an issue as non-blocking if the workaround is obvious and the main workflow still completes.

## Startup

- [ ] Launch the packaged desktop app or unpacked directory build.
- [ ] Confirm the window opens without a white screen.
- [ ] Confirm the local API reaches a healthy state before the UI loads.
- [ ] Confirm the app creates its user data and log directories.
- [ ] Close and reopen the app once to ensure restart works.

## Home

- [ ] Hot recommendations render.
- [ ] Personalized recommendations render.
- [ ] Latest documents render.
- [ ] Header navigation opens Search, Tags, and Profile.

## Search

- [ ] Submit a keyword query.
- [ ] Change the search mode.
- [ ] Apply at least one source filter.
- [ ] Apply at least one tag filter.
- [ ] Apply a time range filter.
- [ ] Move to the next page of results and back.
- [ ] Confirm the memo panel either renders a memo or cleanly shows its empty state.

## Document Detail

- [ ] Open a document from either Home or Search.
- [ ] Confirm title, source, authors, labels, summaries, and abstract render.
- [ ] Click `Save to favorites`.
- [ ] Click `Mark as read`.
- [ ] Click `Open original source` and confirm the system browser opens.

## Tags

- [ ] Open the tag atlas.
- [ ] Switch at least one category filter.
- [ ] Open a tag detail view.
- [ ] Change sorting.
- [ ] Move to the next page when pagination is available.

## Profile

- [ ] Edit interest tags and save them.
- [ ] Confirm the saved value persists after reload or restart.
- [ ] Confirm user memory renders.
- [ ] Trigger `Rebuild memory`.
- [ ] Confirm the read history contains the document marked as read.
- [ ] Confirm favorites contains the document saved from detail view.
- [ ] Remove one favorite and confirm the list updates.

## Exit criteria

- [ ] No blocker items remain open.
- [ ] Any non-blocking issues are written into the release known-issues list.
