# PaperHub

English | [中文](./README.zh.md)

PaperHub is a local-first paper and AI blog intelligence desk. It collects papers and official blog content, stores them in a local SQLite archive, generates summaries and tags, and exposes search, recommendations, and a desktop reading workflow.

## Current Status

- The project is now centered on the `PaperHub` desktop app rather than the older digest-only positioning.
- Phase 6 code-side review and fixes are complete.
- The current release verification chain is green in this repo:
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm ui:build`
  - `pnpm test:e2e`
- The remaining release step is Windows packaging and final manual acceptance on a real `Windows + Node 20.x` machine.

## Core Capabilities

- Collect and normalize paper and blog documents into a local archive
- Store summaries, tags, browsing history, favorites, and profile preferences in SQLite
- Support keyword, semantic, and hybrid search
- Provide hot recommendations and personalized recommendations
- Provide document detail, tag browsing, and profile pages
- Run as a local desktop application through Electron

## Stack

- Backend: Node.js, TypeScript, Express
- Frontend: React, Vite, React Query, React Router
- Storage: SQLite, `better-sqlite3`, `sqlite-vec`
- Desktop: Electron

## Quick Start

### Prerequisites

- Node.js 20.x recommended
- `pnpm`

### Install

```bash
pnpm install
```

### Run the web app in development

Start the local API:

```bash
pnpm api:dev
```

Start the UI:

```bash
pnpm ui:dev
```

### Run the desktop app in development

```bash
pnpm desktop:dev
```

### Seed a deterministic release fixture set

```bash
pnpm phase6:seed
```

This seeds a stable local dataset for release-style verification of:

- home recommendations
- search
- document detail actions
- tags browsing and pagination
- history and favorites

## Verification

Run the core checks:

```bash
pnpm typecheck
pnpm test
pnpm ui:build
pnpm test:e2e
```

`pnpm test:e2e` currently runs the phase-6 release smoke chain:

- build the UI
- seed deterministic fixtures
- run the release smoke tests against the real local API logic

## Windows Packaging

Windows packaging is intentionally restricted to a real Windows release host.

Requirements:

- Windows x64
- Node.js 20.x

Commands:

```bash
pnpm desktop:build:dir
pnpm desktop:build
```

The first command builds the unpacked app directory. The second builds Windows installer artifacts.

## Release Documents

- [Phase 6 Runbook](./docs/phase6-runbook.md)
- [Phase 6 Manual Checklist](./docs/phase6-manual-checklist.md)
- [Phase 6 Baseline](./docs/phase6-baseline.md)
- [Phase 6 Review Report](./第六阶段审查报告.md)
- [Windows Packaging Task List](./第六阶段Windows打包与发布任务清单.md)
- [Windows On-Machine Checklist](./第六阶段Windows实机执行清单.md)

## Repository Notes

- Historical digest data is still present under `digests/`
- Some historical compatibility comments still reflect the pre-PaperHub project lineage
- The repository has already been migrated to a standalone `PaperHub` GitHub project, but code-level naming cleanup can continue incrementally
