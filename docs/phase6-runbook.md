# PaperHub Phase 6 Runbook

## Reader

This document is for the engineer preparing the first PaperHub desktop release candidate.

After reading it, the reader should be able to run the phase-6 verification commands, understand which gates are already green, and know which blockers still prevent `v0.1.0` from being published.

## Scope

Phase 6 does not add new product features.

It closes the release loop for:

- Release smoke coverage for the release-candidate dataset and API
- Desktop packaging configuration for the Electron route
- Release verification commands
- Manual acceptance and baseline documentation

## Commands

### Core verification

```bash
pnpm typecheck
pnpm test
pnpm ui:build
pnpm test:e2e
```

### Seed a deterministic release fixture set

```bash
pnpm phase6:seed
```

This command resets the overridden PaperHub data directory and seeds a stable 23-document fixture corpus that covers:

- Home recommendations
- Search result pagination
- Search date-range filtering
- Document detail actions
- Tag browsing, sorting, and pagination
- User history and favorites

### Desktop packaging

```bash
pnpm desktop:build:dir
pnpm desktop:build
```

Both commands must be executed on a Windows host with Node.js 20.x LTS.

`desktop:build:dir` builds the unpacked Windows app directory first.

`desktop:build` targets Windows `nsis` and `portable` outputs.

Both commands route through `scripts/build-desktop.mjs`, which now:

- fails fast outside a Windows release host
- fails fast on unsupported Node majors
- runs `electron-builder install-app-deps --arch=x64` before packaging
- adds the Node compatibility flag required by the current `electron-builder` toolchain

## Current verification status

### Green now

- `pnpm typecheck`
- `pnpm test`
- `pnpm ui:build`
- `pnpm test:e2e`
- `node --check desktop/main.cjs`
- `node --check scripts/start-desktop.mjs`
- `node --check scripts/run-phase6-e2e.mjs`

- `pnpm desktop:build:dir`
  - The command now stops immediately on non-Windows hosts instead of pretending that a Windows artifact can be produced here.
  - A valid release build still needs a Windows Node 20 host to complete the Electron-native dependency step.

## Important release mechanics

### Backend startup no longer depends on `pnpm start`

The Electron main process now launches the local API by spawning the Electron runtime itself in Node mode:

- `process.execPath`
- `ELECTRON_RUN_AS_NODE=1`
- `--import tsx src/index.ts`

That change removes the previous packaging blocker where production mode still depended on a developer-only `pnpm` command.

### Runtime path overrides

The following environment variables can now isolate data and logs for release verification:

- `PAPERHUB_DATA_DIR`
- `PAPERHUB_DB_PATH`
- `PAPERHUB_LOGS_DIR`
- `PAPERHUB_CACHE_DIR`
- `PAPERHUB_PORT`

Use them whenever a release check must not touch the operator's normal `~/PaperHub` state.

### Phase 6 E2E now exercises the real release candidate path

`pnpm test:e2e` now uses:

- `scripts/run-phase6-e2e.mjs` to build the UI, seed fixtures, and run the release smoke
- `src/__tests__/phase6-release.test.tsx` against the real `/api/*` logic with seeded local state

## Current release blockers

### Blocker 1: Windows release host prerequisite

`pnpm desktop:build:dir` and `pnpm desktop:build` are intentionally restricted to Windows + Node 20.x so that Electron-native dependency preparation is performed in the real target environment.

Impact:

- A Windows release artifact cannot be produced from this Linux Node 22 sandbox.

What to do next:

- Switch to a Windows Node 20 host.
- Re-run `pnpm desktop:build:dir` before attempting `pnpm desktop:build`.

## Release gate

Do not mark `v0.1.0` releasable until all of the following are true:

- `pnpm typecheck` passes
- `pnpm test` passes
- `pnpm ui:build` passes
- `pnpm test:e2e` passes
- `pnpm desktop:build:dir` passes on Windows + Node 20.x
- `pnpm desktop:build` produces Windows artifacts on Windows + Node 20.x
- Manual acceptance finishes with no blocker items
