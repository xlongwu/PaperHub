# PaperHub 第二阶段文档

## 概述

第二阶段在第一阶段基础设施之上，完成了：
- **三源采集**：arXiv + GPT Blog + Claude Blog
- **自动标签分类**：arXiv 分类映射 + LLM 博客分类 + 模型名称提取
- **LLM 智能摘要**：中文摘要生成流水线
- **用户偏好管理**：兴趣标签、语言、摘要长度、推荐数量、浏览历史、收藏夹

---

## 新增模块清单

| 模块 | 文件 | 说明 |
|------|------|------|
| RSS 解析器 | `src/utils/rss.ts` | RSS 2.0 / Atom 解析，无外部依赖 |
| GPT Blog 采集器 | `src/collectors/gpt-blog.ts` | RSS 采集 OpenAI 博客 |
| Claude Blog 采集器 | `src/collectors/claude-blog.ts` | Sitemap + 页面内容采集 Anthropic 博客 |
| arXiv 分类映射 | `src/tagger/arxiv-mapping.ts` | cs.AI → [AI, Foundation Models] 等映射 |
| 模型名称提取 | `src/tagger/model-extract.ts` | 正则提取 GPT-4, Claude 3, Llama 3 等 |
| LLM 标签分类 | `src/tagger/llm-classify.ts` | Few-shot Prompt 分类博客文章，带缓存 |
| 摘要 Prompt | `src/summarizer/prompt.ts` | 中英文摘要模板构建 |
| 摘要流水线 | `src/summarizer/index.ts` | 单文档/批量摘要，并发控制 |
| 用户数据库层 | `src/db/user.ts` | 偏好、历史、收藏 CRUD |

---

## 三源采集器

| 采集器 | 来源 | 方式 | 频率 | 去重 |
|--------|------|------|------|------|
| arXiv | `src/collectors/arxiv.ts` | API (Atom feed) | 每 6 小时 | URL + 标题相似度 |
| GPT Blog | `src/collectors/gpt-blog.ts` | RSS 解析 | 每 30 分钟 | URL 精确匹配 |
| Claude Blog | `src/collectors/claude-blog.ts` | Sitemap + HTML | 每 30 分钟 | URL 精确匹配 |

### 采集器统一接口

```typescript
interface ContentCollector {
  id: string;
  name: string;
  sourceTag: string;
  interval: number;
  fetch(): Promise<RawDocument[]>;
}
```

---

## 标签体系

### 领域标签（Domain Tags）

| 来源 | 分类方式 | 标签示例 |
|------|---------|---------|
| arXiv | 分类映射 | AI, Foundation Models, NLP, LLM, ML, RAG, Multimodal |
| GPT Blog | LLM 分类 | Agents, Safety & Alignment, Research |
| Claude Blog | LLM 分类 | Agents, Safety & Alignment, Research |

### 模型标签（Model Tags）

通过正则从标题+摘要中提取：GPT-4, Claude 3, Llama 3, Gemini, DeepSeek, LangChain, AutoGPT 等。

### 标签分类流程

```
采集器返回 RawDocument
  → transformer 转换为 Document
  → tagger 自动分类：
     arXiv: 使用 arxiv-mapping.ts
     博客: 使用 llm-classify.ts (LLM few-shot)
  → model-extract.ts 提取模型名称
  → 入库 (domainTags + modelTags)
```

---

## 摘要流水线

### 流程

```
采集完成 → 检查 isSummarized
  → 未摘要 → 构建 Prompt → callLlm(prompt, 2048)
  → 存储 summaryZh → 更新 isSummarized = true
```

### Prompt 模板

```
请对以下学术论文进行摘要总结：

标题：{title}
作者：{authors}
来源：{source}
发布时间：{publishedAt}

原文内容：
{abstract}

要求：
1. 用中文输出，字数控制在 200-400 字
2. 包含：研究背景、核心方法、主要结论、创新点
3. 文末必须附带引用信息：**来源**: [{title}]({url})
```

### 批量摘要

- 并发控制：3 个 worker 并行处理
- 复用 `report.ts` 的 LLM 并发限制器（最多 5 个 in-flight）
- 每 30 分钟调度器自动检查并执行

---

## 用户偏好管理

### 数据库表

**user_preferences**
| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT PK | 偏好键 |
| value | TEXT | 偏好值 |

预设键：
- `interest_tags` — JSON 数组（默认 ["AI", "LLM", "Agents"]）
- `default_language` — `zh` | `en`（默认 `zh`）
- `summary_length` — `short` | `detailed`（默认 `short`）
- `daily_recommend_count` — 数字字符串（默认 `10`）

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/user/preferences` | 获取所有偏好 |
| POST | `/api/user/preferences` | 批量更新偏好 |
| GET | `/api/user/history` | 浏览历史（分页） |
| POST | `/api/user/history` | 记录浏览 |
| GET | `/api/user/favorites` | 收藏列表（分页） |
| POST | `/api/user/favorites` | 添加收藏 |
| DELETE | `/api/user/favorites/:id` | 取消收藏 |

---

## 调度器配置

| 任务 | Cron 表达式 | 说明 |
|------|------------|------|
| arXiv 采集 | `0 0 */6 * * *` | 每 6 小时 |
| GPT Blog 采集 | `0 */30 * * * *` | 每 30 分钟 |
| Claude Blog 采集 | `0 */30 * * * *` | 每 30 分钟 |
| 摘要生成 | `0 */30 * * * *` | 每 30 分钟检查 |

启动时立即执行一次全量采集和摘要。

---

## API 新增接口

### POST /api/collect

支持 `source`: `all` | `arxiv` | `gpt_blog` | `claude_blog`

**响应：**
```json
{
  "success": true,
  "data": {
    "arxiv": { "collected": 50 },
    "gpt_blog": { "collected": 3, "error": "RSS fetch failed" },
    "claude_blog": { "collected": 2 }
  }
}
```

### POST /api/summarize

触发摘要生成：
- `document_id` — 指定单篇文档
- 无 `document_id` — 批量处理所有待摘要文档

---

## 已知限制和待办事项

### 当前限制
- LLM 标签分类仅用于博客，arXiv 使用规则映射
- 摘要仅生成中文（`summaryEn` 预留）
- 博客正文获取可能因网站改版失败
- 未实现 FTS5 全文搜索（第三阶段）
- 未实现向量检索（第三阶段）
- 前端 UI 未开始（第三阶段后搭建 Electron/Tauri）

### 待办事项
- [ ] 英文摘要同时生成（`summaryEn`）
- [ ] 摘要质量关键词校验（幻觉检测）
- [ ] 采集失败通知机制
- [ ] 博客正文获取降级策略（RSS description → 原文页面）
- [ ] 标签分类结果持久化缓存（当前仅内存缓存）

---

## 运行命令

```bash
# 启动应用（自动采集 + 摘要 + API）
pnpm start

# 手动触发采集
curl -X POST http://localhost:3000/api/collect \
  -H "Content-Type: application/json" \
  -d '{"source": "all"}'

# 手动触发摘要
curl -X POST http://localhost:3000/api/summarize

# 更新用户偏好
curl -X POST http://localhost:3000/api/user/preferences \
  -H "Content-Type: application/json" \
  -d '{"interest_tags": "[\"AI\", \"RAG\"]", "default_language": "zh"}'
```

---

## 测试覆盖

新增测试：
- `src/__tests__/rss.test.ts` — RSS/Atom 解析（4 个测试）
- `src/__tests__/arxiv-mapping.test.ts` — arXiv 分类映射（5 个测试）
- `src/__tests__/model-extract.test.ts` — 模型名称提取（5 个测试）
- `src/__tests__/user.test.ts` — 用户偏好/历史/收藏（12 个测试）

总计：**251 个测试全部通过**

---

**文档版本**: v1.0  
**对应阶段**: 第二阶段（内容采集与摘要）  
**日期**: 2026-06-16
