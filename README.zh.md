# PaperHub

[English](./README.md) | 中文

PaperHub 是一个本地优先的桌面应用，用来采集、整理和阅读论文与 AI 官方技术博客内容。它把数据采集、摘要生成、标签整理、搜索和推荐放进同一套桌面工作流里，帮助用户持续跟踪研究进展和产品动态，而不必依赖云端知识库。

## 项目目标

PaperHub 面向需要持续获取论文和技术情报的用户，核心目标是：

- 将论文与官方博客更新集中到一个本地情报台
- 用本地档案替代零散标签页、收藏夹和临时笔记
- 通过摘要与标签降低信息筛选成本
- 支持关键词搜索和语义搜索，搜索结果经过质量评估与排序优化
- 基于本地使用数据提供热点推荐与个性化推荐

## 核心能力

- 本地归档论文和博客文档
- LLM 生成中英文摘要，支持长文本分块处理
- 自动打主题标签、来源标签、类型标签和模型标签
- **多路混合搜索** — 精确 → 严格 → 宽泛 → CJK n-gram → 向量，RRF 融合 + 特征重排序
- **Ollama 本地嵌入** — 无需云端 API 密钥即可运行语义搜索
- **LLM 连接管理** — 多 Provider 运行时，支持可视化配置
- 提供热点推荐和个性化推荐
- 提供阅读历史、收藏和用户偏好管理
- 通过 Electron 提供桌面端使用体验

## 数据来源

PaperHub 当前聚焦于结构稳定、适合长期采集的来源：

- **arXiv** — 配置驱动分类采集，支持断点续传
- **OpenAI GPT Blog** — RSS 定期采集
- **Anthropic Claude Blog** — Sitemap 定期采集

## 技术栈

- 桌面端：Electron
- 前端：React 18、Vite、React Router、React Query
- 后端：Node.js 20+、TypeScript、Express 5
- 存储：SQLite、`better-sqlite3`（FTS5 全文索引）、`sqlite-vec`（向量/余弦）
- AI — LLM：兼容 Anthropic、OpenAI、DeepSeek、OpenRouter、GitHub Copilot 的 Provider 抽象层
- AI — Embedding：OpenAI（`text-embedding-3-small`）+ 本地 Ollama（`qwen3-embedding`），支持自动回退

## 搜索引擎

搜索系统采用经过质量评估的多路召回架构：

| 路径   | 策略                            | 适用场景          |
| ------ | ------------------------------- | ----------------- |
| Exact  | 标题/副标题精确匹配             | 精准查找          |
| Strict | FTS5 短语匹配 + CJK 二元分词    | 结构化查询        |
| Broad  | FTS5 词元匹配 + porter 词干提取 | 通用关键词        |
| CJK    | N-gram 中文分解                 | 中文/混合语言内容 |
| Vector | `sqlite-vec` 余弦相似度         | 语义/概念匹配     |

多路结果通过 **倒数排名融合（RRF, k=60）** 合并，并用特征重排序（时效性加权、来源加权、标签重合度）进一步优化。零结果查询自动回退到更宽泛的策略。

### 搜索质量

在精选查询语料上的标准 IR 指标评估结果：

| 指标      | v1 基线 | v2 引擎    | 提升    |
| --------- | ------- | ---------- | ------- |
| Recall@20 | 74.44%  | **90.00%** | +15.56% |
| NDCG@10   | 68.29%  | **82.66%** | +14.37% |
| MRR@10    | 72.22%  | **90.00%** | +17.78% |
| 零结果率  | 13.33%  | **0.00%**  | −13.33% |

运行搜索评估：

```bash
pnpm search:eval          # 快速评估
pnpm search:eval:save     # 保存评估结果
pnpm search:eval:compare  # 对比 v2 与 v1 基线
```

## 数据采集

**arXiv 回填** 支持配置驱动分类采集与断点续传：

```bash
pnpm arxiv:backfill          # 全量回溯（断点续传）
pnpm arxiv:backfill:recent   # 最近 30 天回溯
```

分类在 `scripts/backfill-arxiv.ts` 中配置，默认为：`cs.AI`, `cs.CL`, `cs.LG`, `cs.CV`, `cs.IR`, `stat.ML`, `q-bio.NC`。

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

```bash
pnpm install                   # 安装依赖
pnpm api:dev                   # 启动 API 服务（开发模式）
pnpm ui:dev                    # 启动前端界面（开发模式）
pnpm desktop:dev               # 启动桌面应用（开发模式）
```

### 质量门禁

```bash
pnpm typecheck                 # TypeScript 类型检查
pnpm lint                      # ESLint
pnpm lint:fix                  # ESLint 自动修复
pnpm format:check              # Prettier 格式检查
pnpm format                    # Prettier 格式化
pnpm test                      # 单元测试（vitest）
pnpm test:e2e                  # 端到端测试（Playwright）
pnpm test:coverage             # 测试覆盖率报告
```

### 搜索评估

```bash
pnpm search:eval               # 评估 v2 搜索引擎
pnpm search:eval:baseline      # 评估 v1 基线（用于对比）
pnpm search:eval:save          # 评估并保存结果
pnpm search:eval:compare       # 评估并对比 v2 vs v1
```

### arXiv 回填

```bash
pnpm arxiv:backfill            # 全量回溯（断点续传）
pnpm arxiv:backfill:recent     # 最近 30 天回溯
```

## 桌面打包

Windows 桌面发布产物通过 Electron 生成。需要在 Windows 主机上执行：

```bash
pnpm desktop:build
```

`package.json` 中的 `electron-builder` 配置产出：

- `PaperHub-{version}-setup-x64.exe` — 标准 NSIS 安装程序
- `PaperHub-{version}-portable-x64.exe` — 绿色便携版

也可以双击 `Build-Windows.bat` 执行完整构建。

## LLM 与 Embedding 管理

桌面端内置完整的 LLM 连接管理界面（**设置 → LLM 连接**），支持：

- 按 Provider 配置 API 密钥和端点
- 模型目录浏览与选择
- Provider 健康检查与运行时状态监控
- Embedding Provider 配置（OpenAI / Ollama）

**个人中心** 页面提供 Embedding 索引管理：

- 查看索引进度与文档覆盖率
- 测试 Embedding 连接健康度
- 按需重建向量索引

## 本地数据

PaperHub 默认把应用数据存到用户主目录下的 `PaperHub` 目录中，也可以通过环境变量覆盖：

- `PAPERHUB_DATA_DIR`
- `PAPERHUB_DB_PATH`
- `PAPERHUB_CACHE_DIR`
- `PAPERHUB_LOGS_DIR`

## 许可证

MIT
