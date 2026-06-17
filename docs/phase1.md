# PaperHub 第一阶段文档

## 概述

第一阶段已完成 PaperHub 桌面端应用的基础骨架搭建，包括：
- 项目结构与依赖配置
- SQLite 本地存储层（Schema + CRUD + 迁移）
- 采集器框架与 arXiv 适配
- Express API 服务器
- node-cron 定时调度器
- 去重与重试机制
- 端到端测试覆盖

---

## 已完成的模块清单

| 模块 | 文件 | 说明 |
|------|------|------|
| 核心类型 | `src/types.ts` | Document, RawDocument, ContentCollector, API 响应类型 |
| 配置管理 | `src/config.ts` | 数据目录、PaperHub 配置、agents-radar 兼容配置 |
| 数据库连接 | `src/db/index.ts` | better-sqlite3 连接、Schema 迁移（v1） |
| 文档 CRUD | `src/db/documents.ts` | 插入、查询、更新、删除、统计 |
| 采集器接口 | `src/collectors/types.ts` | ContentCollector / RawDocument 类型定义 |
| arXiv 采集器 | `src/collectors/arxiv.ts` | 复用 agents-radar arxiv.ts，包装为 ContentCollector |
| 数据转换器 | `src/collectors/transformer.ts` | RawDocument → Document 标准化转换 |
| 去重工具 | `src/utils/dedup.ts` | Levenshtein 距离 + 标题相似度检测 |
| 重试工具 | `src/utils/retry.ts` | 指数退避重试 + 错误日志持久化 |
| API 服务器 | `src/api/server.ts` | Express 路由：health, documents, collect, stats |
| 定时调度器 | `src/scheduler.ts` | node-cron 定时任务 + 手动触发接口 |
| 应用入口 | `src/index.ts` | 数据库初始化 → API 启动 → 调度器启动 → 优雅关闭 |

---

## 数据库 Schema

### documents（文档表）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | SHA256(source+url) 前16位 |
| title | TEXT | 标题 |
| source | TEXT | 来源：arxiv / gpt_blog / claude_blog |
| url | TEXT UNIQUE | 原始链接 |
| published_at | TEXT | 发布时间（ISO 8601） |
| authors | TEXT | JSON 数组 |
| abstract | TEXT | 摘要 |
| full_text_path | TEXT | 本地全文缓存路径（可选） |
| language | TEXT | zh / en |
| domain_tags | TEXT | JSON 数组（领域标签，第二阶段填充） |
| source_tag | TEXT | 来源标签 |
| type_tag | TEXT | paper / blog / tutorial / review |
| year_tag | INTEGER | 年份 |
| model_tags | TEXT | JSON 数组（模型标签，第二阶段填充） |
| summary_zh | TEXT | 中文摘要（第二阶段填充） |
| summary_en | TEXT | 英文摘要（第二阶段填充） |
| created_at | TEXT | 入库时间 |
| updated_at | TEXT | 更新时间 |
| is_summarized | INTEGER | 0/1 |

### user_preferences（用户偏好）

| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 偏好键 |
| value | TEXT | 偏好值 |

### browsing_history（浏览历史）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| document_id | TEXT FK | 文档 ID |
| viewed_at | TEXT | 浏览时间 |

### favorites（收藏夹）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 |
| document_id | TEXT FK UNIQUE | 文档 ID |
| created_at | TEXT | 收藏时间 |

---

## API 接口文档

### GET /health
健康检查

**响应：**
```json
{ "success": true, "data": { "status": "ok", "timestamp": "..." } }
```

### GET /api/documents
分页获取文档列表

**参数：**
- `source` — 过滤来源（arxiv / gpt_blog / claude_blog）
- `from`, `to` — 发布时间范围（ISO 日期）
- `limit` — 每页数量（默认 20，最大 100）
- `offset` — 偏移量

**响应：**
```json
{
  "success": true,
  "data": [ /* Document[] */ ],
  "meta": { "page": 1, "limit": 20, "total": 50 }
}
```

### GET /api/documents/:id
获取单篇文档详情

### POST /api/collect
手动触发采集

**请求体：**
```json
{ "source": "arxiv" }  // 或 "all"
```

**响应：**
```json
{
  "success": true,
  "data": { "source": "arxiv", "collected": 50, "errors": [] }
}
```

### GET /api/stats
统计信息

**响应：**
```json
{
  "success": true,
  "data": {
    "total": 100,
    "today": 50,
    "bySource": { "arxiv": 100, "gpt_blog": 0, "claude_blog": 0 }
  }
}
```

---

## 定时调度

| 任务 | Cron 表达式 | 说明 |
|------|------------|------|
| arXiv 采集 | `0 0 */6 * * *` | 每 6 小时 |
| GPT Blog 采集 | `0 */30 * * * *` | 每 30 分钟（预留） |
| Claude Blog 采集 | `0 */30 * * * *` | 每 30 分钟（预留） |

启动时立即执行一次全量采集（便于开发测试）。

---

## 去重策略

1. **URL 精确匹配** — 采集前查询 `documentExists(url)`，已存在则跳过
2. **标题相似度** — Levenshtein 编辑距离 / 最大长度 < 0.3 视为重复

---

## 错误处理

- 采集失败时重试 3 次，指数退避（1s / 2s / 4s）
- 错误日志写入 `~/PaperHub/logs/errors/YYYY-MM-DD.log`
- 调度器日志写入 `~/PaperHub/logs/scheduler.log`
- 应用日志写入 `~/PaperHub/logs/app.log`

---

## 已知限制和待办事项

### 当前限制（第一阶段）
- 仅实现 arXiv 采集器，GPT Blog / Claude Blog 预留到第二阶段
- `domainTags` 和 `modelTags` 初始为空数组，第二阶段通过 LLM 填充
- `summaryZh` / `summaryEn` 为空，第二阶段实现摘要流水线
- 未实现向量检索（`sqlite-vec` 延后到第三阶段）
- 未实现 FTS5 全文搜索（延后到第三阶段）
- 前端 UI 未开始（第二阶段搭建 Electron/Tauri 骨架）

### 待办事项
- [ ] 采集日志持久化到本地文件（已部分实现，需完善格式）
- [ ] API 响应包含分页信息（已实现基础版）
- [ ] 数据库迁移机制支持版本升级（已实现 v1）
- [ ] 开发模式支持热重载（`pnpm dev` 已配置 tsx watch）
- [ ] 为 API 路由添加集成测试（使用 supertest）

---

## 运行命令

```bash
# 安装依赖
pnpm install

# 类型检查
pnpm typecheck

# 运行测试
pnpm test

# 启动应用（生产模式）
pnpm start

# 开发模式（热重载）
pnpm dev

# 格式化代码
pnpm format

# 代码检查
pnpm lint
```

---

## 数据目录

默认数据存储在 `~/PaperHub/`：
```
~/PaperHub/
├── data/
│   └── paperhub.db      # SQLite 数据库
├── logs/
│   ├── app.log          # 应用日志
│   ├── scheduler.log    # 调度器日志
│   └── errors/          # 错误日志
└── cache/               # 内容缓存（预留）
```

---

**文档版本**: v1.0  
**对应阶段**: 第一阶段（基础搭建）  
**日期**: 2026-06-16
