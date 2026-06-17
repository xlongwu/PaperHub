# 论文情报站（Paper Intelligence Hub）项目方案文档

基于 [agents-radar](https://github.com/xlongwu/agents-radar) 构建的桌面端论文与技术文档聚合、智能总结与个性化推荐系统

---

## 1. 项目概况

### 1.1 项目背景
随着大语言模型（LLM）和 AI Agent 技术的飞速发展，学术界与工业界每天产出大量论文、技术博客和官方报告。研究人员和工程师亟需一种高效、可定制的情报获取方式，以从 GPT 官方博客、Claude 研究动态、arXiv 预印本等渠道中快速提炼关键信息，并以结构化、可溯源的形式呈现。

`agents-radar` 项目已具备对 AI 生态信息的监控与聚合能力，包括定时采集、LLM 摘要生成、多语言报告输出、GitHub Actions 调度等成熟机制。本项目将在此代码基础上进行扩展，打造一个**桌面端应用**，专注于论文与技术文档的情报聚合，提供智能总结、按需搜索、领域标签分类以及基于用户记忆的个性化推荐能力。

### 1.2 项目目标
构建一个**桌面端应用**，实现：
- 自动化采集 GPT 官方博客、Anthropic 官方博客、arXiv 的论文与技术文档
- 利用大型语言模型对内容进行摘要与总结，附带原文链接引用
- 为每篇内容自动打上领域标签、来源标签等
- 支持用户主动搜索特定主题，系统基于已有索引检索并生成综合总结报告
- 提供每日推荐面板，包含**热点推荐**（基于时效性）与**个性化推荐**（基于用户记忆系统）
- 保证信息的可追溯性、时效性和准确性

### 1.3 核心用户
- AI/ML 研究人员
- 技术开发者与工程师
- 产品经理与科技决策者
- 对前沿技术感兴趣的学习者

---

## 2. 需求分析

### 2.1 功能需求
- **多源内容采集**：定时采集以下数据源（仅支持无反爬机制的网站）：
  - **arXiv**：官方 API（cs.AI, cs.CL, cs.LG 等分类）
  - **OpenAI GPT Blog**：RSS/网页解析
  - **Anthropic Claude Blog**：sitemap/网页解析
- **内容存储与管理**：本地持久化存储原始链接、标题、摘要、发布时间、来源、标签等
- **智能摘要生成**：调用 LLM 对内容生成中文/英文摘要，包含关键方法、结论和创新点
- **引用与溯源**：每条总结必须包含原始链接、作者信息、发布时间；支持一键跳转原文
- **标签体系**：
  - 领域标签：如 Agent、RAG、Planning、RLHF、Prompt Engineering、Foundation Models、Multimodal、Safety & Alignment
  - 来源标签：arXiv、GPT Blog、Claude Blog
  - 辅助标签：论文、博客、综述、年份、模型名称（GPT-4、Claude 3 等）
- **按需搜索与总结**：用户输入自然语言调研主题，系统基于本地索引检索并生成综合总结报告
- **每日推荐**：
  - 热点推荐：基于内容时效性加权排序
  - 个性化推荐：基于用户记忆系统（从 radar 日报/周报/月报中提取的关键词偏好）
- **用户偏好管理**：支持设置兴趣领域标签，浏览历史记录

### 2.2 非功能需求
- **时效性**：arXiv 每日批量更新，博客每 30 分钟轮询
- **可扩展性**：数据源可插拔式添加（后续仅添加无反爬机制的来源）
- **成本控制**：LLM 调用优化，摘要缓存，避免重复处理
- **合规性**：尊重网站 robots.txt，遵守 API 使用条款
- **本地优先**：桌面端应用，数据主要存储在本地，保护用户隐私

---

## 3. 系统总体设计

### 3.1 系统架构概览

```
┌─────────────────────────────────────────┐
│           桌面端应用 (Electron/Tauri)    │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ 首页推荐 │ │ 搜索页  │ │ 文章详情 │  │
│  │ (热点+  │ │ (关键词 │ │ (摘要+   │  │
│  │  个性化) │ │ +语义)  │ │  原文)   │  │
│  └─────────┘ └─────────┘ └──────────┘  │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ 标签浏览 │ │ 用户偏好 │ │ 历史记录 │  │
│  └─────────┘ └─────────┘ └──────────┘  │
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│           本地服务层 (Node.js)            │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ 采集调度 │ │ 搜索聚合 │ │ 推荐引擎 │  │
│  └─────────┘ └─────────┘ └──────────┘  │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ LLM摘要 │ │ 标签分类 │ │ 用户记忆 │  │
│  │  服务   │ │  服务   │ │  系统   │  │
│  └─────────┘ └─────────┘ └──────────┘  │
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│           本地存储层                     │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ SQLite  │ │ 向量索引 │ │ 文件存储 │  │
│  │ (元数据) │ │ (语义检索)│ │ (缓存)   │  │
│  └─────────┘ └─────────┘ └──────────┘  │
└─────────────────────────────────────────┘
                    │
┌─────────────────────────────────────────┐
│           数据采集层                     │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ arXiv   │ │ GPT Blog│ │Claude Blog│  │
│  │  API    │ │  RSS    │ │ sitemap  │  │
│  └─────────┘ └─────────┘ └──────────┘  │
└─────────────────────────────────────────┘
```

### 3.2 基于 agents-radar 的集成

`agents-radar` 是 TypeScript/Node.js 项目，具备以下可直接复用的能力：

| 复用内容 | 说明 |
|---------|------|
| `src/web.ts` | Anthropic/OpenAI 官网 sitemap 采集逻辑，可直接复用并扩展 |
| `src/arxiv.ts` | arXiv API 采集逻辑，可直接复用 |
| `src/providers/` | LLM Provider 抽象层（Anthropic/OpenAI/DeepSeek/OpenRouter），直接复用 |
| `src/prompts.ts` | Prompt 构建模板，可扩展为论文/博客摘要模板 |
| `src/i18n.ts` | 国际化框架，支持中英双语输出 |
| `src/date.ts` | 日期处理工具 |
| `src/config.ts` | YAML 配置加载机制 |
| `src/report.ts` | LLM 调用与文件保存工具 |
| `.github/workflows/` | GitHub Actions 调度模板（改造为桌面端后台定时任务） |
| `digests/` 目录结构 | 日报/周报/月报的存储格式，作为用户记忆系统的数据来源 |

**集成策略**：
- 保留 `agents-radar` 的采集核心逻辑，将其封装为桌面端应用的数据采集模块
- 扩展 `web.ts` 以支持 GPT Blog 的 RSS 采集
- 将原有的 GitHub Actions 定时调度改造为桌面端的本地定时任务（如 `node-cron` 或系统级定时器）
- 将原有的 Markdown 文件输出改造为本地 SQLite 数据库存储
- 复用 `digests/` 目录下的历史日报/周报/月报文件，作为用户记忆系统的初始数据来源

---

## 4. 数据采集模块设计

### 4.1 数据源与采集策略

| 数据源 | 采集方式 | 更新频率 | 复用来源 |
|--------|---------|---------|---------|
| **arXiv** | 官方 API（cs.AI, cs.CL, cs.LG 等分类） | 每 6 小时 | 复用 `src/arxiv.ts` |
| **OpenAI GPT Blog** | RSS Feed 解析 | 每 30 分钟 | 新增采集器（参考 `src/web.ts` 模式） |
| **Anthropic Claude Blog** | Sitemap 解析 + 网页内容抓取 | 每 30 分钟 | 复用 `src/web.ts` |

**明确排除的数据源**：
- 知乎（反爬机制严格，版权风险高）
- Papers with Code（非核心需求，后续迭代考虑）
- Semantic Scholar（按需搜索阶段使用外部 API，非定时采集）
- 任何需要复杂爬虫或可能触发反爬的网站

### 4.2 采集器实现

每个采集器遵循统一的接口：

```typescript
interface ContentCollector {
  id: string;                    // 采集器标识
  name: string;                  // 显示名称
  sourceTag: string;             // 来源标签
  fetch(): Promise<RawDocument[]>; // 采集方法
  interval: number;               // 采集间隔（毫秒）
}
```

**arXiv 采集器**：
- 复用 `src/arxiv.ts` 的 `fetchArxivData()` 函数
- 查询分类：cs.AI, cs.CL, cs.LG, cs.CV, cs.IR
- 获取字段：title, authors, abstract, published, updated, pdf_url, categories

**GPT Blog 采集器**：
- 解析 RSS Feed（如 `https://openai.com/blog/rss.xml`）
- 获取字段：title, link, pubDate, content（或摘要）
- 若 RSS 内容不全，再请求原文页面补充

**Claude Blog 采集器**：
- 复用 `src/web.ts` 的 `fetchSiteContent()` 逻辑
- 解析 `https://www.anthropic.com/sitemap.xml` 或博客列表页
- 获取字段：title, url, published_date, content

### 4.3 数据标准化

采集到的原始条目统一映射为 `Document` 对象：

```typescript
interface Document {
  id: string;                    // 唯一标识（来源+原文ID的哈希）
  title: string;                 // 标题
  source: 'arxiv' | 'gpt_blog' | 'claude_blog';
  url: string;                   // 原始链接
  publishedAt: string;           // 发布时间（ISO 8601）
  authors: string[];             // 作者列表
  abstract: string;              // 原始摘要/导语
  fullText?: string;             // 清洗后的全文（可选，存储于本地文件）
  language: 'zh' | 'en';
  
  // 标签体系
  domainTags: string[];          // 领域标签（如 Agent, RAG, Planning）
  sourceTag: string;             // 来源标签（arXiv, GPT Blog, Claude Blog）
  typeTag: 'paper' | 'blog' | 'tutorial' | 'review'; // 文献类型
  yearTag: number;              // 年份
  modelTags: string[];           // 提及的模型（如 GPT-4, Claude 3）
  
  // 摘要与总结
  summaryZh?: string;            // 中文摘要（LLM生成）
  summaryEn?: string;            // 英文摘要（LLM生成）
  
  // 元数据
  createdAt: string;             // 入库时间
  updatedAt: string;             // 更新时间
  isSummarized: boolean;         // 是否已生成摘要
}
```

---

## 5. 数据处理与存储

### 5.1 存储方案（简化版）

采用**本地优先**的轻量存储方案，避免引入过多数据库组件：

| 存储组件 | 用途 | 选型 |
|---------|------|------|
| **主数据库** | 文档元数据、用户偏好、浏览历史 | SQLite（通过 `better-sqlite3`） |
| **向量索引** | 语义检索、相似推荐 | SQLite + `sqlite-vec` 扩展（或本地文件存储的 HNSW 索引） |
| **文件存储** | 原始内容缓存、PDF 下载、LLM 摘要结果 | 本地文件系统（`~/PaperHub/` 目录） |

**不使用**：PostgreSQL、Elasticsearch、Meilisearch、Milvus、Pinecone、Redis、MinIO/S3

**理由**：
- 桌面端应用以本地存储为主，SQLite 足以支撑数万条文档的查询
- `sqlite-vec` 提供轻量级向量检索能力，满足语义搜索需求
- 避免引入外部服务依赖，降低部署复杂度

### 5.2 数据库 Schema

```sql
-- 文档表
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  published_at TEXT,
  authors TEXT, -- JSON 数组
  abstract TEXT,
  full_text_path TEXT, -- 本地文件路径
  language TEXT,
  domain_tags TEXT, -- JSON 数组
  source_tag TEXT,
  type_tag TEXT,
  year_tag INTEGER,
  model_tags TEXT, -- JSON 数组
  summary_zh TEXT,
  summary_en TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  is_summarized INTEGER DEFAULT 0
);

-- 向量索引表（sqlite-vec）
CREATE VIRTUAL TABLE document_embeddings USING vec0(
  document_id TEXT,
  embedding float[1536]  -- 维度根据 embedding 模型确定
);

-- 用户偏好表
CREATE TABLE user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 浏览历史表
CREATE TABLE browsing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT,
  viewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

-- 收藏表
CREATE TABLE favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
```

### 5.3 内容去重

基于 **URL 精确匹配** + **标题相似度（编辑距离 < 0.3）** 进行去重。

对于同一论文的多源出现（如 arXiv 论文后被博客引用），保留为独立记录但建立关联关系（后续迭代）。

---

## 6. 内容总结与引用生成

### 6.1 摘要流水线

```
新内容入库 → 检查摘要缓存 → 若无缓存则进入 LLM 摘要流程 → 存储结果
```

**LLM 摘要模板**（复用 `agents-radar` 的 Prompt 构建模式）：

```
请对以下 {{type}} 进行摘要总结：

标题：{{title}}
作者：{{authors}}
来源：{{source}}
发布时间：{{publishedAt}}

原文内容：
{{content}}

要求：
1. 用 {{language}} 输出，字数控制在 200-400 字
2. 包含：研究背景、核心方法、主要结论、创新点
3. 文末必须附带引用信息：**来源**: [{{title}}]({{url}})
```

**语言策略**：
- 英文原文 → 生成中文摘要（默认）+ 英文摘要（可选）
- 中文原文 → 生成中文摘要

### 6.2 引用格式

每条总结呈现格式：

```markdown
## {{title}}

**作者**：{{authors}}
**来源**：{{sourceTag}}
**发布时间**：{{publishedAt}}

{{summary}}

**来源链接**：[阅读原文]({{url}})
**标签**：{{domainTags}} {{typeTag}} {{modelTags}}
```

### 6.3 质量保障

- **摘要缓存**：同一文档的摘要只生成一次，存储于本地数据库
- **LLM 成本控制**：
  - 摘要使用性价比高的模型（如 GPT-4o-mini 或 DeepSeek-V3）
  - 长文分段摘要，控制 token 消耗
- **幻觉检测**：摘要中提到的关键术语必须在原文中出现（简单关键词匹配校验）

---

## 7. 标签体系

### 7.1 领域标签

基于 arXiv 分类体系 + 常见 AI 领域构建静态标签树：

| 根级领域 | 子标签 |
|---------|--------|
| 基础模型 (Foundation Models) | LLM, Transformer, Pre-training, Scaling |
| 智能体 (Agents) | AutoGPT, Multi-Agent, Tool Use, Planning |
| 检索增强生成 (RAG) | Vector DB, Retrieval, Knowledge Graph |
| 提示工程 (Prompt Engineering) | CoT, Few-shot, Prompt Optimization |
| 安全与对齐 (Safety & Alignment) | RLHF, Constitutional AI, Red Teaming |
| 多模态 (Multimodal) | Vision-Language, Audio, Video |
| 训练与微调 (Training & Fine-Tuning) | LoRA, QLoRA, SFT, DPO |
| 推理与部署 (Inference & Deployment) | Quantization, Distillation, Edge AI |

**标签生成策略**：
1. **arXiv 论文**：直接使用 arXiv 分类（cs.AI → AI, cs.CL → NLP, cs.LG → ML）映射到领域标签
2. **博客文章**：使用 LLM 根据标题和摘要自动分类（few-shot prompting），提示词中提供标签树作为参考
3. **辅助标签**：
   - 文献类型：通过来源判断（arXiv → 论文, 博客 → 博客/教程）
   - 年份：从发布时间提取
   - 模型名称：通过正则匹配（GPT-4, Claude 3, Llama 等）

### 7.2 来源标签

自动根据采集来源标记：
- `arXiv`
- `GPT Blog`
- `Claude Blog`

### 7.3 标签存储

标签以 JSON 数组形式存储于 `documents.domain_tags`、`documents.model_tags` 字段。

前端提供标签云/标签树浏览界面，支持点击标签筛选内容。

---

## 8. 推荐系统

### 8.1 推荐策略（简化版）

**热点推荐**（无需用户配置）：
- 评分公式：`score = time_decay(publishedAt) * freshness_boost`
- 时间衰减：使用指数衰减函数，24 小时内权重最高，7 天后显著降低
- 新鲜度加权：当日新内容额外加分
- 来源多样性：确保推荐列表中各来源占比均衡（避免单一来源刷屏）
- 每日凌晨计算 TOP N 条目，生成"今日热点"列表

**个性化推荐**（基于用户记忆系统）：
- **核心机制**：从 `agents-radar` 的日报/周报/月报文件中提取关键词，构建用户兴趣画像
- **记忆数据来源**：
  - 读取 `digests/` 目录下的历史报告文件（`ai-*.md`）
  - 使用 LLM 或关键词提取算法（TF-IDF）从报告内容中提取高频领域关键词
  - 将提取的关键词作为用户的初始兴趣标签
- **推荐逻辑**：
  1. 获取用户兴趣标签列表（如 ["Agent", "RAG", "Claude"]）
  2. 对新入库内容，计算其标签与用户兴趣标签的匹配度
  3. 匹配度高的内容优先推荐
  4. 结合时间衰减，确保推荐内容不过时
- **用户可配置**：
  - 前端提供兴趣标签管理界面，用户可增删改兴趣标签
  - 浏览历史自动记录，可作为辅助推荐信号（后续迭代）

**明确不实现的推荐方法**：
- 协同过滤（用户量不足，冷启动问题）
- 多臂老虎机（复杂度过高，收益不明确）
- 基于 embedding 相似度的推荐（计算成本高，后续迭代考虑）
- 基于用户行为（点赞/收藏/浏览时长）的深度学习推荐模型

### 8.2 推荐位布局

- **首页横幅**：今日热点 Top 5，卡片展示标题、摘要片段、标签、来源
- **"为你推荐"区域**：基于用户兴趣标签的匹配内容，展示 10-20 条
- **时间线视图**：按发布时间倒序展示所有内容，支持按标签筛选

---

## 9. 用户交互与搜索功能

### 9.1 按需调研搜索

用户输入自然语言查询（如"大模型 Agent 最新进展"），后端处理流程：

1. **查询理解**：直接使用用户输入的关键词（不经过 LLM 改写，降低延迟和成本）
2. **本地检索**：
   - 全文搜索：SQLite FTS5 扩展（标题、摘要、标签）
   - 语义搜索：向量索引（`sqlite-vec`）计算查询与文档的相似度
3. **结果聚合**：合并全文搜索和语义搜索结果，去重排序
4. **报告生成**：
   - 若结果数量 > 10：由 LLM 生成综述摘要，选取最相关的 5-10 条详细总结
   - 若结果数量 ≤ 10：对所有结果逐一简短总结
5. **输出格式**：调研报告包含总体概述、各条目总结和完整引用列表

**明确不实现**：
- 外部 API 实时搜索（Semantic Scholar、arXiv API 实时查询）
- 多子查询并行搜索
- PDF 导出（后续迭代）

### 9.2 用户个人空间

- **兴趣标签管理**：增删改领域标签，系统据此调整个性化推荐
- **浏览历史**：查看已读文章列表
- **收藏夹**：收藏感兴趣的文章
- **偏好设置**：
  - 默认语言（中文/英文）
  - 摘要长度偏好（简短/详细）
  - 每日推荐数量

---

## 10. 技术架构与选型

### 10.1 桌面端框架

- **框架**：**Electron** 或 **Tauri**
  - 推荐 **Tauri**（Rust 后端 + Web 前端），体积更小、性能更好、安全性更高
  - 若团队熟悉 Electron，也可选用（Node.js 后端与 `agents-radar` 代码更兼容）
- **前端框架**：React 18 + TypeScript
- **UI 库**：Tailwind CSS + Headless UI / Radix UI
- **状态管理**：Zustand 或 React Context
- **数据请求**：React Query / SWR

### 10.2 后端（桌面端内嵌）

- **运行时**：Node.js 20+（与 `agents-radar` 保持一致）
- **API 层**：Express 或 Fastify（轻量 HTTP 服务，供前端调用）
- **定时任务**：`node-cron`（替代 GitHub Actions 的定时调度）
- **进程管理**：桌面端启动时同时启动 Node.js 后端服务

### 10.3 数据存储

| 组件 | 选型 | 说明 |
|------|------|------|
| 关系数据库 | SQLite (`better-sqlite3`) | 本地轻量，无需额外服务 |
| 全文检索 | SQLite FTS5 | 内置扩展，满足关键词搜索 |
| 向量检索 | `sqlite-vec` | SQLite 向量扩展，支持语义相似度计算 |
| 文件存储 | 本地文件系统 | `~/PaperHub/` 目录存储缓存内容 |

**不使用**：PostgreSQL、Elasticsearch、Meilisearch、Milvus、Pinecone、Redis、RabbitMQ

### 10.4 AI 服务

- **LLM 调用**：复用 `agents-radar` 的 `src/providers/` 抽象层
  - 默认提供商：DeepSeek（性价比高）或 OpenAI（GPT-4o-mini）
  - 用户可配置 API Key 和 Provider
- **Embedding 模型**：
  - 默认：`text-embedding-3-small`（OpenAI）或 `bge-small-en-v1.5`（本地部署）
  - 本地部署方案：使用 `onnxruntime-node` 加载轻量 embedding 模型，避免 API 调用成本
- **标签分类**：
  - 优先使用规则（arXiv 分类映射 + 关键词匹配）
  - 复杂情况使用 LLM few-shot 分类

### 10.5 部署与打包

- **桌面端打包**：
  - Tauri：`tauri build` 生成 Windows/macOS/Linux 安装包
  - Electron：`electron-builder` 生成安装包
- **自动更新**：集成 Tauri/Electron 的自动更新机制
- **CI/CD**：GitHub Actions 构建和发布桌面端安装包

---

## 11. 项目实施计划

| 阶段 | 时间 | 主要任务 |
|------|------|---------|
| 第1阶段：基础搭建 | 2周 | Fork `agents-radar` 代码库；搭建桌面端应用骨架（Tauri/Electron + React）；集成 SQLite 本地存储；复用 arXiv 采集器 |
| 第2阶段：内容采集与摘要 | 2周 | 实现 GPT Blog RSS 采集器；复用 Claude Blog sitemap 采集器；实现 LLM 摘要流水线；建立领域标签规则映射 |
| 第3阶段：搜索与标签 | 2周 | 实现 SQLite FTS5 全文搜索；集成 `sqlite-vec` 向量检索；实现标签浏览与筛选；完善用户偏好管理 |
| 第4阶段：推荐系统 | 2周 | 实现热点推荐（时间衰减排序）；实现用户记忆系统（从 `digests/` 提取关键词）；实现个性化推荐（标签匹配） |
| 第5阶段：前端界面 | 2周 | 完成首页（热点+个性化推荐）、搜索页、文章详情页、标签页、用户中心；实现桌面端打包 |
| 第6阶段：测试与发布 | 2周 | 端到端测试、性能优化、成本控制调优、用户测试、文档编写；发布首个版本 |
| 第7阶段：迭代 | 持续 | 添加新数据源（仅限无反爬网站）、优化推荐算法、多语言支持、导出功能 |

**总计**：12 周（MVP 版本）

---

## 12. 风险与挑战

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| **数据源不稳定** | 博客改版导致采集失败 | 监控采集健康度，实现降级（仅保存标题和链接）；提供手动刷新按钮 |
| **LLM 成本** | 大量摘要生成费用高 | 摘要缓存机制；使用性价比模型（DeepSeek/GPT-4o-mini）；本地 embedding 模型 |
| **LLM 幻觉** | 摘要质量不准确 | 严格 Prompt 约束（要求基于原文）；关键词校验；用户反馈机制 |
| **本地存储膨胀** | 长期运行后数据库变大 | 定期清理过期内容（保留 90 天热点）；压缩历史数据 |
| **arXiv API 限制** | 请求频率受限 | 合理设置采集间隔（6小时）；实现请求重试和退避 |
| **用户冷启动** | 新用户无记忆数据 | 提供默认兴趣标签选择；使用热点推荐填补 |

---

## 13. 附录

### 13.1 agents-radar 复用清单

| 文件 | 复用方式 |
|------|---------|
| `src/arxiv.ts` | 直接复用，封装为 arXiv 采集器 |
| `src/web.ts` | 复用 sitemap 解析逻辑，扩展 GPT Blog 支持 |
| `src/providers/` | 完整复用 LLM Provider 抽象层 |
| `src/prompts.ts` | 扩展为论文/博客摘要 Prompt 模板 |
| `src/i18n.ts` | 复用国际化框架，扩展新文案 |
| `src/config.ts` | 复用 YAML 配置加载，扩展桌面端配置项 |
| `src/date.ts` | 直接复用 |
| `src/report.ts` | 复用 LLM 调用和文件保存逻辑 |
| `.github/workflows/daily-digest.yml` | 参考定时调度逻辑，改造为 `node-cron` 任务 |
| `digests/` 目录 | 作为用户记忆系统的数据来源 |

### 13.2 技术栈对比（原方案 vs 修订方案）

| 层面 | 原方案 | 修订方案 | 变更理由 |
|------|--------|---------|---------|
| 应用形态 | Web 平台 | 桌面端应用 | 本地优先，保护隐私，降低后端复杂度 |
| 后端语言 | FastAPI (Python) | Node.js (TypeScript) | 复用 `agents-radar` 代码资产 |
| 数据库 | PostgreSQL + ES + Milvus + Redis | SQLite + FTS5 + sqlite-vec | 本地轻量，避免外部依赖 |
| 消息队列 | Redis Streams / RabbitMQ | 无（直接调用） | 桌面端无需解耦，简化架构 |
| 对象存储 | MinIO/S3 | 本地文件系统 | 无需云服务 |
| 数据源 | 7+ 来源（含知乎） | 3 来源（arXiv + GPT + Claude） | 规避反爬和合规风险 |
| 推荐系统 | 协同过滤 + 多臂老虎机 | 标签匹配 + 时间衰减 | 简化实现，聚焦核心需求 |
| 搜索 | ES + 向量库 + 外部 API | SQLite FTS5 + sqlite-vec | 本地优先，降低复杂度 |

### 13.3 开源协议

本项目基于 MIT 协议，在 `agents-radar` 基础上衍生，保持相同许可证。

---

**文档版本**: v2.0  
**最后更新**: 2026-06-16
