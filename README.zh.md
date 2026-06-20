# PaperHub

[English](./README.md) | 中文

PaperHub 是一个本地优先的桌面应用，用来采集、整理和阅读论文与 AI 官方技术博客内容。它把数据采集、摘要生成、标签整理、搜索和推荐放进同一套桌面工作流里，帮助用户持续跟踪研究进展和产品动态，而不必依赖云端知识库。

## 项目目标

PaperHub 面向需要持续获取论文和技术情报的用户，核心目标是：

- 将论文与官方博客更新集中到一个本地情报台
- 用本地档案替代零散标签页、收藏夹和临时笔记
- 通过摘要与标签降低信息筛选成本
- 支持关键词搜索和语义搜索
- 基于本地使用数据提供热点推荐与个性化推荐

## 核心能力

- 本地归档论文和博客文档
- 生成中英文摘要
- 自动打主题标签、来源标签、类型标签和模型标签
- 支持全文搜索、语义搜索和混合搜索
- 提供热点推荐和个性化推荐
- 提供阅读历史、收藏和用户偏好管理
- 通过 Electron 提供桌面端使用体验

## 数据来源

PaperHub 当前聚焦于结构稳定、适合长期采集的来源：

- arXiv
- OpenAI GPT Blog
- Anthropic Claude Blog

## 技术栈

- 桌面端：Electron
- 前端：React、Vite、React Router、React Query
- 后端：Node.js、TypeScript、Express
- 存储：SQLite、`better-sqlite3`、`sqlite-vec`
- AI 集成：兼容 Anthropic、OpenAI、OpenRouter、DeepSeek、GitHub Copilot 的 Provider 抽象层

## 环境要求

- Node.js 20.x
- `pnpm` 9+

## 安装

```bash
pnpm install
```

## 环境变量

PaperHub 通过环境变量读取运行配置。最小本地配置通常为：

```bash
export LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=your_key_here
```

可选示例：

```bash
export OPENAI_API_KEY=your_key_here
export OPENROUTER_API_KEY=your_key_here
export DEEPSEEK_API_KEY=your_key_here
export GITHUB_TOKEN=your_token_here
export PAPERHUB_PORT=3000
```

语义搜索支持 OpenAI 与本机 Ollama。

OpenAI：

```bash
export EMBEDDING_PROVIDER=openai
export EMBEDDING_API_KEY=your_key_here
```

Ollama（不需要 OpenAI Key）：

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

`EMBEDDING_EXPECTED_DIMENSIONS` 为可选校验项。未设置时，PaperHub 会自动探测模型的真实输出维度。
模型、维度、端点或文档向量文本规则变化时，系统会安全重建 sqlite-vec 索引。重建期间或 Ollama
离线时，关键词搜索仍保持可用，混合搜索会自动回退到 FTS5。

桌面端“个人中心”可以测试当前 Embedding 连接、查看索引进度并手动重建。对应 API：

- `GET /api/settings/embedding`
- `POST /api/settings/embedding/test`
- `POST /api/index/embedding/rebuild`
- `GET /api/index/embedding/status`

## 本地开发

启动 API 服务：

```bash
pnpm api:dev
```

启动前端界面：

```bash
pnpm ui:dev
```

启动桌面应用：

```bash
pnpm desktop:dev
```

## 常用命令

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm ui:build
pnpm desktop:start
```

## 桌面打包

生成 unpacked 桌面目录：

```bash
pnpm desktop:build:dir
```

生成桌面发布产物：

```bash
pnpm desktop:build
```

## 本地数据

PaperHub 默认把应用数据存到用户主目录下的 `PaperHub` 目录中，也可以通过环境变量覆盖：

- `PAPERHUB_DATA_DIR`
- `PAPERHUB_DB_PATH`
- `PAPERHUB_CACHE_DIR`
- `PAPERHUB_LOGS_DIR`

## 许可证

MIT
