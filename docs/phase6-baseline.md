# PaperHub Phase 6 Baseline

## Reader

This document is for the engineer reviewing phase-6 readiness and deciding whether the current candidate is stable enough to push toward `v0.1.0`.

After reading it, the reader should be able to tell which measurements are already verified, which cost controls already exist in code, and which items still need a follow-up run outside the current sandbox.

## Measured in this session

### Build and regression

| Check | Result |
|------|------|
| `pnpm ui:build` | passed, last run completed in about `1.7s` |
| Selected regression suite | passed, `24` tests in about `4.0s` |
| `pnpm typecheck` | passed |

### Packaging progress

`pnpm desktop:build:dir` now progresses through:

- UI build
- `electron-builder` config load
- native dependency preparation

It currently stops at the Electron rebuild of `better-sqlite3`.

## Not measurable in this sandbox

The following still need to be measured in a normal desktop or CI environment:

- Browser smoke duration for `pnpm test:e2e`
- Desktop cold-start duration
- Windows unpacked app launch duration
- Real page interaction latency under a live browser session

The reason is environmental, not missing code:

- Headless Chrome cannot expose a stable Playwright control channel here.

## Cost and repeated-work observations

### Summary generation

The summarizer already avoids duplicate work at the document level:

- `summarizeDocument()` returns the stored summary when `isSummarized` is already set.
- `summarizeBatch()` filters the batch to pending documents only.

### Search memo generation

The hybrid search memo is already gated:

- A memo is only attempted when the page has more than `10` results.
- It only runs in `hybrid` mode.

That means simple keyword searches and thin result sets avoid an extra LLM call.

### Vector indexing

The vector write path is idempotent at the row level:

- `storeVector()` uses `INSERT OR REPLACE`.

But the bulk index path still scans the whole corpus:

- `indexAllVectors()` loops over every document in batches.

That is acceptable for the current release candidate but should be treated as the main future optimization target once the first desktop release is stable.

### Search fallback

The vector branch already degrades safely:

- If there are no indexed vectors, it returns an empty semantic result set.
- If vector search throws, hybrid search continues with FTS results.

## Phase 6 readiness summary

### Ready now

- Engineering path overrides for isolated release data
- Deterministic release fixture seeding
- Page-level smoke definitions for Home, Search, Detail, Tags, and Profile
- Electron production startup decoupled from `pnpm start`
- Windows packaging configuration and scripts in repo

### Still blocked

- Playwright execution in this sandbox
- `better-sqlite3` Electron rebuild during packaging
