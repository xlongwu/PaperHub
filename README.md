# PaperHub

English | [中文](./README.zh.md)

PaperHub is a local-first desktop app for collecting, organizing, and reading academic papers and official AI blog content. It brings source collection, summarization, tagging, search, and recommendation into one desktop workflow so users can track research and product updates without depending on a cloud knowledge base.

## Purpose

PaperHub is designed for readers who need a focused intelligence desk for papers and technical writing:

- Track new papers and official AI blog posts in one place
- Build a private local archive instead of relying on browser tabs and scattered bookmarks
- Generate readable summaries and tags for faster triage
- Search content by keyword and semantics
- Surface hot items and personalized recommendations from local usage data

## Core Features

- Local archive for papers and blog posts
- LLM-generated summaries in Chinese and English
- Automatic tags for topic, source, type, and model references
- Full-text, semantic, and hybrid search
- Hot recommendation and personalized recommendation flows
- Reading history, favorites, and user preference management
- Desktop workflow powered by Electron

## Data Sources

PaperHub currently focuses on structured and stable sources:

- arXiv
- OpenAI GPT Blog
- Anthropic Claude Blog

## Tech Stack

- Desktop: Electron
- Frontend: React, Vite, React Router, React Query
- Backend: Node.js, TypeScript, Express
- Storage: SQLite, `better-sqlite3`, `sqlite-vec`
- AI integration: Anthropic, OpenAI, OpenRouter, DeepSeek, GitHub Copilot compatible provider layer

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

For semantic search with real embeddings, provide `OPENAI_API_KEY` or `EMBEDDING_API_KEY`.

## Development

Run the API server:

```bash
pnpm api:dev
```

Run the web UI:

```bash
pnpm ui:dev
```

Run the desktop app:

```bash
pnpm desktop:dev
```

## Common Commands

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm ui:build
pnpm desktop:start
```

## Desktop Build

Build an unpacked desktop directory:

```bash
pnpm desktop:build:dir
```

Build desktop release artifacts:

```bash
pnpm desktop:build
```

## Local Data

PaperHub stores application data locally. By default it uses a `PaperHub` directory in the user's home directory. You can override paths with environment variables such as:

- `PAPERHUB_DATA_DIR`
- `PAPERHUB_DB_PATH`
- `PAPERHUB_CACHE_DIR`
- `PAPERHUB_LOGS_DIR`

## License

MIT
