# PaperHub V3：Web 搜索、本地知识库与 MCP / Skills 接入完善方案

## 1. 文档目的

本文档用于规划 PaperHub 从“本地知识库搜索工具”升级为“Web 内容发现 + 本地知识管理 + Agent 能力开放平台”的完整实施方案。

V3 主要解决以下问题：

1. 当前搜索只能覆盖已经进入本地数据库的内容，无法满足用户对最新论文、官方博客和技术文章的即时检索需求。
2. 后台定时采集器只能覆盖预设来源，不能替代用户主动发起的 Web 查询。
3. Web 搜索结果与本地持久化文档在生命周期、数据完整度和搜索语义上存在明显差异，需要建立独立模型。
4. 多个 Web Provider 返回的数据结构、相关度分数和内容质量不同，需要统一规范化、去重和排序。
5. Web 内容需要进入总结流程，但网页、PDF 和第三方 MCP 返回内容均属于不可信外部数据，需要增加安全边界。
6. 用户对 Web 结果执行保存、收藏或下载后，需要无缝进入现有标签、总结和本地索引流程。
7. 后续需要通过 MCP 和 Skills 将 PaperHub 能力开放给外部 Agent，但不能让 MCP 绕过搜索编排、数据库和安全层。

---

## 2. 产品定位调整

V3 将 PaperHub 的搜索能力拆分为两个明确入口：

```text
Web 搜索
用于发现尚未保存到本地的论文、官方博客、技术文章、文档和代码仓库

本地知识库
用于检索用户已经保存、收藏、下载或由后台采集器入库的内容
```

默认用户流程调整为：

```text
用户发起 Web 搜索
→ 系统识别查询意图
→ 选择并调用合适的 Web Provider
→ 聚合、规范化、去重和排序
→ 返回分组结果和 Provider 状态
→ 基于前 5～10 条结果生成带引用的综合概览
→ 用户按需生成单条深度总结
→ 用户执行保存、收藏或下载
→ Web 结果转换为本地 Document
→ 进入统一标签、总结和索引流程
→ 后续通过本地知识库搜索
```

核心边界如下：

1. Web 搜索结果默认是瞬时数据。
2. 未保存的 Web 结果不进入 `documents`、FTS5 和 sqlite-vec。
3. 用户执行保存、收藏或下载后，结果才进入本地知识库。
4. Web 搜索失败时不得隐式调用本地搜索。
5. 本地搜索无结果时不得自动调用 Web 搜索。
6. 第一阶段不对 Web 和本地结果进行无提示混排。
7. 后台采集器继续负责首页推荐和固定来源发现，不作为用户主动 Web 搜索结果。

---

## 3. 当前项目基础

PaperHub 当前已经具备：

* React 搜索界面；
* Express API；
* SQLite 元数据存储；
* FTS5 全文搜索；
* sqlite-vec 语义搜索；
* Keyword、Semantic 和 Hybrid 搜索；
* 搜索反馈和质量统计；
* LLM Provider 配置；
* 文档总结服务；
* 标签生成服务；
* 统一文档入库服务；
* 收藏、浏览历史和推荐；
* Electron 桌面打包。

V3 应复用这些已有能力，避免形成两套相互独立的文档、总结和索引系统。

### 3.1 必须复用的能力

* 所有持久化内容继续通过统一文档入库服务处理。
* 标签生成继续使用现有 Tagger。
* 本地总结继续使用现有 Summarizer。
* 向量索引继续使用现有 Search Indexer。
* 收藏继续基于本地 Document。
* 本地知识库搜索继续复用 `hybridSearch`。
* Web Provider 密钥管理应复用现有 Connection 配置模式。
* Web Summary 必须复用现有 LLM 并发限制和错误重试机制。

### 3.2 必须隔离的能力

* Web 搜索结果不能直接使用持久化 `Document` 模型。
* Web Provider 不能直接写入数据库。
* Search MCP 不能直接执行 SQL。
* Provider 原始相关度不能直接跨 Provider 比较。
* Web 搜索会话不能进入 FTS5 和向量索引。
* 网页正文不能未经安全清洗直接传入 LLM。
* Web Result 不能直接成为 Favorite。

---

## 4. 总体架构

```text
┌───────────────────────────────────────────────────────────┐
│                         Search UI                         │
│            Web Search         Local Library              │
└───────────────────────┬───────────────────────────────────┘
                        │
              ┌─────────┴─────────┐
              │                   │
       Web Search API       Local Search API
              │                   │
     Web Search Service        hybridSearch
              │
       Query Planner / Router
              │
 ┌────────────┼───────────────┬───────────────┬─────────────┐
 │            │               │               │             │
arXiv      OpenAlex         Tavily          Brave       Search MCP
 │            │               │               │             │
 └────────────┴───────────────┴───────────────┴─────────────┘
                        │
                Result Normalization
                        │
                  Entity Resolution
                        │
               Deduplication / Merge
                        │
             Weighted Rank Aggregation
                        │
               Content Type Grouping
                        │
         Evidence Extraction / Citation Summary
                        │
                 24h Session Cache
                        │
                Save / Favorite / Download
                        │
                 Web Save Service
                        │
              Unified Ingestion Service
                        │
        Document + Tags + Summary + Local Index
```

---

# 第一部分：Web 搜索设计

## 5. 搜索入口

### 5.1 Web 搜索

Web 搜索作为搜索页默认入口，用于：

* 搜索最新论文；
* 搜索未被后台采集器覆盖的论文；
* 搜索官方模型博客；
* 搜索技术博客和教程；
* 搜索官方文档；
* 搜索论文对应代码仓库；
* 搜索特定时间范围内的新内容；
* 将有价值的结果保存到本地知识库。

搜索范围定义为：

```ts
type WebSearchScope =
  | "academic"
  | "technical"
  | "mixed";
```

具体语义：

* `academic`：优先搜索论文和学术元数据。
* `technical`：优先搜索官方博客、技术文章、文档和代码仓库。
* `mixed`：同时搜索论文和技术内容，但按内容类型分组展示。

### 5.2 本地知识库

本地知识库继续支持：

* Keyword；
* Semantic；
* Hybrid；
* 来源过滤；
* 标签过滤；
* 日期过滤；
* 本地搜索报告；
* 搜索反馈；
* 搜索质量统计。

现有接口继续兼容：

```text
GET /api/search
```

新增明确别名：

```text
GET /api/local-search
```

两个接口在兼容期内调用同一 Local Search Service。

### 5.3 Web 与本地结果的关系

第一阶段不进行全局混排。

搜索界面使用：

```text
Web 搜索 | 本地知识库
```

后续可增加：

```text
搜索全部
```

但结果必须分区展示：

```text
本地知识库结果
Web 新发现结果
```

不能将本地和 Web 结果无说明地放在同一个排序列表中。

---

## 6. Web 查询请求模型

```ts
interface WebSearchRequest {
  query: string;

  scope:
    | "academic"
    | "technical"
    | "mixed";

  contentTypes?: Array<
    | "paper"
    | "official_blog"
    | "technical_article"
    | "documentation"
    | "repository"
  >;

  dateRange?: {
    start?: string;
    end?: string;
  };

  languages?: string[];

  providers?: string[];

  includeDomains?: string[];
  excludeDomains?: string[];

  sort?: "relevance" | "recent";

  maxResults?: number;

  searchBudget?:
    | "low_cost"
    | "balanced"
    | "broad";

  autoSummarize?: boolean;

  allowQueryRewrite?: boolean;
}
```

---

## 7. 查询规划

Web Search Service 不应直接将原始查询广播给所有 Provider，而应先生成查询计划。

```ts
interface WebSearchPlan {
  originalQuery: string;
  normalizedQuery: string;

  intent:
    | "topic_discovery"
    | "exact_identifier"
    | "paper_lookup"
    | "author_lookup"
    | "recent_updates"
    | "code_lookup"
    | "general_research";

  scope:
    | "academic"
    | "technical"
    | "mixed";

  concepts: {
    must: string[];
    should: string[];
    exclude: string[];
  };

  providerCalls: ProviderSearchCall[];

  budget: {
    maxProviderCalls: number;
    maxResultsPerProvider: number;
    maxTotalResults: number;
    maxTotalLatencyMs: number;
    maxEstimatedCredits?: number;
  };

  rewrite?: {
    applied: boolean;
    rewrittenQuery?: string;
    reason?: string;
  };
}
```

### 7.1 查询路由规则

#### DOI 查询

```text
10.xxxx/xxxx
```

路由：

```text
OpenAlex 精确检索
→ 必要时通用 Web Provider 补充
```

#### arXiv ID 查询

```text
2501.12345
arXiv:2501.12345
```

路由：

```text
arXiv 精确查询
→ OpenAlex 元数据补全
```

#### 论文主题查询

```text
synthetic data for large language models
```

路由：

```text
arXiv
+ OpenAlex
```

#### 官方博客查询

```text
OpenAI reasoning model official blog
```

路由：

```text
Tavily 或 Brave
+ 官方域名加权
```

#### 代码实现查询

```text
paper title implementation GitHub
```

路由：

```text
通用 Web Provider
+ github.com 域名偏好
```

#### 混合研究查询

```text
最新的 synthetic data for LLM 论文和工业实践
```

路由：

```text
arXiv
+ OpenAlex
+ 一个主 Web Provider
```

结果按以下类型分组：

```text
Papers
Official Blogs
Technical Articles
Documentation / Repositories
```

### 7.2 查询改写限制

* 默认使用用户原始查询。
* 只做大小写、空格、标识符和日期规范化。
* 只有用户启用智能搜索或 Skill 调用时才进行改写。
* 每个搜索会话最多允许一次改写。
* 改写不得删除 Must Concept。
* 改写不得自动扩大日期范围。
* 改写不得增加用户未指定的排除条件。
* 原始查询和改写查询必须同时保留。
* 改写失败时回退到原始查询。

---

## 8. WebSearchProvider 接口

```ts
interface WebSearchProvider {
  id: string;
  displayName: string;

  kind:
    | "academic"
    | "web"
    | "mcp";

  capabilities: {
    supportsDateRange: boolean;
    supportsLanguage: boolean;
    supportsDomainFilter: boolean;
    supportsExactLookup: boolean;
    supportsSemanticSearch: boolean;
    supportsPagination: boolean;
  };

  isConfigured(): Promise<boolean>;

  healthCheck(): Promise<ProviderHealth>;

  search(
    request: ProviderSearchRequest,
    context: ProviderSearchContext,
  ): Promise<ProviderSearchResponse>;
}
```

### 8.1 ProviderSearchRequest

```ts
interface ProviderSearchRequest {
  query: string;

  intent: WebSearchPlan["intent"];

  dateRange?: {
    start?: string;
    end?: string;
  };

  language?: string;

  includeDomains?: string[];
  excludeDomains?: string[];

  limit: number;
  cursor?: string;
}
```

### 8.2 ProviderSearchResponse

```ts
interface ProviderSearchResponse {
  providerId: string;

  items: ProviderSearchItem[];

  nextCursor?: string;

  status:
    | "success"
    | "partial"
    | "not_configured"
    | "rate_limited"
    | "timeout"
    | "failed";

  latencyMs: number;

  requestId?: string;

  estimatedCredits?: number;

  warning?: string;
}
```

---

## 9. Provider 选择

| Provider        | 定位                | 优先级 | 主要用途              |
| --------------- | ----------------- | --: | ----------------- |
| arXiv Query API | 基础学术搜索            |  P0 | AI/ML 论文、arXiv ID |
| OpenAlex        | 学术元数据与广覆盖检索       |  P0 | DOI、论文、作者、引用、出版版本 |
| Tavily          | 面向 Agent 的 Web 搜索 |  P1 | 官方博客、技术文章、网页片段    |
| Brave Search    | 通用 Web 搜索         |  P1 | Tavily 备用或广泛搜索    |
| Search MCP      | 用户扩展 Provider     |  P2 | 接入用户已有搜索服务        |
| Crossref        | 元数据增强             |  P2 | DOI、期刊和出版信息       |
| GitHub Search   | 代码仓库关联            |  P2 | 论文实现和项目仓库         |

### 9.1 arXiv Provider

职责：

* 论文主题检索；
* arXiv ID 查询；
* 作者、分类和日期过滤；
* 返回标题、作者、摘要、发布时间、Landing Page 和 PDF URL。

要求：

* 设置 Provider 级请求间隔；
* 支持超时和重试；
* 不将 arXiv 结果描述为完整学术覆盖；
* 保留原始 arXiv URL；
* 记录 arXiv ID；
* 无商业 Web Search Key 时仍应保持可用。

### 9.2 OpenAlex Provider

职责：

* 扩大学术检索覆盖；
* 解析 DOI 和出版版本；
* 获取作者、期刊、会议、机构和主题信息；
* 获取引用数和开放获取状态；
* 进行论文和作者搜索。

要求：

* 用户配置 OpenAlex API Key 后启用；
* 未配置时不影响 arXiv 搜索；
* 普通搜索默认使用文本查询；
* 语义搜索作为可选增强；
* 记录 API 使用量和估算成本；
* 复杂查询过长时拆分后聚合。

### 9.3 Tavily Provider

职责：

* 技术网页检索；
* 官方博客检索；
* 官方文档检索；
* 返回可用于摘要的网页片段；
* 支持日期和域名过滤。

默认策略：

```text
search_depth = basic 或 fast
max_results = 10
include_raw_content = false
```

以下场景才使用更高成本模式：

* 用户明确选择深度搜索；
* 综合总结证据不足；
* 用户请求单条深度总结；
* 需要抽取完整网页正文。

### 9.4 Brave Provider

职责：

* Tavily 备用；
* 提供独立 Web 索引；
* 补充技术文章、新闻、博客和文档；
* 支持语言、国家和域名过滤。

默认策略：

* Tavily 和 Brave 采用主备关系。
* 默认不同时调用二者。
* 用户选择 Broad Search 时才并行调用。
* Brave 原始分数只在 Provider 内使用。
* Provider Raw Score 不进入跨源直接计算。

### 9.5 Search MCP Provider

Search MCP 仅作为扩展 Provider。

要求：

1. 配置保存时执行 Tool Discovery。
2. 只允许调用白名单中的搜索 Tool。
3. 不允许 Agent 自动选择任意 MCP Tool。
4. 每个 MCP 连接必须配置 Tool 名和输入输出 Adapter。
5. MCP 输出必须转换为统一 Provider Schema。
6. 非法 Schema 直接拒绝。
7. 设置连接超时、调用超时和总搜索超时。
8. MCP 失败时继续使用其他 Provider。
9. MCP 不得直接写 PaperHub 数据库。
10. MCP 不得要求自动读取任意本地文件。
11. 第一阶段优先支持本地 `stdio`。
12. HTTP MCP 仅允许 localhost 或明确可信地址。

---

## 10. Provider 路由策略

### 10.1 Academic

```text
arXiv
+ OpenAlex（已配置时）
```

### 10.2 Technical

```text
主 Web Provider
→ 失败时调用备用 Provider
```

### 10.3 Mixed

```text
arXiv
+ OpenAlex
+ 一个主 Web Provider
```

### 10.4 Broad Search

用户显式启用后：

```text
arXiv
+ OpenAlex
+ Tavily
+ Brave
+ 已配置 Search MCP
```

### 10.5 默认搜索预算

```ts
const DEFAULT_WEB_SEARCH_BUDGET = {
  maxProviderCalls: 3,
  maxResultsPerProvider: 10,
  maxTotalResults: 30,
  maxTotalLatencyMs: 12_000,
};
```

预设：

#### Low Cost

```text
最多 2 个 Provider
每个 Provider 5～10 条
不自动抓取正文
```

#### Balanced

```text
最多 3 个 Provider
每个 Provider 10 条
自动生成前 5～10 条综合总结
```

#### Broad

```text
调用全部已启用 Provider
增加结果数量
允许备用 Provider 并行
需要显示预计成本
```

---

## 11. Web 搜索会话

```ts
type WebSearchSessionStatus =
  | "created"
  | "planning"
  | "searching"
  | "aggregating"
  | "summarizing"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "expired";
```

状态流：

```text
created
→ planning
→ searching
→ aggregating
→ summarizing
→ completed
```

部分 Provider 失败：

```text
searching
→ aggregating
→ partial
```

全部 Provider 失败：

```text
searching
→ failed
```

用户取消：

```text
任意运行状态
→ cancelled
```

会话过期：

```text
completed / partial / failed
→ expired
```

### 11.1 Provider Run 状态

```ts
type ProviderRunStatus =
  | "queued"
  | "running"
  | "success"
  | "partial"
  | "not_configured"
  | "rate_limited"
  | "timeout"
  | "failed"
  | "cancelled";
```

每个 Provider 独立记录状态，不允许只返回一个全局错误。

---

## 12. WebSearchResult 模型

```ts
interface WebSearchResult {
  id: string;
  sessionId: string;

  title: string;
  url: string;
  canonicalUrl?: string;

  authors: string[];
  publishedAt?: string;
  language?: string;

  contentType:
    | "paper"
    | "official_blog"
    | "technical_article"
    | "documentation"
    | "repository"
    | "other";

  abstract?: string;
  snippet?: string;

  identifiers: {
    doi?: string;
    arxivId?: string;
    openAlexId?: string;
    pmid?: string;
  };

  origin: {
    domain: string;
    publisher?: string;
    venue?: string;
    sourceName?: string;
  };

  providerEvidence: ProviderEvidence[];

  ranking: {
    aggregateScore: number;
    providerRrfScore: number;
    conceptCoverageScore: number;
    freshnessScore: number;
    sourceQualityScore: number;
    metadataQualityScore: number;
  };

  match: {
    matchedConcepts: string[];
    matchedFields: string[];
    missingMustConcepts: string[];
  };

  localState: {
    status:
      | "not_saved"
      | "saving"
      | "saved"
      | "save_failed";

    documentId?: string;
    isFavorite?: boolean;
    hasDownloadedFile?: boolean;
  };

  createdAt: string;
  expiresAt: string;
}
```

### 12.1 ProviderEvidence

```ts
interface ProviderEvidence {
  providerId: string;
  providerResultId?: string;
  originalUrl: string;
  rank: number;
  rawScore?: number;
  snippet?: string;
  fetchedAt: string;
}
```

同一个结果被多个 Provider 命中时：

* 合并为一个 `WebSearchResult`；
* 保留所有 Provider Evidence；
* 增加多 Provider 支持信号；
* 不丢弃任何原始 URL。

---

## 13. 本地 Document 模型扩展

当前 `Document.source` 主要表示采集来源。Web 搜索接入后，需要区分：

```text
内容原始来源
发现内容的 Provider
```

建议新增：

```ts
interface DocumentOrigin {
  sourceType:
    | "arxiv"
    | "journal"
    | "conference"
    | "official_blog"
    | "technical_article"
    | "documentation"
    | "repository"
    | "other";

  sourceName?: string;
  publisher?: string;
  venue?: string;
  domain?: string;
}
```

```ts
interface DocumentDiscovery {
  discoveredVia:
    | "collector"
    | "web_search"
    | "manual_import"
    | "mcp";

  providerId?: string;
  searchSessionId?: string;
}
```

为持久化 `Document` 增加：

```ts
externalIds?: {
  doi?: string;
  arxivId?: string;
  openAlexId?: string;
  pmid?: string;
};

canonicalUrl?: string;

origin?: DocumentOrigin;

discovery?: DocumentDiscovery;
```

迁移期间保留旧 `source` 字段，避免破坏现有本地搜索和推荐逻辑。

---

## 14. 结果规范化

每个 Provider Adapter 必须输出：

* 标题；
* 作者；
* 摘要或片段；
* 发布时间；
* 原始 URL；
* Canonical URL；
* DOI；
* arXiv ID；
* OpenAlex ID；
* 内容类型；
* Provider Rank；
* Provider Raw Score；
* 来源域名；
* Provider 请求信息。

Provider Adapter 不负责：

* 跨 Provider 去重；
* 全局排序；
* 本地保存；
* LLM 总结；
* 收藏；
* PDF 下载。

---

## 15. 实体解析与去重

### 15.1 强标识符

按以下优先级判断：

```text
DOI 相同
→ 同一论文

arXiv ID 相同
→ 同一论文

OpenAlex Work ID 相同
→ 同一学术记录

Canonical URL 相同
→ 同一网页
```

### 15.2 弱标识符

没有强标识符时使用：

```text
规范化标题
+ 第一作者
+ 出版年份
```

进一步结合：

```text
标题相似度
+ 作者重叠
+ 发布时间差异
```

### 15.3 URL 规范化

* 移除 `utm_*` 参数；
* 移除常见追踪参数；
* 域名转小写；
* 删除默认端口；
* 标准化尾部 `/`；
* 记录受控重定向后的 Canonical URL；
* PDF URL 与 Landing Page URL 保留关联；
* 不合并路径明显不同的页面。

### 15.4 合并优先级

论文结构化元数据：

```text
arXiv / OpenAlex
> Tavily / Brave 网页片段
```

技术网页：

```text
原始页面结构化元数据
> Provider 标题和片段
```

合并结果必须保留来源追踪信息。

---

## 16. 排序设计

### 16.1 禁止直接叠加原始分数

错误做法：

```text
arXiv score
+ OpenAlex relevance_score
+ Tavily score
+ Brave score
```

不同 Provider 的分数定义和范围不同，不能直接比较。

### 16.2 统一评分

```text
aggregateScore =
  providerRrfScore
  + conceptCoverageScore
  + contentTypePrior
  + freshnessScore
  + sourceQualityScore
  + metadataQualityScore
```

硬过滤条件不满足时直接过滤，不通过扣分处理。

### 16.3 Weighted RRF

```text
providerRrfScore =
Σ providerWeight / (k + providerRank)
```

要求：

* `k` 可配置；
* Provider Weight 可配置；
* 多 Provider 同时命中的结果获得额外支持；
* Provider 是否收费不作为质量权重。

### 16.4 Concept Coverage

排序时区分：

```text
全部 Must Concept 命中
> 部分 Must Concept 命中
> 仅语义相关但无明确证据
```

多概念查询必须防止只命中一个概念的结果进入顶部。

### 16.5 内容类型分组

Mixed 模式下先分组，再组内排序：

```text
Papers
Official Blogs
Technical Articles
Documentation / Repositories
```

避免普通 SEO 页面压过论文原始记录或官方内容。

### 16.6 来源质量先验

#### Tier A

* 论文原始页面；
* 期刊或会议页面；
* 作者主页；
* 官方产品博客；
* 官方文档；
* 官方代码仓库。

#### Tier B

* 高质量技术媒体；
* 研究机构博客；
* 学术聚合页。

#### Tier C

* 未知聚合页；
* 内容农场；
* 无作者、无日期、无原始来源页面。

来源质量只作为弱先验，不能覆盖查询相关性。

---

## 17. 搜索会话与缓存

Web 结果不进入本地知识库，但搜索会话建议使用 SQLite 瞬时表，而不是只存内存。

建议表：

```text
web_search_sessions
web_search_provider_runs
web_search_results
web_search_result_evidence
web_search_summaries
web_content_cache
web_search_connections
```

所有瞬时表必须包含：

```text
created_at
updated_at
expires_at
```

### 17.1 TTL

默认：

```text
搜索会话：24 小时
Provider 原始响应：24 小时
抓取正文：24 小时
综合总结：24 小时
```

允许配置：

```text
1～168 小时
```

### 17.2 Cache Key

```text
provider_id
+ normalized_query
+ normalized_filters
+ provider_options_version
```

不得只使用原始查询字符串。

### 17.3 清理策略

* 应用启动时执行一次清理；
* 后台任务每小时清理；
* 正在保存的结果不能被清理；
* 已保存结果只删除瞬时副本；
* 不删除本地 Document；
* 清理过程需要记录删除数量和错误。

---

# 第二部分：API 与数据流

## 18. 创建 Web 搜索会话

```http
POST /api/web-search
```

请求示例：

```json
{
  "query": "synthetic data for large language models",
  "scope": "mixed",
  "contentTypes": [
    "paper",
    "official_blog",
    "technical_article"
  ],
  "dateRange": {
    "start": "2025-01-01"
  },
  "sort": "relevance",
  "maxResults": 30,
  "searchBudget": "balanced",
  "autoSummarize": true
}
```

响应：

```json
{
  "success": true,
  "data": {
    "sessionId": "ws_xxx",
    "status": "created",
    "eventsUrl": "/api/web-search/ws_xxx/events",
    "expiresAt": "2026-06-21T12:00:00Z"
  }
}
```

建议使用：

```text
202 Accepted
```

---

## 19. 获取搜索会话

```http
GET /api/web-search/:sessionId
```

返回：

* 原始查询；
* Query Plan；
* Session Status；
* Provider Run Status；
* 聚合结果；
* 内容分组；
* Summary Status；
* 综合总结；
* 是否 Partial；
* 是否可重试；
* Expires At。

---

## 20. SSE 事件

```http
GET /api/web-search/:sessionId/events
```

事件类型：

```text
session.created
plan.completed
provider.started
provider.results
provider.completed
provider.partial
provider.failed
provider.rate_limited
aggregation.started
aggregation.completed
summary.started
summary.progress
summary.completed
summary.failed
session.completed
session.partial
session.failed
session.cancelled
heartbeat
```

要求：

* 每个事件带递增 `eventId`；
* 支持 `Last-Event-ID`；
* 每 15～30 秒发送 Heartbeat；
* 断开后可以重新连接；
* SSE 中不得返回 API Key；
* SSE 中不得返回认证 Header；
* Provider 原始错误需要脱敏。

---

## 21. 取消和重试

取消搜索：

```http
POST /api/web-search/:sessionId/cancel
```

重试失败 Provider：

```http
POST /api/web-search/:sessionId/retry
```

请求：

```json
{
  "providers": [
    "openalex",
    "tavily"
  ]
}
```

重试不得重新调用已经成功且缓存仍有效的 Provider。

---

## 22. 单条深度总结

```http
POST /api/web-search/:sessionId/results/:resultId/summarize
```

处理流程：

```text
加载 Web Result
→ 检查已有缓存
→ 获取摘要或 Provider Snippet
→ 必要时安全抓取正文
→ 构建 EvidenceChunk
→ 调用 LLM
→ 校验引用
→ 保存到 Session Summary Cache
```

---

## 23. 保存 Web 结果

```http
POST /api/web-search/:sessionId/results/:resultId/save
```

请求：

```json
{
  "mode": "metadata_only",
  "favorite": true,
  "generateSummary": true
}
```

保存模式：

```ts
type WebSaveMode =
  | "metadata_only"
  | "save_content"
  | "download_pdf";
```

语义：

### metadata_only

* 保存标题、作者、摘要、标识符和来源；
* 不抓取全文；
* 进入本地搜索；
* 后续可单独下载正文或 PDF。

### save_content

* 安全抓取网页正文；
* 保存正文；
* 进入标签、总结和向量索引。

### download_pdf

* 下载 PDF；
* 保存本地路径；
* 提取文本；
* 创建或更新 Document；
* 进入标签、总结和向量索引。

---

## 24. Provider 配置接口

```text
GET    /api/web-search/providers/catalog
GET    /api/web-search/connections
POST   /api/web-search/connections
PUT    /api/web-search/connections/:id
DELETE /api/web-search/connections/:id
POST   /api/web-search/connections/:id/test
POST   /api/web-search/connections/:id/activate
```

配置模式应复用现有 LLM Connection 的：

* Preset；
* Connection；
* Test；
* Activate；
* Secret Redaction；
* Runtime Resolution。

---

# 第三部分：正文、总结与引用

## 25. Web 内容抓取

搜索阶段优先使用 Provider 返回的：

* 标题；
* 作者；
* 发布时间；
* 摘要；
* Snippet；
* DOI；
* arXiv ID；
* 原始 URL。

只在以下情况抓取正文：

* 用户打开结果；
* 用户请求深度总结；
* 综合总结证据不足；
* 用户选择保存正文；
* 用户下载 PDF；
* 需要补全作者、时间或标识符。

### 25.1 HTML 抓取要求

* 只允许 HTTP 和 HTTPS；
* 设置连接超时；
* 设置首字节超时；
* 设置总响应超时；
* 限制响应大小；
* 限制重定向次数；
* 限制 Content-Type；
* 不携带用户浏览器 Cookie；
* 不携带浏览器 Authorization；
* 不执行页面 JavaScript；
* 不自动提交表单；
* 移除 script、style、iframe；
* 提取正文、标题、作者、时间和 Canonical URL；
* 记录抓取时间和内容哈希。

### 25.2 PDF 处理

```text
确认 PDF URL
→ 执行受控 HEAD 或 GET
→ 校验 Content-Type
→ 校验文件大小
→ 下载临时文件
→ 提取文本
→ 用户选择下载后移动到本地知识库
```

要求：

* 不自动下载所有搜索结果；
* PDF 下载必须由用户动作触发；
* 设置最大文件大小；
* 不执行 PDF 内嵌脚本；
* 文本提取失败时仍可保存元数据；
* 记录 PDF 来源 URL。

---

## 26. EvidenceChunk

```ts
interface EvidenceChunk {
  id: string;
  resultId: string;

  title: string;
  url: string;

  text: string;

  providerId: string;

  evidenceType:
    | "abstract"
    | "provider_snippet"
    | "page_excerpt"
    | "metadata";

  fetchedAt: string;
  contentHash: string;
}
```

总结不应直接接收所有完整网页或 PDF，而应使用经过筛选的 EvidenceChunk。

---

## 27. 综合总结

默认基于：

```text
Top 5～10 条结果
+ 每条若干高相关证据片段
+ 结构化元数据
```

建议 LLM 输出：

```ts
interface WebSearchSynthesis {
  overview: string;

  keyFindings: Array<{
    claim: string;
    citations: string[];
  }>;

  resultGroups: Array<{
    title: string;
    resultIds: string[];
    summary: string;
  }>;

  limitations: string[];
}
```

引用使用 `resultId`，前端渲染为：

```text
[1] [2] [3]
```

### 27.1 引用校验

生成后必须检查：

* Citation ID 是否对应当前 Session Result；
* 不允许引用不存在的 ID；
* 每个关键结论至少有一个引用；
* 引用 URL 必须可点击；
* 同一 Result 编号保持稳定；
* 没有充分证据时标记“证据不足”；
* Summary 失败不影响搜索结果列表。

### 27.2 Provider Answer 的使用限制

如果 Provider 返回自动生成的 Answer：

* 不直接作为 PaperHub 最终总结；
* 只可作为低权重辅助信息；
* 最终总结必须基于规范化结果；
* 无法映射来源时不得用于关键结论；
* 不允许 Provider Answer 覆盖原始来源内容。

---

# 第四部分：Web 结果本地化

## 28. 保存流程

```text
用户点击保存、收藏或下载
→ 加载 WebSearchResult
→ 检查是否已关联 Document
→ 执行强标识符去重
→ 必要时抓取正文或 PDF
→ 转换为 RawDocument
→ 调用统一 Ingestion Service
→ 返回 inserted 或 duplicate
→ 建立 Result 与 Document 的关联
→ 用户要求收藏时添加 Favorite
→ 摘要与向量索引异步执行
```

### 28.1 幂等要求

重复保存不得产生重复 Document。

去重顺序：

```text
DOI
→ arXiv ID
→ Canonical URL
→ OpenAlex ID
→ 标题 + 作者 + 年份
```

重复保存时返回已有：

```text
documentId
```

### 28.2 收藏语义

错误流程：

```text
Web Result
→ Favorite
```

正确流程：

```text
Web Result
→ Document
→ Favorite(Document)
```

收藏 Web Result 时应自动触发最小化保存。

### 28.3 事务边界

网络抓取、PDF 下载和 LLM 总结不能放在长时间 SQLite 事务中。

建议：

```text
阶段 1：网络读取和数据准备
阶段 2：短数据库事务写入 Document、关联和 Favorite
阶段 3：异步 Summary 和 Vector Index
```

### 28.4 保存失败

保存失败时：

* Web Result 继续保留；
* 标记 `save_failed`；
* 返回失败阶段；
* 支持重试；
* Summary 失败不撤销已经成功写入的 Document；
* Index 失败不撤销 Document；
* Favorite 失败可以单独重试。

---

# 第五部分：界面设计

## 29. 搜索页顶部

使用：

```text
Web 搜索 | 本地知识库
```

URL 参数：

```text
/search?scope=web&q=...
/search?scope=local&q=...
```

默认：

```text
scope=web
```

---

## 30. Web 搜索表单

基础字段：

* Query；
* 搜索范围；
* 内容类型；
* 日期范围；
* 语言；
* 排序。

高级字段：

* Provider；
* Include Domains；
* Exclude Domains；
* 搜索预算；
* 是否自动总结；
* 是否允许一次 Query Rewrite。

高级设置默认折叠。

---

## 31. Provider 状态展示

示例：

```text
arXiv：完成，10 条
OpenAlex：完成，8 条
Tavily：限流
Brave：未配置
Search MCP：连接失败
```

只要至少一个 Provider 成功：

```text
返回部分结果
```

不能因为单个 Provider 失败而显示整个搜索失败。

---

## 32. WebResultCard

不能直接复用只接受持久化 `Document` 的本地结果卡片。

新增：

```text
WebResultCard
```

展示：

* 内容类型；
* 标题；
* 作者；
* 发布时间；
* 来源域名；
* DOI；
* arXiv ID；
* 摘要或 Snippet；
* Provider 命中；
* 匹配概念；
* 原始来源链接；
* 深度总结；
* 保存；
* 收藏；
* 下载；
* 已在本地知识库中。

---

## 33. 综合总结区域

搜索结果顶部展示：

* 综合概览；
* 关键发现；
* 编号引用；
* Provider 覆盖情况；
* 数据和证据限制；
* “基于前 N 条结果生成”；
* Summary 生成状态；
* Summary 失败后的重试按钮。

---

## 34. 会话恢复

页面刷新后：

* 根据 `sessionId` 重新加载 Session；
* 运行中的 Session 重新连接 SSE；
* 已完成 Session 直接展示缓存结果；
* 已过期 Session 提示重新搜索；
* 不自动重新消耗 Provider 配额；
* 允许用户复制或分享本地 Session URL。

---

# 第六部分：密钥和连接管理

## 35. WebSearchConnection

```ts
interface WebSearchConnection {
  id: string;

  provider:
    | "openalex"
    | "tavily"
    | "brave"
    | "mcp";

  name: string;

  enabled: boolean;
  isPrimary?: boolean;

  settings: {
    baseUrl?: string;

    mcpTransport?:
      | "stdio"
      | "streamable_http";

    mcpToolName?: string;
  };

  lastTestStatus?:
    | "success"
    | "failed";

  lastTestMessage?: string;
  lastTestedAt?: string;
}
```

读取 Connection 时不得返回 API Key。

### 35.1 密钥要求

* 不写入日志；
* 不返回前端明文；
* 不进入 Session；
* 不进入错误响应；
* 不进入 Provider Cache；
* 测试失败信息必须脱敏；
* 配置导出不包含密钥；
* 优先使用操作系统凭据存储；
* 数据库存储时必须通过 SecretStore 抽象；
* 后续可以无缝迁移到 Electron Safe Storage。

---

# 第七部分：MCP 与 Skills

## 36. PaperHub MCP 扩展

新增 Tools：

```text
search_web
get_web_search_session
get_web_result
summarize_web_results
summarize_web_result
save_web_result
search_local_library
get_local_document
```

### 36.1 search_web

输入与 `WebSearchRequest` 对齐。

额外限制：

* `maxResults` 有上限；
* Provider 必须在白名单中；
* Search Budget 不能被 Tool 参数绕过；
* 默认不允许 Broad Search；
* 自动总结可关闭。

### 36.2 save_web_result

属于写操作，要求：

* Tool 名明确表达写入；
* 上层必须确认用户意图；
* 必须指定 Save Mode；
* 不允许传入任意 URL 直接保存；
* 只能保存有效 Session 中的 Result；
* 必须复用 Web Save Service；
* 返回本地 `documentId`。

### 36.3 MCP Transport

* 默认使用 `stdio`；
* HTTP 模式只绑定 `127.0.0.1`；
* 验证 Origin；
* 增加认证；
* 不监听 `0.0.0.0`；
* 不允许普通网页直接访问本地 MCP。

---

## 37. Skills

核心 Web 搜索不依赖 Skills。

Skills 只用于高级研究流程。

### 37.1 web-literature-search

流程：

```text
拆解研究问题
→ 提取 Must / Should / Exclude Concepts
→ 选择 Academic 或 Mixed
→ 执行 Web 搜索
→ 检查 Provider 覆盖
→ 检查 Must Concept
→ 最多进行一次受控改写
→ 输出检索式、分组和纳入理由
```

限制：

* 最多一次改写；
* 不无限搜索；
* 不绕过 Search Budget；
* 不自动保存全部结果；
* 不将本地无结果表述为领域无研究。

### 37.2 web-research-synthesis

流程：

```text
读取一个或多个 Session
→ 跨 Session 去重
→ 按方法、任务、数据集和结论分组
→ 提取证据
→ 标记一致或冲突结论
→ 生成带引用综述
```

要求：

* 每个关键结论有引用；
* 明确 Provider 覆盖限制；
* 标记证据不足；
* 不将 Provider Answer 直接当作事实。

### 37.3 save-to-library

流程：

```text
展示待保存结果
→ 检查重复
→ 请求用户确认
→ 选择保存模式
→ 保存到本地
→ 可选收藏
→ 返回 documentId
```

限制：

* 不允许无确认批量保存；
* 不绕过 Ingestion Service；
* 不直接写数据库；
* 不绕过 LLM 并发限制；
* 不自动批量下载 PDF。

### 37.4 后续 Skills

* `paper-to-code`
* `citation-verification`
* `systematic-review-lite`
* `research-gap-analysis`
* `daily-web-research-digest`
* `zotero-sync`

---

# 第八部分：安全设计

## 38. SSRF 防护

Web 抓取必须使用专用 Safe Fetcher。

### 38.1 允许协议

```text
http
https
```

### 38.2 禁止协议

```text
file
ftp
data
javascript
chrome
about
```

### 38.3 禁止访问

* localhost；
* 127.0.0.0/8；
* 10.0.0.0/8；
* 172.16.0.0/12；
* 192.168.0.0/16；
* IPv6 loopback；
* IPv6 link-local；
* 云元数据地址；
* 保留地址；
* 本地数据库地址；
* Electron 内部资源地址。

每次重定向后必须重新解析并校验目标 IP。

### 38.4 响应限制

* 最大重定向次数；
* 最大响应体；
* 最大 Header；
* 连接超时；
* 首字节超时；
* 总下载超时；
* Content-Type 白名单；
* HTML 大小上限；
* PDF 大小上限；
* 解压后大小上限。

### 38.5 网络边界

* 不发送本地 Cookie；
* 不发送用户浏览器 Authorization；
* 不复用浏览器 Session；
* 不执行 JavaScript；
* 不自动点击页面链接；
* 不允许页面修改 Provider 配置。

---

## 39. Prompt Injection 防护

以下内容统一视为：

```text
UNTRUSTED_EXTERNAL_CONTENT
```

包括：

* 网页正文；
* PDF 文本；
* Provider Snippet；
* Provider Answer；
* Search MCP 返回内容；
* 论文摘要中的指令性文本。

要求：

1. 外部内容放入明确数据边界。
2. Summary Prompt 明确忽略文本中的命令。
3. 外部内容不能改变 Tool 权限。
4. 外部内容不能要求读取 API Key。
5. 外部内容不能触发保存、下载、邮件或 GitHub 写操作。
6. Summary 只处理 EvidenceChunk。
7. 输出必须符合 JSON Schema。
8. 写操作必须来自可信用户动作。
9. “忽略前文”等文本按普通内容处理。
10. MCP 返回结果执行同样防护。

---

## 40. 版权与数据保留

* 未保存结果只缓存元数据和必要 Snippet。
* 抓取正文默认保留 24 小时。
* 未经用户保存，不长期存储完整网页。
* PDF 只有用户下载或保存后长期保留。
* 总结必须保留原始 URL。
* 保存时记录作者、来源和抓取时间。
* 不缓存付费墙完整正文。
* 不提供批量版权内容导出。
* 遵守 robots.txt 和 Provider 条款。
* 页面无法确认原始来源时降低来源质量权重。

---

# 第九部分：可观测性与成本

## 41. Provider 指标

* 调用次数；
* 成功率；
* Timeout Rate；
* Rate Limit Rate；
* P50 Latency；
* P95 Latency；
* 返回结果数；
* Provider 配置状态；
* Cache Hit Rate；
* Estimated Credits；
* Error Type。

## 42. 聚合指标

* 聚合前结果数；
* 去重后结果数；
* Dedup Ratio；
* DOI 合并数；
* arXiv ID 合并数；
* URL 合并数；
* 标题相似度合并数；
* 各内容类型数量；
* 多 Provider 命中比例。

## 43. Summary 指标

* Summary 成功率；
* Summary P95 Latency；
* Citation Mapping Accuracy；
* 无引用 Claim 数；
* Evidence 不足次数；
* Token 使用估算。

## 44. 用户行为指标

* Web 搜索次数；
* 结果点击率；
* 深度总结使用率；
* 保存转化率；
* 收藏转化率；
* PDF 下载率；
* 查询改写率；
* 无结果率；
* Partial Session 比例。

所有指标默认只保存在本地。

---

# 第十部分：代码结构

## 45. 建议目录

```text
src/
├── api/
│   ├── server.ts
│   └── routes/
│       ├── local-search.ts
│       ├── web-search.ts
│       └── web-search-settings.ts
├── services/
│   ├── web-search-service.ts
│   ├── web-save-service.ts
│   ├── web-content-service.ts
│   └── search-summary-service.ts
├── web-search/
│   ├── types.ts
│   ├── query-planner.ts
│   ├── orchestrator.ts
│   ├── normalizer.ts
│   ├── entity-resolver.ts
│   ├── dedup.ts
│   ├── ranker.ts
│   ├── provenance.ts
│   ├── citation-validator.ts
│   ├── security/
│   │   ├── safe-fetch.ts
│   │   ├── url-policy.ts
│   │   └── content-sanitizer.ts
│   ├── providers/
│   │   ├── types.ts
│   │   ├── arxiv.ts
│   │   ├── openalex.ts
│   │   ├── tavily.ts
│   │   ├── brave.ts
│   │   └── mcp.ts
│   └── content/
│       ├── html-extractor.ts
│       ├── pdf-downloader.ts
│       └── evidence-builder.ts
├── db/
│   ├── web-search.ts
│   ├── web-search-connections.ts
│   └── web-content-cache.ts
├── ui/
│   ├── pages/
│   │   └── SearchPage.tsx
│   ├── search/
│   │   ├── WebSearchPanel.tsx
│   │   ├── LocalSearchPanel.tsx
│   │   ├── WebSearchStatus.tsx
│   │   ├── WebResultCard.tsx
│   │   └── WebSearchSynthesis.tsx
│   └── lib/
│       └── api.ts
└── mcp/
    └── tools/
        ├── search-web.ts
        ├── get-web-result.ts
        ├── save-web-result.ts
        └── search-local-library.ts

skills/
├── web-literature-search/
├── web-research-synthesis/
└── save-to-library/
```

新增 Web Route 应从现有 `server.ts` 中拆分，避免单个 API 文件持续膨胀。

---

# 第十一部分：测试方案

## 46. Provider 测试

覆盖：

* 参数映射；
* 认证 Header；
* 日期过滤；
* 语言过滤；
* 域名过滤；
* Pagination；
* 正常返回；
* 空结果；
* 400；
* 401；
* 429；
* 500；
* Timeout；
* 非法 JSON；
* Provider Schema 变化。

CI 中必须使用 Fixture 或 Mock Server，不调用真实商业 API。

---

## 47. Query Planner 测试

覆盖：

* DOI；
* arXiv ID；
* 论文标题；
* 作者查询；
* 官方博客查询；
* Code Lookup；
* Mixed Query；
* 日期查询；
* Provider 白名单；
* Search Budget；
* 最多一次 Query Rewrite。

---

## 48. 去重测试

覆盖：

* DOI 相同；
* arXiv ID 相同；
* OpenAlex ID 相同；
* Canonical URL 相同；
* PDF 与 Landing Page；
* 标题轻微差异；
* 作者顺序变化；
* arXiv 与正式出版版本；
* 博客转载；
* 相似但不同论文。

---

## 49. 排序测试

覆盖：

* 多 Provider 同时命中；
* 单 Provider 高分；
* Must Concept 全覆盖；
* Must Concept 部分覆盖；
* 最新结果；
* 官方来源；
* Mixed 分组；
* Provider Raw Score 不直接混合；
* Provider Weight 调整。

---

## 50. SSE 测试

覆盖：

* 事件顺序；
* Provider 并发；
* Partial；
* Heartbeat；
* 断线重连；
* Last-Event-ID；
* Cancel；
* Retry；
* Session 完成；
* Session 过期。

---

## 51. Summary 与引用测试

覆盖：

* Citation ID 映射；
* 不存在的 Citation；
* 无引用 Claim；
* 重复 Citation；
* Abstract Evidence；
* Provider Snippet；
* Page Excerpt；
* Evidence 不足；
* Summary 失败；
* Prompt Injection。

---

## 52. 保存测试

覆盖：

* Metadata Only；
* Save Content；
* Download PDF；
* 自动收藏；
* 重复保存；
* DOI 去重；
* arXiv 去重；
* URL 去重；
* 标题去重；
* Summary 失败；
* Index 失败；
* Favorite 幂等；
* Result 与 Document 关联。

---

## 53. 安全测试

覆盖：

* `file://`；
* localhost；
* 私有 IPv4；
* 私有 IPv6；
* 云元数据地址；
* DNS Rebinding；
* 重定向到内网；
* 超大响应；
* 压缩炸弹；
* 非法 Content-Type；
* 页面 Prompt Injection；
* MCP 非法 Tool；
* MCP 非法 Schema；
* API Key 泄漏；
* Error Stack 泄漏。

---

## 54. E2E

完整流程：

```text
Web 搜索
→ Provider 状态
→ 结果展示
→ 综合总结
→ 单条深度总结
→ 保存
→ 收藏
→ 本地知识库中可见
```

同时验证：

* 未保存 Web Result 不出现在本地搜索；
* 过期 Session 正确提示；
* 无商业 Web Key 时 arXiv 仍可使用；
* OpenAlex 未配置时安全降级；
* 主 Web Provider 失败时备用 Provider 可用；
* 全部 Web Provider 失败时不返回本地结果。

---

# 第十二部分：质量目标

## 55. 正确性

```text
Citation Mapping Accuracy = 100%

未保存 Web Result 出现在本地搜索中的数量 = 0

重复保存产生重复 Document 的数量 = 0

Provider Raw Score 跨源直接相加次数 = 0

SSRF 私网请求成功数 = 0

API Key 明文返回数 = 0
```

## 56. 搜索质量

```text
Top 20 强重复率 < 5%

多 Provider 合并准确率 >= 95%

Must Concept Coverage 可解释

原始论文页优先于低质量转载

官方博客优先于第三方转载
```

## 57. 可用性

```text
至少一个 Provider 成功时返回 Partial Result

单 Provider 失败不导致整个 Session 失败

Summary 失败不影响结果列表

保存失败可以重试

Session 刷新后可以恢复
```

## 58. 性能目标

```text
创建 Session 响应 P95 < 500ms

首批 Provider 结果 P95 < 4s

Balanced 模式聚合完成 P95 < 12s

本地知识库搜索性能不因 Web 功能明显退化
```

---

# 第十三部分：实施阶段

## W0：设计冻结与基线

目标：

* 固化 Web 和 Local 边界；
* 固化 API Contract；
* 固化 Session 状态机；
* 固化 Provider Interface；
* 固化 WebSearchResult；
* 建立 Mock Fixtures；
* 建立安全威胁模型。

交付：

```text
Web Search API Schema
Provider Adapter Contract
WebSearchResult Schema
Session State Machine
SSE Event Contract
Security Checklist
```

---

## W1：arXiv 与 Session 基础

目标：

* 无商业 Web Key 时提供 Academic Web Search；
* 建立 Session、SSE、缓存和基础 UI。

任务：

* arXiv Provider；
* Query Planner 基础；
* Web Search Service；
* SQLite 瞬时表；
* SSE；
* Web Search UI；
* Provider 状态；
* TTL 清理。

完成标准：

```text
Web Search 可搜索 arXiv

刷新后 Session 可以恢复

未保存结果不进入本地知识库
```

---

## W2：OpenAlex 与学术实体解析

目标：

* 扩大学术覆盖；
* 提升 DOI、作者和出版版本质量。

任务：

* OpenAlex Connection；
* OpenAlex Provider；
* DOI / arXiv / OpenAlex ID；
* 学术结果合并；
* Weighted RRF；
* 元数据优先级；
* 使用量展示。

完成标准：

```text
arXiv 和 OpenAlex 的同一论文能够合并

保留双方 Provider Evidence

OpenAlex 未配置时安全降级
```

---

## W3：Tavily 与 Brave

目标：

* 支持官方博客、技术文章和文档搜索。

任务：

* Provider Connection UI；
* Tavily Provider；
* Brave Provider；
* 主 Provider / 备用 Provider；
* Domain Filter；
* Technical Scope；
* Mixed Scope；
* Content Type 分类；
* Search Budget。

完成标准：

```text
Technical Search 可用

主 Provider 失败时备用 Provider 可用

Mixed Search 按内容类型分组
```

---

## W4：总结、引用与正文抓取

目标：

* 提供带引用的综合概览和深度总结。

任务：

* Safe Fetch；
* HTML Extraction；
* EvidenceChunk；
* Search Summary Service；
* Citation Validator；
* Prompt Injection 防护；
* Summary Cache。

完成标准：

```text
关键结论引用真实 Result

Summary 失败不影响结果

网页命令不能触发 Tool
```

---

## W5：保存、收藏与下载

目标：

* 完成 Web 到本地知识库闭环。

任务：

* Document Origin 模型迁移；
* Web Save Service；
* RawDocument 转换；
* 强标识符去重；
* 复用 Ingestion Service；
* 收藏；
* PDF 下载；
* 本地记录入口。

完成标准：

```text
保存后可通过本地搜索找到

重复保存不产生重复 Document

收藏 Web Result 会先创建或关联本地 Document
```

---

## W6：Search MCP 与 Skills

目标：

* 支持高级用户扩展搜索服务和研究工作流。

任务：

* MCP Provider Adapter；
* Tool 白名单；
* Schema Adapter；
* PaperHub MCP Web Tools；
* `web-literature-search`；
* `web-research-synthesis`；
* `save-to-library`。

完成标准：

```text
MCP 不可用不影响核心搜索

非法 MCP 输出被拒绝

Skills 不绕过统一服务
```

---

## W7：安全、监控和桌面发布

目标：

* 达到正式发布条件。

任务：

* SSRF 全量测试；
* SecretStore；
* 成本统计；
* Provider 指标；
* Cache 清理；
* Electron CSP；
* EXE 安装包；
* Portable 版本；
* 数据库迁移；
* 失败恢复。

完成标准：

```text
完整 E2E 通过

安全测试通过

安装版和 Portable 均可搜索

密钥不出现在日志和导出配置中
```

---

# 第十四部分：任务拆分

```text
TASK_web_search_contract.md
TASK_web_search_session_schema.md
TASK_web_search_sse.md
TASK_web_search_query_planner.md
TASK_web_search_arxiv_provider.md
TASK_web_search_openalex_connection.md
TASK_web_search_openalex_provider.md
TASK_web_search_result_normalization.md
TASK_web_search_entity_resolution.md
TASK_web_search_dedup.md
TASK_web_search_rank_fusion.md
TASK_web_search_tavily_provider.md
TASK_web_search_brave_provider.md
TASK_web_search_provider_failover.md
TASK_web_search_ui_split.md
TASK_web_search_web_result_card.md
TASK_web_search_summary_evidence.md
TASK_web_search_citation_validator.md
TASK_web_search_safe_fetch.md
TASK_web_search_html_extract.md
TASK_web_search_pdf_download.md
TASK_web_search_document_origin_migration.md
TASK_web_search_save_service.md
TASK_web_search_favorite_flow.md
TASK_web_search_cache_cleanup.md
TASK_web_search_observability.md
TASK_web_search_mcp_provider.md
TASK_mcp_search_web_tools.md
TASK_skill_web_literature_search.md
TASK_skill_web_research_synthesis.md
TASK_skill_save_to_library.md
TASK_web_search_security_hardening.md
TASK_web_search_desktop_release.md
```

每个任务文档至少包括：

* Goal；
* Why Now；
* Non-goals；
* Current Behavior；
* Expected Behavior；
* Files to Read；
* Files to Edit；
* API Changes；
* Schema Changes；
* Migration；
* Security Considerations；
* Allowed Commands；
* Validation Commands；
* Acceptance Criteria；
* Stop Conditions；
* Rollback Plan。

---

# 第十五部分：风险与控制

## 风险 1：Provider 成本失控

控制：

* Search Budget；
* 默认主备策略；
* 默认不全量广播；
* Cache；
* 最大结果数；
* 本地用量统计；
* Summary 按需；
* Broad Search 显式启用。

## 风险 2：多 Provider 结果重复

控制：

* DOI；
* arXiv ID；
* OpenAlex ID；
* Canonical URL；
* 标题、作者和年份；
* Dedup Fixtures；
* 不使用标题相似度单独认定论文相同。

## 风险 3：SEO 页面影响结果质量

控制：

* Academic 与 Technical 分组；
* 官方来源先验；
* Content Type；
* Must Concept Coverage；
* 低质量域名过滤；
* 通用网页不能覆盖论文原始记录。

## 风险 4：网页 Prompt Injection

控制：

* 所有外部内容标记不可信；
* Summary Prompt 与 Tool Prompt 分离；
* JSON Schema；
* 网页内容不能触发写操作；
* Summary 只处理 EvidenceChunk。

## 风险 5：SSRF

控制：

* 专用 Safe Fetch；
* DNS 校验；
* 重定向逐跳校验；
* 私网和保留地址阻断；
* 无 Cookie；
* 响应大小和超时限制。

## 风险 6：Document 来源语义混乱

控制：

* 分离 Origin 和 Discovery；
* Provider 不等于内容来源；
* 保留旧 `source` 兼容；
* 分阶段迁移。

## 风险 7：API Server 继续膨胀

控制：

* Web Routes 拆分；
* Domain Service；
* Provider Adapter；
* API、MCP 和 UI 共用同一服务。

## 风险 8：MCP 破坏权限边界

控制：

* MCP 后置实施；
* Tool 白名单；
* Schema Adapter；
* 默认 stdio；
* 不直接写数据库；
* MCP 返回内容视为不可信。

---

# 第十六部分：最终推荐

推荐实施顺序：

```text
先完成 arXiv Web Search 基础链路
→ 再完成 OpenAlex 学术聚合
→ 再接入一个通用 Web Provider
→ 再建设引用式总结
→ 再实现保存和本地化
→ 最后接入 Search MCP 与 Skills
```

第一版不建议：

* 同时上线所有 Provider；
* 默认同时调用 Tavily 和 Brave；
* 将 Web 和 Local 无提示混排；
* 搜索阶段抓取全部网页正文；
* 搜索阶段下载全部 PDF；
* 使用 Provider Raw Score 直接排序；
* 让 MCP 直接写数据库；
* 让网页内容参与 Tool 权限决策；
* 将 Web Result 直接作为 Favorite；
* 将未保存 Web Result 加入 FTS5 或 sqlite-vec。

V3 第一可用版本应聚焦：

```text
Web / Local 双入口
+ arXiv
+ OpenAlex
+ 一个通用 Web Provider
+ Provider 状态
+ 聚合去重
+ 引用式总结
+ 保存到本地知识库
```

当上述链路稳定后，再逐步扩展：

```text
Brave
Search MCP
Agent Skills
GitHub 代码关联
Zotero 同步
轻量系统综述
研究空白分析
```

---

# 附录 A：第一阶段实施记录

> 实施日期：2026-06-20  
> 实施范围：W0「设计冻结与基线」与 W1「arXiv 与 Session 基础」  
> 当前状态：已完成并通过全量测试

## A.1 本阶段交付结果

本阶段已经建立独立于本地知识库搜索的 Web Search 基础链路：

```text
Web / Local 双入口
→ Web Search Request 校验
→ Query Planner
→ arXiv Provider
→ Provider 独立状态
→ 结果规范化与基础聚合排序
→ SQLite 临时 Session
→ SSE 事件流
→ Web Result 展示
```

实现后满足以下边界：

* 搜索页默认入口为 Web Search，并提供 Local Library 独立入口；
* 原有 `GET /api/search` 保持兼容；
* 新增 `GET /api/local-search`，与原接口调用同一本地搜索服务；
* Web Search 失败时不会隐式执行本地搜索；
* 本地搜索无结果时不会自动发起 Web Search；
* 未保存的 Web Result 只存在于临时会话表，不写入 `documents`、FTS5 或 sqlite-vec；
* 当前无需商业 Web Search Key 即可搜索 arXiv；
* Technical Scope 当前会明确返回无可用 Provider，而不是伪装成学术搜索或本地结果。

## A.2 Web Search Contract

新增并固化以下核心类型：

* `WebSearchRequest`
* `WebSearchPlan`
* `WebSearchProvider`
* `ProviderSearchRequest`
* `ProviderSearchResponse`
* `ProviderSearchItem`
* `WebSearchResult`
* `WebSearchSession`
* `WebSearchEvent`
* `ProviderRunStatus`
* `WebSearchSessionStatus`

类型定义位于：

```text
src/web-search/types.ts
```

当前请求支持：

* `query`
* `scope`
* `contentTypes`
* `dateRange`
* `languages`
* `providers`
* `includeDomains`
* `excludeDomains`
* `sort`
* `maxResults`
* `searchBudget`
* `autoSummarize`
* `allowQueryRewrite`

API 边界会校验查询长度、Scope、内容类型、日期范围、数组规模和最大结果数。

## A.3 Query Planner

基础 Query Planner 已实现：

```text
src/web-search/query-planner.ts
```

当前能力：

* 规范化 Unicode、首尾空格和连续空格；
* 识别 DOI；
* 识别 arXiv ID；
* 识别论文、作者、近期更新和代码查找意图；
* 提取 Must Concepts；
* 根据 `low_cost`、`balanced`、`broad` 生成搜索预算；
* 根据 Scope 和 Provider 白名单生成 Provider Calls；
* 默认保留用户原始查询，不执行 LLM Query Rewrite；
* Technical Scope 在尚未接入通用 Web Provider 时返回明确失败。

当前 W1 路由：

```text
Academic
→ arXiv

Mixed
→ arXiv

Technical
→ 暂无 Provider，明确失败
```

## A.4 arXiv Provider

arXiv Web Search Provider 位于：

```text
src/web-search/providers/arxiv.ts
```

已实现：

* 普通主题查询；
* arXiv ID 精确查询；
* 起止日期过滤；
* 分页 Cursor 参数映射；
* 请求数量限制；
* Provider 超时；
* AbortSignal 取消；
* HTTP 429 状态映射；
* 非成功响应脱敏；
* Atom Feed 解析；
* 标题、作者、摘要、发布日期、分类、Landing URL 和 PDF URL 规范化；
* arXiv ID 提取；
* HTTP URL 规范化为 HTTPS Canonical URL；
* 无 API Key 可用。

Provider 不执行数据库写入、本地收藏、LLM 总结或跨 Provider 排序。

## A.5 Session 与数据库迁移

数据库 Schema 已升级到 v20。

新增表：

```text
web_search_sessions
web_search_provider_runs
web_search_results
web_search_events
```

所有 Web Result 均以独立 JSON 模型存储，不复用本地 `Document`。

会话特性：

* 默认 TTL 为 24 小时；
* Session、Provider Run 和 Result 包含过期时间；
* Session URL 保留后，页面刷新可以重新加载结果；
* 每个 Provider 独立记录状态、结果数量、耗时和警告；
* 应用启动时执行过期数据清理；
* 后台每小时执行一次清理；
* 到期 Session 先进入 `expired` 状态，再删除临时副本；
* 清理不会删除任何本地 Document。

数据库访问实现位于：

```text
src/db/web-search.ts
```

## A.6 Web Search Service

搜索编排服务位于：

```text
src/services/web-search-service.ts
```

已实现状态流：

```text
created
→ planning
→ searching
→ aggregating
→ completed
```

同时支持：

```text
部分 Provider 失败 → partial
全部 Provider 失败 → failed
用户取消 → cancelled
会话到期 → expired
```

基础聚合规则：

* 使用 DOI、arXiv ID、Canonical URL 或原始 URL 构造合并键；
* Provider 原始分数不进行跨 Provider 直接相加；
* 使用 Provider Rank 计算 RRF 分数；
* 计算 Must Concept Coverage；
* 计算 Freshness、Source Quality 和 Metadata Quality；
* 生成统一 `aggregateScore`；
* 保留每个 Provider 的 Evidence；
* Result 初始 `localState.status` 固定为 `not_saved`。

当前只有一个 arXiv Provider，聚合接口已经为后续 OpenAlex 和通用 Web Provider 预留。

## A.7 API 与 SSE

新增路由模块：

```text
src/api/routes/web-search.ts
```

已提供接口：

```http
POST /api/web-search
GET  /api/web-search/:sessionId
GET  /api/web-search/:sessionId/events
POST /api/web-search/:sessionId/cancel
POST /api/web-search/:sessionId/retry
GET  /api/local-search
```

`POST /api/web-search` 使用 `202 Accepted` 返回：

* `sessionId`
* 初始状态
* `eventsUrl`
* `expiresAt`

SSE 已实现：

* 递增 Event ID；
* `Last-Event-ID`；
* `after` 查询参数；
* 已持久化事件重放；
* Provider 事件；
* Aggregation 事件；
* Session 终态事件；
* 20 秒 Heartbeat；
* 终态后自动关闭连接；
* Provider 错误脱敏。

当前 UI 使用 Session 轮询恢复状态；SSE API 已可供后续 UI 流式消费。

Retry 当前提供会话级基础重试。仅重试指定失败 Provider、复用成功 Provider Cache 的精细化策略留在多 Provider 阶段完善。

## A.8 搜索界面

搜索页已经拆分为：

```text
Web Search | Local Library
```

Web Search 面板支持：

* 查询输入；
* Academic、Technical、Mixed Scope；
* 起止日期；
* 创建 Web Search Session；
* 根据 URL 中的 Session ID 恢复；
* Provider 状态展示；
* 临时结果列表；
* arXiv ID 展示；
* 原始来源链接；
* 明确的 Temporary 状态提示；
* 明确提示结果尚未保存到本地知识库。

主要文件：

```text
src/ui/pages/SearchPage.tsx
src/ui/lib/api.ts
src/ui/styles.css
```

旧的本地搜索 URL 参数和交互继续兼容。

## A.9 测试覆盖

新增 Web Search 测试：

```text
src/__tests__/web-search.test.ts
```

覆盖：

* arXiv ID 路由；
* Search Budget；
* Technical Scope 隔离；
* arXiv 查询参数映射；
* 日期过滤映射；
* Atom Feed 规范化；
* 429 状态映射与错误脱敏；
* Session 持久化；
* 刷新后恢复；
* Web Result 不进入本地 Documents；
* SSE Event ID 与断点重放；
* Web Search 失败不回退本地结果。

UI 测试增加：

* Web Search 默认入口；
* Web / Local 切换；
* Session 创建与恢复；
* Provider 状态展示；
* 临时结果展示；
* 原有本地搜索和 Phase 6 发布流程兼容。

## A.10 验证结果

执行结果：

```text
TypeScript typecheck：通过
ESLint：通过
Vitest：46 个测试文件、411 项测试全部通过
Vite UI production build：通过
```

验证命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm ui:build
```

## A.11 本阶段未包含

以下内容属于后续 W2～W7，不计入本次完成范围：

* OpenAlex Connection 与 Provider；
* DOI、arXiv、OpenAlex 跨 Provider 实体合并；
* Tavily 与 Brave；
* Technical Scope 的正式 Provider；
* Mixed Scope 内容类型分组；
* 网页正文 Safe Fetch；
* HTML/PDF 内容提取；
* EvidenceChunk；
* 引用式综合总结；
* 单条深度总结；
* Web Result 保存到本地知识库；
* 收藏与 PDF 下载闭环；
* Search MCP；
* Agent Skills；
* 完整 Provider 成本与可观测性；
* 桌面发布安全加固。

> 上述内容为第一阶段结束时的历史记录；W2 已于 2026-06-21 完成，详见附录 B。

---

# 附录 B：第二阶段实施记录

> 实施日期：2026-06-21  
> 实施范围：W2「OpenAlex 与学术实体解析」  
> 当前状态：已完成并通过全量测试

## B.1 OpenAlex Connection

新增 Web Search Connection 存储、API 与用户中心配置面板，支持：

* 保存、更新、删除和启用 OpenAlex Connection；
* 配置 HTTPS Base URL 和 API Key；
* Connection Test 与脱敏错误信息；
* API Key 只写入本地存储，读取接口仅返回 `hasApiKey`；
* 支持 `OPENALEX_API_KEY` 与 `OPENALEX_BASE_URL` 环境变量覆盖；
* OpenAlex 未配置时记录 `not_configured`，arXiv 搜索继续完成。

数据库 Schema 升级到 v21，新增：

```text
web_search_connections
web_search_provider_runs.estimated_credits
web_search_provider_runs.request_id
```

## B.2 OpenAlex Provider

新增：

```text
src/web-search/providers/openalex.ts
```

支持：

* 普通 Works 文本检索；
* DOI 精确检索；
* OpenAlex Work ID 精确检索；
* arXiv ID 查询补充；
* 作者查询：先检索 Author，再按 `author.id` 检索 Works；
* 起止出版日期过滤；
* Cursor 与最大结果数；
* 超时、取消、429 和失败状态映射；
* 标题、作者、DOI、arXiv ID、OpenAlex ID、期刊/会议、出版机构、引用数、开放获取状态、主题和机构信息规范化；
* Abstract Inverted Index 还原；
* Provider 请求次数作为 estimated credits 记录并展示。

## B.3 学术实体合并与排序

聚合层现在按以下强标识符建立实体别名：

```text
DOI
arXiv ID
OpenAlex Work ID
Canonical URL
```

没有强标识符时使用：

```text
规范化标题 + 第一作者 + 出版年份
```

合并后的结果：

* 保留所有 Provider Evidence；
* DOI、OpenAlex ID、出版信息优先采用 OpenAlex 结构化元数据；
* arXiv Landing Page 与 PDF 等元数据继续保留；
* URL 会移除常见追踪参数后参与实体解析；
* Weighted RRF 使用 Provider 权重和多 Provider 支持增益；
* 不直接叠加 Provider Raw Score。

## B.4 API 与 UI

新增接口：

```http
GET    /api/web-search/providers/catalog
GET    /api/web-search/connections
POST   /api/web-search/connections
PUT    /api/web-search/connections/:id
DELETE /api/web-search/connections/:id
POST   /api/web-search/connections/:id/test
POST   /api/web-search/connections/:id/activate
```

用户中心新增 OpenAlex 学术搜索连接面板。Web Search Provider 状态区域新增 estimated credits 展示。

## B.5 验证结果

```text
TypeScript typecheck：通过
ESLint：通过
Vitest：46 个测试文件、418 项测试全部通过
Vite UI production build：通过
Web Search W2 专项测试：15 项全部通过
```

验证命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm ui:build
```

## B.6 主要变更文件

```text
src/web-search/providers/openalex.ts
src/web-search/query-planner.ts
src/web-search/types.ts
src/services/web-search-service.ts
src/db/web-search-connections.ts
src/db/web-search.ts
src/db/index.ts
src/api/routes/web-search.ts
src/ui/web-search-connections.tsx
src/ui/pages/UserCenterPage.tsx
src/ui/pages/SearchPage.tsx
src/ui/lib/api.ts
src/i18n.ts
src/__tests__/web-search.test.ts
```

## B.7 W2 完成标准核对

```text
arXiv 和 OpenAlex 的同一论文能够合并
→ 已通过 DOI、arXiv ID、OpenAlex Work ID 和 Canonical URL 实体解析实现。

保留双方 Provider Evidence
→ 合并结果的 providerEvidence 同时保留 arXiv 与 OpenAlex 记录。

OpenAlex 未配置时安全降级
→ OpenAlex Provider Run 标记为 not_configured，arXiv 结果仍正常完成。
```

下一阶段建议进入 W3，接入 Tavily 与 Brave，完成 Technical Scope、Mixed Scope、Domain Filter、主备 Provider 和 Search Budget。

---

# 附录 C：第三阶段实施记录

> 实施日期：2026-06-21  
> 实施范围：W3「Tavily 与 Brave」  
> 当前状态：已完成并通过全量测试

## C.1 Provider 与连接配置

新增 Tavily、Brave Search Provider，并复用现有 Web Search Connection 存储与密钥脱敏机制。用户中心现在可分别配置、测试和启用 OpenAlex、Tavily、Brave Search 连接，也支持以下环境变量：

```text
TAVILY_API_KEY
TAVILY_BASE_URL
BRAVE_SEARCH_API_KEY
BRAVE_API_KEY
BRAVE_SEARCH_BASE_URL
```

Provider 错误只记录 HTTP 状态和脱敏警告，不记录响应正文或 API Key。

## C.2 Technical 与 Mixed Search

Query Planner 已支持：

```text
Technical
→ Tavily 主 Provider
→ Brave 备用 Provider

Mixed
→ arXiv
→ OpenAlex
→ Tavily
→ Brave 备用或 Broad 并行 Provider
```

普通预算下 Tavily 成功后不会调用 Brave；Tavily 未配置、限流、超时或失败时自动切换到 Brave。Broad Search 才并行调用 Tavily 与 Brave。

Low Cost Mixed Search 会保留一个学术 Provider 和 Tavily / Brave 主备链，避免预算截断后退化为纯学术搜索。

## C.3 Domain Filter 与结果分类

Tavily 使用原生 `include_domains`、`exclude_domains`、`start_date` 和 `end_date` 参数。

Brave 使用 `site:` / `-site:` 查询操作符实现域名过滤，并使用 `freshness` 自定义日期范围。

通用 Web 结果统一分类为：

```text
paper
official_blog
technical_article
documentation
repository
```

Mixed Search UI 按以下分组展示：

```text
Papers
Official blogs
Technical articles
Documentation & repositories
```

## C.4 Search Budget

搜索界面新增：

```text
Low cost
Balanced
Broad
```

同时支持 Include Domains、Exclude Domains 和 Academic / Technical / Mixed Scope。

## C.5 验证结果

```text
TypeScript typecheck：通过
ESLint：通过
Vitest：46 个测试文件、424 项测试全部通过
Vite UI production build：通过
Web Search W3 专项测试：21 项全部通过
```

验证命令：

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build --config vite.ui.config.ts
```

下一阶段建议进入 W4，实现 Safe Fetch、HTML / PDF 正文提取、EvidenceChunk、引用校验和带引用综合总结。

---

# 附录 D：第四阶段实施记录

> 实施日期：2026-06-21  
> 实施范围：W4「总结、引用与正文抓取」  
> 当前状态：已完成并通过全量测试

## D.1 Safe Fetch 与正文提取

新增专用 Safe Fetcher 与 HTML 正文提取器：

```text
src/web-search/safe-fetch.ts
src/web-search/content-extractor.ts
```

当前安全边界包括：

* 只允许 HTTP / HTTPS；
* 拒绝 URL 用户名和密码；
* 阻断 localhost、私有 IPv4、私有 IPv6、链路本地、保留地址和云元数据主机；
* DNS 返回任一私网或保留地址时拒绝请求；
* 每次重定向重新执行 URL、DNS 和 IP 校验；
* 限制重定向次数、响应 Header、响应体大小和总下载时间；
* 只接受 HTML、XHTML、纯文本和 PDF Content-Type；
* 不携带 Cookie、Authorization 或浏览器 Session；
* 不执行 JavaScript、不提交表单；
* HTML 提取时移除 script、style、iframe、form、nav、footer 等非正文内容；
* 提取标题、作者、发布时间、Canonical URL、正文、抓取时间和内容哈希。

PDF 已纳入 Safe Fetch 的协议、地址、类型、大小和超时边界；PDF 文本提取及用户触发的长期下载仍由 W5 保存闭环实现。

## D.2 EvidenceChunk

新增：

```text
src/web-search/evidence.ts
```

支持从以下来源构建有界证据：

```text
abstract
provider_snippet
metadata
page_excerpt
```

每个 EvidenceChunk 均包含稳定 ID、Result ID、原始 URL、Provider、证据类型、抓取时间和 SHA-256 内容哈希。单个证据片段限制长度，正文只选择少量片段进入总结，不会把完整网页直接传给 LLM。

## D.3 总结、引用与 Prompt Injection 防护

新增：

```text
src/services/web-search-summary.ts
```

已实现：

* 基于 Top 5～10 条结果的综合概览；
* 单条结果深度总结；
* 自动总结与手动总结；
* 复用现有 `callLlm` 并发限制和 429 重试；
* LLM JSON 输出结构校验；
* Citation Result ID 白名单校验；
* 非当前 Session Result 的引用自动剔除；
* 无有效引用的关键结论不进入最终 Key Findings，并记录“证据不足”；
* 引用编号按结果顺序稳定生成，前端渲染为可点击 `[1] [2]`；
* 外部内容统一放入 `UNTRUSTED_EXTERNAL_CONTENT` 数据边界；
* Prompt 明确禁止外部内容触发 Tool、密钥读取、保存或下载等写操作；
* Summary 失败只写入失败状态，不改变搜索结果和 Session 的完成状态。

## D.4 缓存、API 与 UI

数据库 Schema 升级到 v22，新增：

```text
web_search_result_evidence
web_search_summaries
web_content_cache
```

三类临时数据均带过期时间，并接入现有每小时清理任务。

新增 API：

```http
POST /api/web-search/:sessionId/summarize
POST /api/web-search/:sessionId/results/:resultId/summarize
```

搜索页新增：

* “自动生成带引用概览”选项；
* 综合概览、关键发现、证据数量和限制展示；
* 可点击编号引用；
* 单条 Deep Summary；
* Summary 失败提示与手动重试入口。

## D.5 验证结果

```text
TypeScript typecheck：通过
ESLint：通过
Vitest：46 个测试文件、429 项测试全部通过
Vite UI production build：通过
Web Search W4 专项测试：26 项全部通过
```

专项覆盖：

```text
非法协议
私网与回环地址
重定向到内网
HTML 可执行元素清理
EvidenceChunk 类型与长度
不存在的 Citation
重复 Citation
无引用 Claim
证据不足
Prompt Injection 数据边界
Summary Cache
Summary 失败不影响搜索结果
```

下一阶段建议进入 W5，完成 Web Result 保存、收藏、PDF 下载、本地 Document Origin 和统一 Ingestion 闭环。

---

# 附录 E：第五阶段实施记录

> 实施日期：2026-06-21  
> 实施范围：W5，保存、收藏与下载  
> 当前状态：已完成并通过全量测试

## E.1 Document Origin 与持久化关联

数据库 Schema 升级到 v23。`documents` 新增：

```text
external_ids
canonical_url
origin_json
discovery_json
```

新增持久化关联表：

```text
web_search_saved_results
```

本地 Document 现在能够记录 DOI、arXiv ID、OpenAlex ID、PMID、Canonical URL、内容原始来源、发现 Provider、Web Search Session 和 Web Result ID。旧 `source` 字段继续保留，现有搜索、推荐和收藏逻辑保持兼容。

## E.2 Web Save Service

新增：

```text
src/services/web-save-service.ts
src/web-search/pdf-text.ts
```

已实现三种保存模式：

```text
metadata_only
save_content
download_pdf
```

保存服务只接受有效 Session 中的 Result，不接受任意 URL。网络读取发生在数据库写入之前，Document、Result 关联和 Favorite 使用短数据库操作，Summary 与向量索引保持异步。

## E.3 去重、入库与收藏

保存前按以下顺序查找已有 Document：

```text
DOI
→ arXiv ID
→ OpenAlex ID
→ PMID
→ Canonical URL / 原始 URL
→ 标题 + 第一作者 + 年份
→ 统一 Ingestion Service 的标题相似度去重
```

新内容统一转换为 `RawDocument` 并调用现有 Ingestion Service，继续复用 Tagger、FTS5 同步和向量索引队列。重复保存返回已有 `documentId`，不会创建重复 Document。

收藏 Web Result 时执行：

```text
Web Result
→ 创建或关联 Document
→ Favorite(Document)
```

Favorite 失败不会撤销已经成功保存的 Document，可单独重试。

## E.4 正文与 PDF

`save_content` 复用 Safe Fetch 和 HTML 正文提取器，继续执行协议、私网、重定向、Content-Type、响应大小和超时限制。

`download_pdf` 仅由用户操作触发：

```text
解析 Result 中的 PDF URL
→ Safe Fetch 校验
→ 限制为 application/pdf
→ 限制最大 30 MB
→ 尝试提取数字 PDF 文本
→ 保存到 ~/PaperHub/pdfs/<documentId>.pdf
→ 更新 Document.fullTextPath
```

扫描件或无法提取文本的 PDF 仍会保存原文件与元数据。

## E.5 API 与界面

新增接口：

```http
POST /api/web-search/:sessionId/results/:resultId/save
```

搜索结果卡片新增：

* Save metadata；
* Save content；
* Save & favorite；
* Download PDF；
* Open local record。

保存完成后 UI 显示 Local 状态，并可直接打开本地 Document。

## E.6 验证结果

```text
TypeScript typecheck：通过
ESLint：通过
Vitest：46 个测试文件、434 项测试全部通过
Vite UI production build：通过
Web Search 专项测试：31 项全部通过
```

W5 专项覆盖：

```text
Metadata Only
Save Content
Download PDF
本地 FTS 可检索
自动收藏
重复保存
DOI 去重
arXiv ID / URL 去重链路
Result 与 Document 关联
Document Origin / Discovery
旧数据库迁移兼容
```

下一阶段可进入 W6：Search MCP 与 Skills。

---

# 附录 F：第六阶段实施记录

> 实施日期：2026-06-21  
> 实施范围：W6，Search MCP 与 Skills  
> 当前状态：已完成并通过专项测试

## F.1 Search MCP Provider

新增：

```text
src/web-search/mcp-client.ts
src/web-search/providers/mcp.ts
```

已实现：

* 本地 `stdio` MCP Transport；
* 配置保存前执行 `initialize` 与 `tools/list`；
* 只调用连接中固定配置的搜索 Tool；
* Tool 名不允许由搜索请求动态指定；
* 输入字段通过显式 Input Adapter 映射；
* 输出字段通过显式 Output Adapter 转换为统一 `ProviderSearchItem`；
* 非 JSON、非数组、缺少标题、缺少 HTTP(S) URL、非法日期等输出直接拒绝；
* MCP 响应大小、连接时间和调用时间受限；
* 子进程使用参数数组启动，不经过 Shell；
* MCP 失败记录为独立 Provider 状态，不影响其他 Provider 返回 Partial Result；
* Search MCP 仅在用户显式勾选或请求 `providers` 包含 `mcp` 时进入查询计划。

用户中心新增 Search MCP 配置面板，支持命令、参数和 Tool 名配置、保存、激活与连接测试。搜索页新增显式启用 Search MCP 的选项。

## F.2 PaperHub 本地 MCP Server

新增：

```text
src/mcp/index.ts
src/mcp/server.ts
src/mcp/tool-service.ts
```

启动命令：

```bash
pnpm mcp:stdio
```

提供 Tools：

```text
search_web
get_web_search_session
get_web_result
summarize_web_results
summarize_web_result
save_web_result
search_local_library
get_local_document
```

所有 Tool 均复用现有领域服务：

```text
Web Search Service
Web Search Summary Service
Web Save Service
hybridSearch
Document Service
```

MCP 不直接执行 SQL，不复制搜索、排序、保存、标签、总结或索引规则。

`search_web` 额外限制：

* Provider 白名单；
* `maxResults <= 50`；
* 默认禁止 Broad Search；
* 只有设置 `PAPERHUB_MCP_ALLOW_BROAD_SEARCH=1` 后才允许 Broad Search；
* 继续使用 PaperHub Query Planner 和 Search Budget。

`save_web_result` 明确标记为写操作，只接受有效 Session、Result 和 Save Mode，不接受任意 URL。

## F.3 Skills

新增：

```text
skills/web-literature-search/
skills/web-research-synthesis/
skills/save-to-library/
```

三个 Skill 的 `agents/openai.yaml` 均声明依赖 `paperhub-local` MCP。

安全边界：

* Skills 只调用注册的 PaperHub MCP Tools；
* 最多一次受控查询改写；
* 不绕过 Search Budget；
* 综合结论必须保留引用和证据不足标记；
* 保存前必须展示结果并获得用户明确确认；
* 不自动批量下载 PDF；
* 不直接访问 SQLite、REST Route 或 Provider SDK。

## F.4 验证结果

W6 专项测试覆盖：

```text
Search MCP 显式路由
Input Adapter
Output Adapter
非法 MCP Schema 拒绝
MCP 失败时核心 Provider 继续返回
8 个 PaperHub MCP Tools
写 Tool 标注
Provider 白名单
Broad Search 默认关闭
JSON-RPC 错误脱敏
```

已完成本地 stdio MCP `initialize` 与 `tools/list` 真实握手测试。

Skill Creator 官方校验脚本因当前 Python 环境缺少 PyYAML 无法启动；已使用项目现有 `js-yaml` 完成等价校验，确认三个 Skill 的 Frontmatter、MCP 依赖和 TODO 清理均有效。

验证命令：

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src
node node_modules/vitest/vitest.mjs run src/__tests__/web-search.test.ts
node node_modules/vitest/vitest.mjs run
node node_modules/vite/bin/vite.js build --config vite.ui.config.ts
```

下一阶段可进入 W7：安全、监控和桌面发布。

---

# 附录 G：第七阶段实施记录

> 实施日期：2026-06-21  
> 实施范围：W7，安全、监控和桌面发布  
> 当前状态：代码实施完成，等待 Windows 安装版与 Portable 实机签收

## G.1 SecretStore 与数据库 v24

新增统一 SecretStore。Windows 桌面主进程使用 Electron `safeStorage` / DPAPI 保护本机主密钥，
后端使用 AES-256-GCM 保存 LLM、Embedding 和 Web Search 密钥。SQLite 仅保留 `secret_ref`
与 `hasApiKey` 语义，不再写入明文密钥。

数据库迁移升级至 v24。迁移前创建备份，迁移后执行 `PRAGMA quick_check`；迁移失败时保留
备份并停止启动。v24 同时迁移已有明文密钥并清空旧 `api_key` 字段。

## G.2 安全加固

* 全局日志对 API Key、Authorization、Token、Password 和 Secret 字段脱敏；
* API 增加 CSP、nosniff、Referrer Policy、Permissions Policy 和 COOP；
* Electron 禁用 Node Integration，保持 Sandbox 与 Context Isolation；
* 禁止任意新窗口和非应用内导航，仅允许系统浏览器打开 HTTP / HTTPS 外链；
* 默认拒绝摄像头、麦克风、定位和通知权限；
* Safe Fetch 专项覆盖映射 IPv6、超大 Header、超大解压响应和私网重定向。

## G.3 指标与恢复

新增：

```http
GET /api/web-search/metrics
GET /api/web-search/health
```

指标只保存在本地并默认保留 30 天，包含 Provider 成功率、P50 / P95、限流、成本、聚合去重、
Summary 引用与 Token 估算，以及搜索、打开、保存、收藏和 PDF 下载事件。指标不记录查询正文、
网页正文、密钥或本地路径。

启动时会恢复异常中断的搜索与保存状态；已有结果的搜索标记为 Partial，无结果的搜索标记为
Failed，悬挂的 Saving 状态改为可重试失败。缓存清理状态和恢复状态会展示在用户中心。

## G.4 桌面发布

新增独立构建命令：

```bash
pnpm desktop:build:nsis
pnpm desktop:build:portable
```

打包阶段会校验 Web Search 监控界面、SecretStore、MCP Server 和三个 Skills 是否进入产物。
发布与人工验收流程见：

```text
docs/w7-release-runbook.md
docs/w7-manual-checklist.md
```

Windows 正式签收仍需在 x64 实机分别执行 NSIS 与 Portable 搜索、总结、保存、重启恢复测试。

---

# 附录 H：未完成功能清单

> 更新日期：2026-06-22  
> 范围：基于当前代码实现对照 V3 方案的剩余工作  
> 状态说明：以下条目不否定已完成的 Web Search、MCP、Skills、安全和监控主链路；仅记录尚未完全覆盖方案要求的功能点。

## H.2 行为细节待加强

### H.2.1 内容类型分组与排序

当前结果支持按内容类型分组展示，并实现组内排序。

待加强：

* Mixed 模式下显式固定分组顺序；
* 官方博客、文档、Repository 的来源质量 Tier；
* 防止低质量 SEO 页面压过官方来源；
* UI 展示排序解释。

### H.2.2 Concept Coverage

当前排序计算 Must Concept 命中比例。

待加强：

* 区分 Must / Should / Exclude 的完整 UI 与 API 输入；
* 对缺失 Must Concept 的结果执行硬过滤或显式降级；
* 多概念查询避免只命中一个概念的结果进入顶部；
* 在 Web Result 中展示 missing concepts。

### H.2.3 单条深度总结体验

后端已有：

```http
POST /api/web-search/:sessionId/results/:resultId/summarize
```

待补齐：

* WebResultCard 中提供单条深度总结按钮；
* 展示单条总结缓存状态；
* 展示引用、证据片段和抓取失败原因；
* Summary 失败后允许重试，不影响结果列表。

### H.2.4 版权与 robots 策略

当前 Safe Fetch 已限制抓取协议、目标地址、大小和内容类型。

待补齐：

* robots.txt / Provider 条款策略；
* 付费墙正文识别与降级；
* 未保存完整正文的严格保留策略审计；
* 批量导出版权内容限制。

## H.3 发布与验收待办

### H.3.1 Windows 实机签收

仍需在 Windows x64 实机完成：

* NSIS 安装版搜索、总结、保存、收藏、PDF 下载；
* Portable 版本同样流程；
* 重启后 SecretStore、Session 恢复和已保存 Document 验证；
* MCP stdio Server 在桌面包内可启动；
* 三个 Skills 随包可用。

### H.3.2 全链路真实 Provider 验证

当前测试以单元和 Mock Provider 为主。

待补齐：

* arXiv 真实网络检索；
* OpenAlex 真实 API Key 连接测试；
* Crossref 真实网络检索；
* Tavily / Brave 真实 Key 连接测试；
* GitHub 真实 API 检索和可选 Token 限流验证；
* stdio Search MCP 真实工具发现和搜索；
* HTTP Search MCP 真实工具发现和搜索；
* Provider 限流、超时和失败回退手工验收。

## H.4 当前验证基线

已通过的 V3 / W7 相关本地验证：

```bash
pnpm typecheck
pnpm lint
pnpm test src/__tests__/web-search.test.ts src/__tests__/ui-search.test.tsx
pnpm test src/__tests__/web-search.test.ts src/__tests__/w7-security-release.test.ts
```

验证结果：

```text
typecheck   passed
lint        passed
Web/UI      Test Files 2 passed, Tests 56 passed
W7 baseline Test Files 2 passed, Tests 53 passed
```

说明：普通沙箱下监听 `127.0.0.1` 的测试会因权限限制失败；提升权限后同一组测试全部通过。

## H.5 2026-06-23 完善记录

本轮已完成 H.2 中可由代码和自动化测试闭环的功能：

* Mixed 模式固定分组顺序、来源质量 Tier 和排序解释；
* Must / Should / Exclude 完整 API 与 UI、Must 硬过滤及缺失概念展示；
* 单条深度总结按钮、缓存状态、引用、受限长度 Evidence Excerpt 和抓取诊断；
* robots.txt 执行、付费墙识别与元数据降级；
* Web 正文 24 小时瞬时缓存、PDF 必须由用户动作触发；
* 批量导出限制为元数据和来源链接，禁止批量导出抓取正文；
* schema v26 持久化 Summary Evidence Diagnostics；
* v23 至当前 schema 的 SecretStore 迁移、失败回滚和备份测试；
* 全部 9 个 Skills 的桌面打包资源校验；
* 真实 Provider 可重复验收命令 `pnpm verify:web-providers`。

自动验证结果：

```text
typecheck     passed
lint          passed
unit/integration tests: 47 files passed, 477 tests passed
UI production build passed
Windows NSIS and Portable build passed
release privacy scan: 4903 packaged files passed
real Provider health: arXiv / Crossref / GitHub passed
```

最新 Windows 产物：

```text
dist-desktop/PaperHub-0.1.2-setup-x64.exe
dist-desktop/PaperHub-0.1.2-portable-x64.exe
```

仍需外部环境或人工完成的发布签收：

* 使用真实 OpenAlex、Tavily、Brave 和带 Token 的 GitHub 限流场景执行全链路验证；
* 使用真实 stdio / HTTP Search MCP Server 验证 Tool 发现和搜索；
* 在干净 Windows x64 环境人工执行安装、Portable、重启和卸载测试；
* 人工确认安装/卸载不会删除用户数据目录；
* 采集真实网络延迟样本，签收 Web Search P95 性能目标。
