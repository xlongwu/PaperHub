# CLAUDE.md

## Project overview

PaperHub is a desktop application for aggregating, summarizing, and recommending academic papers and technical blog posts from arXiv, OpenAI GPT Blog, and Anthropic Claude Blog. It is built on top of a legacy TypeScript/Node.js digest engine and runs as a local-first desktop app (Electron or Tauri) with an embedded Node.js backend.

Key capabilities:
- Automated content collection from 3 sources (arXiv API, GPT Blog RSS, Claude Blog sitemap)
- LLM-powered summarization (Chinese + English) with source citations
- Auto-tagging: domain tags, source tags, type tags, model tags
- Local search: full-text (SQLite FTS5) + semantic (sqlite-vec)
- Daily recommendations: hot (time-decay) + personalized (user memory from digest files)
- User preference management: interest tags, browsing history, favorites

## Commands

```bash
pnpm install        # install dependencies
pnpm dev            # start desktop app in development mode
pnpm build          # build desktop app for production
pnpm test           # vitest (unit tests)
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint
pnpm lint:fix       # ESLint --fix
pnpm format         # Prettier --write src
pnpm format:check   # Prettier --check src
```

Required env vars for local runs:

```bash
# LLM provider (default: deepseek)
export LLM_PROVIDER=deepseek    # anthropic | openai | github-copilot | openrouter | deepseek

# DeepSeek (default)
export DEEPSEEK_API_KEY=sk-xxxxx

# Anthropic
# export ANTHROPIC_API_KEY=sk-ant-xxxxx

# OpenAI
# export OPENAI_API_KEY=sk-xxxxx

# GitHub Copilot — uses GITHUB_TOKEN

# OpenRouter
# export OPENROUTER_API_KEY=sk-or-xxxxx

# Embedding model (optional, default: openai text-embedding-3-small)
export EMBEDDING_PROVIDER=openai   # openai | local
export EMBEDDING_API_KEY=sk-xxxxx  # required if using openai
```

## Architecture

The system runs as a desktop app with three layers:

1. **Frontend Layer** (React 18 + TypeScript + Tailwind CSS) — UI components: Home (recommendations), Search, Article Detail, Tags, User Preferences.
2. **Backend Layer** (Node.js 20+ embedded) — Express/Fastify API server, collection scheduler, LLM summarization, search aggregation, recommendation engine, user memory system.
3. **Storage Layer** (local-first) — SQLite (`better-sqlite3`) for metadata, FTS5 for full-text search, `sqlite-vec` for vector search, local filesystem for content cache.

### Data flow

```
[Scheduler] → [Collectors] → [SQLite] → [Summarizer] → [Tagger] → [Indexer]
     ↑                                                            ↓
[User] ← [Frontend] ← [API] ← [Search/Recommendation Engine] ← [Vector DB]
```

## Source files

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Desktop app entry: starts API server + scheduler |
| `src/server.ts` | Express/Fastify API server: routes for search, recommendations, user prefs |
| `src/scheduler.ts` | Background task scheduler using `node-cron` for periodic collection |
| `src/db/index.ts` | SQLite database setup, connection pool, schema migration |
| `src/db/documents.ts` | Document CRUD, query by tags/time/source |
| `src/db/search.ts` | Full-text search (FTS5) + vector search (sqlite-vec) |
| `src/db/user.ts` | User preferences, browsing history, favorites |
| `src/collectors/types.ts` | `ContentCollector` interface and `RawDocument` type |
| `src/collectors/arxiv.ts` | arXiv API collector (cs.AI, cs.CL, cs.LG, cs.CV, cs.IR) |
| `src/collectors/gpt-blog.ts` | OpenAI GPT Blog RSS collector |
| `src/collectors/claude-blog.ts` | Anthropic Claude Blog sitemap collector (extends `web.ts` logic) |
| `src/summarizer.ts` | LLM summarization pipeline: prompt builder, cache check, result storage |
| `src/tagger.ts` | Auto-tagging: domain tags (arXiv mapping + LLM), source tags, type tags, model tags |
| `src/recommender/hot.ts` | Hot recommendation: time-decay scoring + freshness boost + source diversity |
| `src/recommender/personalized.ts` | Personalized recommendation: user memory from `digests/` files + tag matching |
| `src/recommender/memory.ts` | User memory system: extract keywords from digest files via TF-IDF/LLM |
| `src/search.ts` | Search orchestration: keyword search (FTS5) + semantic search (vector) + report generation |
| `src/providers/` | **Inherited from the legacy digest engine** — LLM Provider abstraction layer |
| `src/prompts.ts` | **Inherited/extended from the legacy digest engine** — Prompt builders for summarization |
| `src/i18n.ts` | **Inherited/extended from the legacy digest engine** — Bilingual strings: `Lang` type, UI labels, messages |
| `src/date.ts` | **Inherited from the legacy digest engine** — Date utilities |
| `src/config.ts` | **Inherited/extended from the legacy digest engine** — YAML config loader for desktop app settings |
| `src/web.ts` | **Inherited from the legacy digest engine** — Sitemap-based content fetching |
| `src/report.ts` | **Inherited from the legacy digest engine** — `callLlm` with concurrency limiter |

## Data sources

| Source | Method | Interval | Reused from |
|--------|--------|----------|-------------|
| **arXiv** | Official API (cs.AI, cs.CL, cs.LG, cs.CV, cs.IR) | Every 6 hours | `src/arxiv.ts` |
| **GPT Blog** | RSS feed parsing | Every 30 minutes | New (based on `web.ts` pattern) |
| **Claude Blog** | Sitemap parsing + content fetching | Every 30 minutes | `src/web.ts` |

**Explicitly excluded sources**: Zhihu (anti-scraping), Papers with Code, Semantic Scholar (real-time query only), any source requiring complex scraping or with anti-bot measures.

## Document model

```typescript
interface Document {
  id: string;                    // hash of source + original ID
  title: string;
  source: 'arxiv' | 'gpt_blog' | 'claude_blog';
  url: string;                   // original link
  publishedAt: string;           // ISO 8601
  authors: string[];
  abstract: string;              // original abstract/intro
  fullText?: string;             // cleaned content (stored in local file)
  language: 'zh' | 'en';
  domainTags: string[];          // e.g., Agent, RAG, Planning
  sourceTag: string;             // arXiv | GPT Blog | Claude Blog
  typeTag: 'paper' | 'blog' | 'tutorial' | 'review';
  yearTag: number;
  modelTags: string[];           // e.g., GPT-4, Claude 3
  summaryZh?: string;            // LLM-generated Chinese summary
  summaryEn?: string;            // LLM-generated English summary
  createdAt: string;
  updatedAt: string;
  isSummarized: boolean;
}
```

## Key conventions

### Language & i18n
- All bilingual strings are centralized in `src/i18n.ts`. Use the `Lang` type (`"zh" | "en"`) and `Record<Lang, string>` maps. Do not add inline bilingual ternaries elsewhere.
- Default UI language is Chinese (`zh`). English (`en`) is optional for summaries.

### LLM usage
- `callLlm(prompt, maxTokens?)` defaults to 4096 tokens. Summarization uses 2048 tokens by default.
- On 429 rate-limit errors `callLlm` retries up to 3 times with exponential backoff (5 s / 10 s / 20 s); the concurrency slot is released during the wait.
- The concurrency limiter (`LLM_CONCURRENCY = 5`) prevents 429s when many parallel LLM calls fire. Do not bypass it by calling SDK clients directly.
- LLM provider is selected via `LLM_PROVIDER` env var (default: `deepseek`). Valid values: `anthropic`, `openai`, `github-copilot`, `openrouter`, `deepseek`.
- Provider implementations live in `src/providers/`. Each file implements the `LlmProvider` interface. The factory in `src/providers/index.ts` validates the provider name and logs only the provider name — never API keys or endpoint URLs.
- Summarization cache: each document is summarized only once. Check `isSummarized` flag before calling LLM.
- Cost control: use GPT-4o-mini or DeepSeek-V3 for summarization; reserve expensive models for search report generation only.

### Storage
- **SQLite** is the single source of truth for metadata. Use `better-sqlite3` for synchronous operations.
- **FTS5** is used for full-text search on title, abstract, and tags.
- **sqlite-vec** is used for vector similarity search. Embedding dimension: 1536 (OpenAI) or 1024 (BGE).
- **Local filesystem** (`~/PaperHub/`) stores content cache, PDF downloads, and digest files.
- Do not introduce PostgreSQL, Elasticsearch, Redis, Milvus, or other external services.

### Tagging
- Domain tags are derived from arXiv categories (cs.AI → AI, cs.CL → NLP, cs.LG → ML) for papers; LLM few-shot classification for blogs.
- Source tags are auto-assigned based on collector: `arXiv`, `GPT Blog`, `Claude Blog`.
- Type tags are inferred from source: arXiv → `paper`, blogs → `blog`/`tutorial`.
- Model tags are extracted via regex: `GPT-4`, `Claude 3`, `Llama`, etc.
- Tags are stored as JSON arrays in SQLite columns.

### Recommendations
- **Hot recommendations**: score = `time_decay(publishedAt) * freshness_boost`. Exponential decay: highest weight within 24h, significant drop after 7 days. Ensure source diversity (no single source > 50% of recommendations).
- **Personalized recommendations**: based on user memory system only. Read `digests/` directory files, extract domain keywords via TF-IDF or LLM, build user interest tag list. Match document tags against user tags. Combine with time decay. No collaborative filtering, no multi-armed bandit, no embedding similarity.
- User can manually edit interest tags in preferences UI.

### Search
- Search is local-only: SQLite FTS5 for keyword + sqlite-vec for semantic similarity.
- Do not call external APIs (Semantic Scholar, arXiv real-time search) for search.
- Query is used directly without LLM rewriting (to reduce latency and cost).
- If results > 10: LLM generates a synthesis summary of top 5-10 most relevant items. If ≤ 10: summarize each item briefly.

### Collection
- All collectors implement the `ContentCollector` interface: `id`, `name`, `sourceTag`, `fetch()`, `interval`.
- Collectors run via `node-cron` scheduler, not GitHub Actions.
- Respect `robots.txt` and rate limits. Implement retry with exponential backoff.
- Deduplication: URL exact match + title similarity (edit distance < 0.3).

### User data
- User preferences, browsing history, and favorites are stored locally in SQLite.
- No user registration/login required for basic use. Optional local profile for preferences.
- All data stays local. No cloud sync by default.

## Adding a new data source

1. Create a new collector in `src/collectors/<name>.ts` implementing `ContentCollector`.
2. Register the collector in `src/scheduler.ts`.
3. Add source tag to `SOURCE_TAGS` in `src/i18n.ts`.
4. Add domain tag mapping rules in `src/tagger.ts` if applicable.
5. Update the Document interface if new fields are needed.
6. Add tests in `src/__tests__/collectors/<name>.test.ts`.

## Adding a new recommendation strategy

1. Implement the strategy in `src/recommender/<name>.ts`.
2. Export a function matching `(documents: Document[], userPrefs: UserPrefs) => Document[]`.
3. Register in `src/recommender/index.ts`.
4. Add UI slot in frontend if needed.

## Project structure

```
PaperHub/
├── src/
│   ├── collectors/          # Data source collectors
│   ├── db/                  # Database layer (SQLite, FTS5, sqlite-vec)
│   ├── recommender/         # Recommendation engines
│   ├── providers/           # LLM providers (inherited from the legacy digest engine)
│   ├── __tests__/           # Unit tests
│   ├── index.ts             # Desktop app entry
│   ├── server.ts            # API server
│   ├── scheduler.ts         # Background task scheduler
│   ├── summarizer.ts        # LLM summarization pipeline
│   ├── tagger.ts            # Auto-tagging service
│   ├── search.ts            # Search orchestration
│   ├── web.ts               # Sitemap fetching (reused)
│   ├── arxiv.ts             # arXiv collector (reused)
│   ├── prompts.ts           # Prompt builders (reused/extended)
│   ├── i18n.ts              # Bilingual strings (reused/extended)
│   ├── date.ts              # Date utilities (reused)
│   ├── config.ts            # Config loader (reused/extended)
│   └── report.ts            # LLM caller (reused)
├── digests/                 # Historical digest files (user memory source)
├── docs/                    # Documentation
├── package.json
├── tsconfig.json
├── vite.config.ts           # Frontend build
└── tauri.config.json        # or electron-builder config
```

## License

MIT — inherited from the upstream codebase lineage, same license.
