# PaperHub

English | [中文](./README.zh.md)

PaperHub is a local-first desktop app for collecting, organizing, and reading academic papers and official AI blog content. It brings source collection, summarization, tagging, search, and recommendation into one desktop workflow so users can track research and product updates without depending on a cloud knowledge base.

## Purpose

PaperHub is designed for readers who need a focused intelligence desk for papers and technical writing:

- Track new papers and official AI blog posts in one place
- Build a private local archive instead of relying on browser tabs and scattered bookmarks
- Generate readable summaries and tags for faster triage
- Search content by keyword and semantics with quality-evaluated ranking
- Surface hot items and personalized recommendations from local usage data

## Core Features

- Local archive for papers and blog posts
- LLM-generated summaries in Chinese and English with long-text chunking
- Automatic tags for topic, source, type, and model references
- **Multi-path hybrid search** — exact → broad → CJK n-gram → vector with RRF fusion and feature re-ranking
- **Ollama local embedding** — run semantic search without cloud API keys
- **LLM connection management** — multi-provider runtime with per-provider configuration UI
- Hot recommendation and personalized recommendation flows
- Reading history, favorites, and user preference management
- Desktop workflow powered by Electron

## Data Sources

PaperHub currently focuses on structured and stable sources:

- **arXiv** — config-driven category collection with breakpoint-resume backfill
- **OpenAI GPT Blog** — RSS-based periodic collection
- **Anthropic Claude Blog** — sitemap-based periodic collection

## Tech Stack

- Desktop: Electron
- Frontend: React 18, Vite, React Router, React Query
- Backend: Node.js 20+, TypeScript, Express 5
- Storage: SQLite, `better-sqlite3` (FTS5 full-text), `sqlite-vec` (vector/cosine)
- AI — LLM: Anthropic, OpenAI, DeepSeek, OpenRouter, GitHub Copilot compatible provider layer
- AI — Embedding: OpenAI (`text-embedding-3-small`) + local Ollama (`qwen3-embedding`) with auto-fallback

## Search Engine

The search system uses a quality-evaluated multi-path architecture:

| Path | Strategy | Handles |
|------|----------|---------|
| Exact | Title/subtitle exact match | Precise lookups |
| Strict | FTS5 phrase match with CJK bigram | Structured queries |
| Broad | FTS5 token match with porter stemming | General keywords |
| CJK | N-gram decomposition for Chinese text | Mixed-language content |
| Vector | Cosine similarity via `sqlite-vec` | Semantic / conceptual matches |

Paths are merged via **Reciprocal Rank Fusion (RRF, k=60)** with feature-based re-ranking (recency boost, source weighting, tag overlap). Zero-result queries automatically fall back to broader strategies.

### Search Quality

Evaluated on a curated query corpus with standard IR metrics:

| Metric | v1 Baseline | v2 Engine | Improvement |
|--------|------------|-----------|-------------|
| Recall@20 | 74.44% | **90.00%** | +15.56% |
| NDCG@10 | 68.29% | **82.66%** | +14.37% |
| MRR@10 | 72.22% | **90.00%** | +17.78% |
| Zero-result rate | 13.33% | **0.00%** | −13.33% |

Run search evaluation:

```bash
pnpm search:eval          # quick evaluation
pnpm search:eval:save     # save results for comparison
pnpm search:eval:compare  # compare v2 vs v1 baseline
```

## Data Collection

**arXiv backfill** supports config-driven category collection with breakpoint-resume:

```bash
pnpm arxiv:backfill          # full backfill from configured categories
pnpm arxiv:backfill:recent   # backfill last 30 days only
```

Categories are configured in `scripts/backfill-arxiv.ts` and default to: `cs.AI`, `cs.CL`, `cs.LG`, `cs.CV`, `cs.IR`, `stat.ML`, `q-bio.NC`.

## Requirements

- Node.js 20.x
- `pnpm` 9+

## Installation

```bash
pnpm install
```

## Environment

PaperHub reads configuration from environment variables. A minimal local setup usually needs:

```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=your_key_here
```

Optional examples:

```bash
export OPENAI_API_KEY=your_key_here
export OPENROUTER_API_KEY=your_key_here
export DEEPSEEK_API_KEY=your_key_here
export GITHUB_TOKEN=your_token_here
export PAPERHUB_PORT=3000
```

For semantic search, PaperHub supports OpenAI and a local Ollama runtime.

OpenAI:

```bash
export EMBEDDING_PROVIDER=openai
export EMBEDDING_API_KEY=your_key_here
```

Ollama (no OpenAI key required):

```bash
ollama pull qwen3-embedding:0.6b

export EMBEDDING_PROVIDER=ollama
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b
export EMBEDDING_TIMEOUT_MS=30000
export EMBEDDING_BATCH_SIZE=8
export EMBEDDING_KEEP_ALIVE=5m
export EMBEDDING_TRUNCATE=true
export EMBEDDING_MAX_INPUT_CHARS=24000
```

`EMBEDDING_EXPECTED_DIMENSIONS` is optional. When omitted, PaperHub probes the model and uses its
actual output dimension. A model, dimension, endpoint, or document-text profile change safely
rebuilds the sqlite-vec index. During rebuilds or when Ollama is offline, keyword search remains
available and hybrid search falls back to FTS5.

The desktop profile page can test the active embedding connection and show/rebuild index progress.
Equivalent API endpoints are:

- `GET /api/settings/embedding`
- `POST /api/settings/embedding/test`
- `POST /api/index/embedding/rebuild`
- `GET /api/index/embedding/status`

## Development

```bash
pnpm install                   # install dependencies
pnpm api:dev                   # run API server (dev mode)
pnpm ui:dev                    # run web UI (dev mode)
pnpm desktop:dev               # run desktop app (dev mode)
```

### Quality Gates

```bash
pnpm typecheck                 # TypeScript type checking
pnpm lint                      # ESLint
pnpm lint:fix                  # ESLint auto-fix
pnpm format:check              # Prettier check
pnpm format                    # Prettier write
pnpm test                      # unit tests (vitest)
pnpm test:e2e                  # E2E tests (Playwright)
pnpm test:coverage             # test coverage report
```

### Search Evaluation

```bash
pnpm search:eval               # evaluate v2 search engine
pnpm search:eval:baseline      # evaluate v1 baseline (for comparison)
pnpm search:eval:save          # evaluate + save results
pnpm search:eval:compare       # evaluate + compare v2 vs v1
```

### arXiv Backfill

```bash
pnpm arxiv:backfill            # full backfill (breakpoint-resume)
pnpm arxiv:backfill:recent     # backfill last 30 days
```

## Desktop Build

Build an unpacked desktop directory (for development):

```bash
pnpm desktop:build:dir
```

Build desktop release artifacts (Windows: NSIS installer + portable exe):

```bash
pnpm desktop:build
```

The `electron-builder` config in `package.json` produces:
- `PaperHub-{version}-setup-x64.exe` — standard NSIS installer
- `PaperHub-{version}-portable-x64.exe` — portable executable

## LLM & Embedding Management

The desktop app includes a full LLM connection management UI at **Settings → LLM Connections**, supporting:

- Per-provider API key and endpoint configuration
- Model catalog browsing and selection
- Provider health check and runtime status
- Embedding provider configuration (OpenAI / Ollama)

The **User Center** page provides embedding index management:

- View current index status and document coverage
- Test embedding connection health
- Rebuild the vector index on demand

## Local Data

PaperHub stores application data locally. By default it uses a `PaperHub` directory in the user's home directory. You can override paths with environment variables such as:

- `PAPERHUB_DATA_DIR`
- `PAPERHUB_DB_PATH`
- `PAPERHUB_CACHE_DIR`
- `PAPERHUB_LOGS_DIR`

## License

MIT
