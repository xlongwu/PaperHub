# PaperHub 搜索引擎优化与 MCP / Skills 接入计划方案

## 1. 文档目的

本文档用于规划 PaperHub 后续两条建设路线：

1. **搜索引擎优化方案**：解决多标签语义不一致、多概念联合检索能力不足、向量召回绕过约束、标签规范化不统一和评测体系不完整等问题。
2. **MCP 与 Skills 接入方案**：将 PaperHub 的搜索、文献读取、标签、推荐和研究工作流能力，以标准化工具与可复用 Skills 的形式提供给外部 Agent。

两条路线不是互斥方案。搜索引擎是底层能力，MCP 是能力暴露层，Skills 是研究流程编排层。推荐实施顺序为：

```text
搜索评测基线
→ 查询与过滤语义修复
→ Canonical Tag 统一
→ 多概念联合相关性优化
→ 稳定领域服务契约
→ MCP Server
→ Agent Skills
```

---

## 2. 项目现状

PaperHub 当前已经具备以下搜索基础能力：

- SQLite FTS5 全文检索；
- sqlite-vec 向量检索；
- Exact、Strict、Broad、CJK、Vector 多路召回；
- Reciprocal Rank Fusion（RRF）融合；
- 基于标题、摘要、标签和向量相似度的特征排序；
- 搜索点击、查询改写和延迟统计；
- 本地文档、标签、摘要和用户偏好管理。

当前主要问题不是“没有语义搜索”，而是查询约束、标签语义、候选召回和最终排序没有形成一致的端到端契约。

典型问题如下：

```text
Tags: LLM, synthetic data
```

用户通常期望得到：

```text
同时与 LLM 和 synthetic data 相关的论文
```

但当前系统可能返回：

```text
一部分只与 LLM 相关
+
一部分只与 synthetic data 相关
```

主要原因包括：

1. 多标签默认采用 `any`，即 OR 语义；
2. 未被识别为已有标签的输入可能被转换为普通主题词，硬过滤退化为软相关性；
3. Broad 与 Vector 召回允许只覆盖部分概念的候选进入结果集；
4. Vector 候选可能绕过多概念覆盖门槛；
5. 标签别名、SQL 过滤、内存过滤和标签统计未完全复用同一套规范化逻辑；
6. 评测集偏重单主题检索，没有系统覆盖标签交集、多概念联合相关性和约束违规。

因此，后续不应只调整 BM25 权重、向量阈值或 RRF 参数，而应从查询模型、过滤契约、标签体系、召回约束、重排和评测体系整体优化。

---

# 第一部分：搜索引擎优化方案

## 3. 建设目标

将当前搜索系统升级为以下结构：

```text
结构化查询解析
→ 硬约束过滤计划
→ 多路候选召回
→ 多概念覆盖检查
→ 融合与特征重排
→ 可选 Reranker
→ 最终硬约束复核
→ 结果解释与质量记录
```

核心原则：

- Filter 决定文档是否允许进入结果；
- Retrieval 决定哪些文档可能相关；
- Ranking 决定候选之间的排序；
- Reranker 不得覆盖硬过滤；
- Fallback 结果必须单独标记；
- 多概念查询必须检查联合覆盖，而不是只检查任意概念命中。

---

## 4. 查询契约优化

### 4.1 当前问题

当前查询接口主要使用：

```ts
tags: string[];
tagMatchMode: "any" | "all";
```

该结构不能清晰区分：

- 必须同时满足的标签；
- 任意满足的标签；
- 需要排除的标签；
- 必须覆盖的语义概念；
- 仅用于排序加分的主题。

### 4.2 建议查询模型

新增统一的内部查询对象：

```ts
interface SearchQueryPlan {
  rawQuery: string;
  normalizedQuery: string;

  filters: {
    allTags: string[];
    anyTags: string[];
    excludeTags: string[];
    sources: string[];
    dateRange?: {
      start: string;
      end: string;
    };
  };

  concepts: {
    must: SearchConcept[];
    should: SearchConcept[];
    exclude: SearchConcept[];
  };

  intent:
    | "exact_lookup"
    | "topic_search"
    | "concept_intersection"
    | "natural_language"
    | "author_search";

  fallbackPolicy: "strict" | "allow_relaxed";
}
```

### 4.3 语义示例

输入：

```text
Query: instruction tuning
All tags: LLM, synthetic data
```

解析为：

```json
{
  "filters": {
    "allTags": ["llm", "synthetic-data"]
  },
  "concepts": {
    "must": ["instruction-tuning"],
    "should": []
  },
  "intent": "concept_intersection"
}
```

输入：

```text
LLM methods, preferably using synthetic data
```

解析为：

```json
{
  "concepts": {
    "must": ["llm"],
    "should": ["synthetic-data"]
  }
}
```

第一阶段优先使用确定性规则，不在每次查询中强制调用 LLM。后续可将“智能查询解析”作为显式可选项。

---

## 5. 标签过滤语义修复

### 5.1 前端输入拆分

当前标签和主题词混合在同一个输入区域，建议拆分为：

#### 标签过滤

- 只能从已有标签或 Canonical Tag 自动补全中选择；
- 多标签默认采用 `Match all`；
- 明确提供 All、Any、Exclude 三类过滤；
- 未识别标签必须提示用户；
- 不得静默将未知标签转换为普通主题词。

#### 主题关键词

- 进入 FTS 和向量召回；
- 不作为元数据硬过滤；
- 支持自然语言和中英文混合查询。

### 5.2 API 参数调整

建议逐步从：

```text
tags=LLM,synthetic data&tagMatch=all
```

迁移为：

```text
allTags=llm,synthetic-data
anyTags=instruction-tuning,data-quality
excludeTags=image-generation
```

兼容期内保留旧参数，但服务端必须统一转换为 `SearchQueryPlan`，并在响应中返回实际生效的查询计划。

### 5.3 最终硬约束复核

无论候选来自 Exact、Strict、Broad、CJK、Vector 或 Reranker，在返回结果前都必须再次检查：

- `allTags` 是否全部满足；
- `anyTags` 是否至少满足一个；
- `excludeTags` 是否均不满足；
- 来源是否满足；
- 日期范围是否满足；
- Must Concept 是否达到覆盖门槛。

硬性验收指标：

```text
Constraint Violation Rate = 0
```

---

## 6. Canonical Tag 体系

### 6.1 目标

统一查询别名、标签统计、SQL 过滤、内存过滤和文档标签展示，避免以下问题：

- `LLM`、`LLMs`、`Large Language Model` 被视为不同标签；
- `synthetic data` 与 `data synthesis` 无法稳定匹配；
- SQL 层匹配成功，但最终过滤失败；
- 标签统计重复。

### 6.2 Canonical Tag 定义

```ts
interface CanonicalTagDefinition {
  id: string;
  displayName: string;
  category:
    | "domain"
    | "model"
    | "method"
    | "task"
    | "source"
    | "type"
    | "year";
  aliases: string[];
  chineseAliases?: string[];
}
```

示例：

```text
LLM / LLMs / large language model / 大语言模型 / 大模型
→ llm

synthetic data / synthetic dataset / data synthesis / 合成数据 / 合成语料
→ synthetic-data
```

### 6.3 存储设计

保留原有 JSON 标签字段，同时新增派生搜索索引表：

```sql
CREATE TABLE document_search_tags (
  document_id TEXT NOT NULL,
  canonical_tag TEXT NOT NULL,
  raw_tag TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (document_id, canonical_tag, category)
);
```

索引：

```sql
CREATE INDEX idx_search_tags_tag_doc
ON document_search_tags(canonical_tag, document_id);

CREATE INDEX idx_search_tags_doc_tag
ON document_search_tags(document_id, canonical_tag);
```

多标签交集查询：

```sql
SELECT document_id
FROM document_search_tags
WHERE canonical_tag IN ('llm', 'synthetic-data')
GROUP BY document_id
HAVING COUNT(DISTINCT canonical_tag) = 2;
```

### 6.4 数据迁移

- 新增数据库迁移；
- 从现有 JSON 标签回填 Canonical Tag；
- 新文档入库时同步写入派生标签表；
- 标签变化时重建该文档的派生标签；
- 搜索切换前校验标签覆盖率；
- 旧 JSON 字段暂不删除。

---

## 7. 多概念联合相关性

### 7.1 Must Concept 覆盖规则

Vector-only 结果不得自动绕过多概念覆盖检查。

建议规则：

```text
1 个 Must Concept：至少命中 1 个
2 个 Must Concept：必须命中 2 个
3 个及以上 Must Concept：至少命中 ceil(N × 0.75)
核心概念必须全部命中
```

### 7.2 概念证据来源

Must Concept 的证据可以来自：

- 标题；
- 摘要；
- Canonical Tags；
- 中英文摘要；
- 相关全文片段；
- Reranker 输出的结构化概念支持结果。

不同字段的证据强度建议如下：

```text
标题联合命中
> 摘要同句共现
> 摘要同段共现
> 摘要不同位置分别命中
> 标签联合命中
> 全文不同位置偶然命中
```

### 7.3 联合相关性特征

```ts
interface JointRelevanceFeatures {
  conceptCoverage: number;
  titleJointMatch: boolean;
  abstractJointMatch: boolean;
  sameSentenceCooccurrence: number;
  sameParagraphCooccurrence: number;
  allTagMatch: boolean;
  strictPathHit: boolean;
  vectorLexicalAgreement: boolean;
}
```

排序时应奖励多个概念在同一语境中的共同出现，而不是只使用 `some()` 判断任意概念是否命中。

---

## 8. 多路召回与融合优化

### 8.1 召回路径职责

| 召回路径 | 主要职责 | 约束 |
|---|---|---|
| Exact | 标题、模型名、论文名精确查找 | 高精度，不负责语义扩展 |
| Strict | 多概念 AND 召回 | 联合查询主路径 |
| Broad | 同义词 OR 扩展 | 仅作为候选补充 |
| CJK | 中文和混合语言召回 | 必须映射 Canonical Concept |
| Vector | 语义表达差异补充 | 不得绕过 Must Concept 和 Filter |

### 8.2 候选分层

```text
Tier 1: Strict matches
Tier 2: Supported semantic matches
Tier 3: Relaxed fallback matches
```

默认优先展示 Tier 1 和 Tier 2。只有严格候选不足且 `fallbackPolicy=allow_relaxed` 时，才加入 Tier 3。

### 8.3 最终评分

建议最终评分由以下部分组成：

```text
finalScore =
  pathFusionScore
  + conceptCoverageScore
  + fieldEvidenceScore
  + semanticAgreementScore
  + optionalRerankerScore
  - softPenalty
```

硬约束失败时直接过滤，不通过负分降权。

### 8.4 暂不优先调整的项目

在查询和过滤语义修复前，不应优先进行：

- 单纯调整向量阈值；
- 单纯修改 RRF 参数；
- 单纯调整 BM25 列权重；
- 直接更换 Embedding 模型；
- 使用 LLM 重写所有查询。

这些调整应在评测体系建立后，通过消融实验决定。

---

## 9. Reranker 与多向量索引

该阶段应在查询语义和硬过滤稳定后实施。

### 9.1 第二阶段 Reranker

```text
多路召回 50～100 个候选
→ 硬过滤
→ 规则特征初排
→ Top-K Reranker
→ 最终排序
```

Reranker 输入建议包括：

```text
Query Plan
+ Title
+ Abstract
+ Canonical Tags
+ Relevant Summary / Chunk
```

优先顺序：

1. 本地 Cross-Encoder；
2. 可配置远程 Rerank Provider；
3. LLM Structured Reranking，仅处理少量 Top-K。

要求：

- 可关闭；
- 失败时确定性回退；
- 不得修改硬过滤结果；
- 记录重排前后的排名变化；
- 单独统计 Reranker 延迟。

### 9.2 多向量表示

建议逐步拆分：

```text
title_abstract_vector
summary_vector
tag_vector
full_text_chunk_vectors
```

实施顺序：

1. `title_abstract_vector`；
2. `tag_vector`；
3. `summary_vector`；
4. 根据全文需求增加 chunk vectors。

多向量结果采用 Late Fusion，不继续把所有字段拼接成一个整体向量。

---

## 10. 搜索结果解释

建议每个结果返回：

```ts
interface SearchMatchExplanation {
  tier: "strict" | "semantic" | "relaxed";
  matchedTags: string[];
  matchedMustConcepts: string[];
  missingShouldConcepts: string[];
  matchedFields: Array<
    "title" | "abstract" | "tags" | "summary" | "full_text"
  >;
  recallPaths: string[];
  scoreBreakdown?: {
    fusion: number;
    lexical: number;
    semantic: number;
    jointCoverage: number;
    reranker?: number;
  };
}
```

前端可展示：

- 同时匹配：LLM、Synthetic Data；
- 标题命中 1 个概念，摘要命中 2 个概念；
- 严格标签交集；
- 语义补充结果；
- 可能相关：未满足全部 Must Concept。

目标不是展示所有内部权重，而是让用户理解结果为什么出现。

---

## 11. 搜索评测体系

### 11.1 标签交集测试

```text
Doc A: [LLM]
Doc B: [synthetic-data]
Doc C: [LLM, synthetic-data]
```

查询：

```text
allTags = [LLM, synthetic-data]
```

预期只返回 Doc C。

### 11.2 多概念相关性测试

```text
Doc A: 只讨论 LLM
Doc B: 只讨论 synthetic data
Doc C: 使用 synthetic data 训练 LLM
Doc D: 两个概念分别出现，但没有直接关系
```

预期：

```text
Doc C > Doc D > Doc A / Doc B
```

### 11.3 同义词测试

覆盖：

```text
LLM / large language model / 大语言模型
synthetic data / data synthesis / 合成数据
```

### 11.4 过滤约束测试

覆盖：

- allTags；
- anyTags；
- excludeTags；
- source；
- dateRange；
- 多条件组合。

### 11.5 真实查询集

至少包括：

- 短关键词；
- 多概念交集；
- 中英文混合；
- 模型名；
- 方法 + 任务；
- 自然语言问题；
- 标签 + Query 联合检索。

### 11.6 指标

保留：

- Recall@K；
- Precision@K；
- NDCG@K；
- MRR；
- Zero-result Rate；
- P50 / P95 Latency。

新增：

- Constraint Violation Rate；
- All-tag Accuracy；
- Conjunctive Precision@5；
- Must-concept Coverage；
- Relaxed-result Ratio；
- No-click Rate；
- Query Reformulation Rate；
- Click MRR。

### 11.7 质量门槛

```text
Constraint Violation Rate = 0
All-tag Accuracy = 100%
未知标签不得静默降级
Conjunctive Precision@5 >= 0.80
NDCG@10 不下降超过 0.02
Recall@20 不出现显著回退
```

---

## 12. 搜索引擎实施阶段

### S0：建立评测基线

目标：

- 自动复现 `LLM + synthetic data` 等联合查询错误；
- 记录召回路径、分数、标签和概念覆盖；
- 增加过滤条件评测；
- 建立修改前后的对比报告。

完成标准：

- 当前错误可以通过自动化测试稳定复现；
- 每次修改都能与同一基线比较。

### S1：修复过滤契约

任务：

- 多标签默认改为 all；
- 拆分标签过滤与主题关键词；
- 禁止未知标签静默转换；
- 返回实际 Query Plan；
- 增加最终硬约束复核。

完成标准：

- all 返回交集；
- any 返回并集；
- exclude 正确排除；
- 未知标签明确提示；
- Constraint Violation Rate 为 0。

### S2：统一 Canonical Tag

任务：

- 建立统一 Registry；
- 集中规范化逻辑；
- 新增派生标签索引表；
- 迁移历史标签；
- 更新标签统计与标签页。

完成标准：

- 同义标签映射一致；
- SQL 与内存过滤一致；
- 标签统计不再重复。

### S3：联合相关性优化

任务：

- 引入 `SearchQueryPlan`；
- 支持 Must / Should / Exclude Concept；
- 修改 Vector-only 通过规则；
- 增加联合覆盖特征；
- 增加 Strict / Semantic / Relaxed 分层；
- 增加 Result Explanation。

完成标准：

- 联合主题论文稳定排在单主题论文之前；
- 宽松结果不与严格结果混淆；
- 每个结果有可解释匹配信息。

### S4：Reranker 与多向量

任务：

- 定义 Reranker Provider；
- 实现可关闭的 Top-K Rerank；
- 增加 Title/Abstract 与 Tag 多向量；
- 通过消融决定是否默认启用。

完成标准：

- 联合查询 NDCG 与 Precision 提升；
- 不破坏硬过滤；
- 延迟和资源消耗可配置。

### S5：反馈驱动诊断

任务：

- 按查询类型统计点击率、无点击率和改写率；
- 识别高频失败查询；
- 生成 Hard Negative；
- 定期更新真实评测集；
- 暂不直接在线学习排序权重。

---

# 第二部分：MCP 与 Skills 接入方案

## 13. 建设目标

MCP 与 Skills 不替代搜索引擎，而是在稳定搜索能力之上提供标准化调用和复杂研究流程编排。

目标架构：

```text
PaperHub Domain Services
├─ Search Service
├─ Document Service
├─ Tag Service
├─ Recommendation Service
├─ History / Favorite Service
└─ Search Quality Service
        ↓
MCP Adapter Layer
├─ Tools
├─ Resources
└─ Structured Errors
        ↓
Agent Skills
├─ Literature Search
├─ Paper Comparison
├─ Research Gap Analysis
├─ Review Workflow
└─ Research Digest
```

核心原则：

- MCP 只做能力暴露；
- MCP 不复制搜索算法；
- REST API 与 MCP 共用同一领域服务；
- Skills 只编排 MCP 工具；
- Skills 不直接访问数据库；
- 默认本地、只读、最小权限；
- 不开放任意 SQL、文件读取或命令执行。

---

## 14. MCP Tools 设计

### 14.1 第一阶段只读 Tools

#### `search_papers`

用途：使用结构化查询搜索本地文献库。

输入：

```ts
{
  query: string;
  mode?: "keyword" | "semantic" | "hybrid";
  allTags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  sources?: string[];
  dateRange?: {
    start: string;
    end: string;
  };
  fallbackPolicy?: "strict" | "allow_relaxed";
  limit?: number;
  cursor?: string;
}
```

输出：

```ts
{
  results: Array<{
    id: string;
    title: string;
    authors: string[];
    publishedAt: string;
    source: string;
    tags: string[];
    abstract?: string;
    summary?: string;
    score: number;
    explanation: SearchMatchExplanation;
  }>;
  queryPlan: SearchQueryPlan;
  hasMore: boolean;
  nextCursor?: string;
  degraded?: boolean;
}
```

#### `get_paper`

获取单篇文献的本地记录、摘要、标签和来源链接。

#### `list_tags`

获取 Canonical Tags、分类、别名和文档计数。

#### `get_related_papers`

根据指定文献返回相似论文。第一阶段可复用向量相似度与标签交集。

#### `explain_search_result`

返回指定结果被召回的原因，包括：

- 过滤命中；
- 概念覆盖；
- 召回路径；
- 字段证据；
- 分数拆解。

#### `get_search_quality_metrics`

返回搜索覆盖、降级状态和匿名化质量统计。

#### `get_recommendations`

返回本地热门或个性化推荐。

### 14.2 第二阶段写 Tools

只在只读工具稳定后增加：

- `add_favorite`
- `remove_favorite`
- `record_reading_history`
- `save_search`
- `create_reading_list`
- `add_to_reading_list`

要求：

- 工具名称必须明确表达写行为；
- 不提供通用数据库写工具；
- 删除、覆盖操作需要显式确认；
- 写操作记录本地审计事件。

---

## 15. MCP Resources

可提供以下只读资源：

```text
paperhub://papers/{documentId}
paperhub://tags
paperhub://search/metrics
paperhub://recommendations/hot
```

Resources 用于读取稳定对象；动态检索仍通过 Tools 完成。

---

## 16. MCP 服务架构

### 16.1 目录建议

```text
src/mcp/
├── server.ts
├── transport.ts
├── registry.ts
├── errors.ts
├── schemas/
│   ├── search.ts
│   ├── documents.ts
│   └── common.ts
├── tools/
│   ├── search-papers.ts
│   ├── get-paper.ts
│   ├── list-tags.ts
│   ├── related-papers.ts
│   ├── explain-result.ts
│   ├── quality-metrics.ts
│   └── recommendations.ts
└── resources/
    ├── paper-resource.ts
    └── tag-resource.ts
```

### 16.2 领域服务抽取

建议抽取：

```text
src/services/search-service.ts
src/services/document-service.ts
src/services/tag-service.ts
src/services/recommendation-service.ts
src/services/search-quality-service.ts
```

调用关系：

```text
REST Route ─┐
            ├─> Domain Service ─> DB / Search Engine
MCP Tool  ──┘
```

MCP 不应直接调用 REST Route，也不应直接执行 SQL。

### 16.3 Transport 策略

推荐顺序：

1. 默认使用本地 `stdio`；
2. 与桌面应用启动和关闭流程集成；
3. 后续有需要时增加仅监听 localhost 的 Transport；
4. 默认不绑定 `0.0.0.0`；
5. 默认不提供公网访问。

### 16.4 错误模型

```text
INVALID_QUERY
UNKNOWN_TAG
EMBEDDING_UNAVAILABLE
INDEX_REBUILD_REQUIRED
DOCUMENT_NOT_FOUND
FILTER_CONFLICT
PERMISSION_DENIED
RATE_LIMITED
INTERNAL_ERROR
```

错误响应必须说明：

- 是否可重试；
- 是否发生降级；
- 是否需要重建索引；
- 是否因为过滤条件冲突。

---

## 17. MCP 安全与隐私

### 17.1 权限边界

- 默认只读；
- 写工具单独注册；
- 不暴露任意 SQL；
- 不暴露任意文件路径；
- 不暴露 Shell、Node eval 或动态代码执行；
- 不允许参数指定数据库路径；
- 不返回 API Key、环境变量和完整配置。

### 17.2 输出边界

- 搜索结果数量设置上限；
- 全文使用分页或有限片段；
- 默认返回摘要而非整篇全文；
- 超长字段截断并返回 continuation token；
- 错误信息不返回内部堆栈和敏感信息。

### 17.3 本地数据保护

- 默认只访问 PaperHub 数据目录；
- 查询日志继续采用匿名统计；
- Skills 不自动上传收藏、历史或全文；
- 远程模型参与 Rerank 或总结时，沿用现有 Provider 配置和安全策略。

---

## 18. Agent Skills 设计

### 18.1 Skills 定位

Skills 用于定义“如何组合 PaperHub 工具完成研究任务”，不承担底层检索、标签匹配和排序算法。

建议目录：

```text
skills/
├── literature-search/
│   ├── SKILL.md
│   ├── references/
│   │   ├── query-planning.md
│   │   ├── inclusion-exclusion.md
│   │   └── result-quality-check.md
│   └── scripts/
│       └── validate-search-results.ts
├── paper-comparison/
│   ├── SKILL.md
│   └── references/
├── research-gap-analysis/
│   ├── SKILL.md
│   └── references/
├── review-workflow/
│   ├── SKILL.md
│   └── references/
└── research-digest/
    ├── SKILL.md
    └── references/
```

### 18.2 Skill 1：Literature Search

目标：将用户研究问题转换为结构化检索计划，并验证结果是否满足核心概念。

流程：

```text
识别研究问题
→ 拆分 Must / Should / Exclude Concepts
→ 查询合法 Canonical Tags
→ 调用 search_papers
→ 检查过滤和概念覆盖
→ 必要时进行一次受控改写
→ 输出检索式、结果分组和纳入理由
```

要求：

- 不允许无限自动改写；
- 每次改写说明原因；
- 不把 Relaxed 结果当作 Strict 结果；
- 输出纳入和排除标准；
- 输出本地语料覆盖限制。

### 18.3 Skill 2：Paper Comparison

比较维度：

- 问题定义；
- 数据集；
- 方法与模型结构；
- 训练方式；
- 评估指标；
- 主要结果；
- 局限性；
- 与用户任务的适配性。

流程：

```text
搜索或读取论文
→ 验证论文身份
→ 提取固定字段
→ 生成对比矩阵
→ 标记缺失信息
→ 输出差异与适用场景
```

### 18.4 Skill 3：Research Gap Analysis

目标：从相关论文中识别尚未充分解决的问题。

要求：

- 先按方法、任务和数据集聚类；
- 区分“论文未涉及”和“领域未解决”；
- 不根据少量本地语料断言整个领域不存在相关工作；
- 明确本地语料覆盖范围；
- 对结论标注证据强度。

### 18.5 Skill 4：Review Workflow

流程：

```text
定义研究问题
→ 制定纳入排除标准
→ 多轮结构化检索
→ 去重
→ 初筛
→ 分类
→ 提取证据
→ 形成报告
```

该 Skill 应明确标记为“基于 PaperHub 本地语料的调研流程”。在未接入完整外部数据库覆盖前，不宣称满足正式系统综述的完整检索要求。

### 18.6 Skill 5：Research Digest

内容包括：

- 新增高相关论文；
- 与已有收藏的关系；
- 主题变化；
- 优先阅读建议；
- 搜索覆盖和降级状态；
- 保存查询的新增结果。

---

## 19. Skills 质量约束

每个 `SKILL.md` 至少包括：

- Goal；
- Trigger Conditions；
- Required MCP Tools；
- Inputs；
- Step-by-step Workflow；
- Validation Rules；
- Failure and Fallback Behavior；
- Output Schema；
- Non-goals；
- Examples。

Skills 不得：

- 绕过 MCP 工具直接访问数据库；
- 假设未读取论文的具体内容；
- 将相似度分数当作事实证据；
- 在结果不足时伪造论文；
- 隐藏搜索降级；
- 将“本地库没有结果”表达为“领域中没有相关研究”。

---

## 20. MCP 与 Skills 实施阶段

### M0：稳定领域服务契约

前置条件：

- 至少完成搜索方案 S1 和 S2；
- 确定 `SearchQueryPlan`；
- 确定搜索响应和错误模型。

任务：

- 从 API Route 中抽取领域服务；
- REST API 保持兼容；
- 增加服务层测试；
- 明确错误码和降级状态。

### M1：只读 MCP Server

任务：

- 建立 MCP Server；
- 实现本地 Transport；
- 实现 `search_papers`、`get_paper`、`list_tags`；
- 增加输入 Schema 校验；
- 增加工具级日志；
- 提供健康状态。

完成标准：

- 外部 MCP Client 能搜索和读取本地论文；
- 返回结果与 REST API 语义一致；
- 所有输入经过 Schema 校验；
- 不存在任意 SQL、文件和命令执行入口。

### M2：增强只读工具

任务：

- 增加 Related Papers；
- 增加 Result Explanation；
- 增加 Quality Metrics；
- 增加 Recommendations；
- 增加 Resources；
- 支持 Cursor Pagination；
- 增加降级和索引错误处理。

### M3：首批 Skills

任务：

- 实现 Literature Search；
- 实现 Paper Comparison；
- 实现 Research Gap Analysis；
- 建立 Skill 场景测试；
- 建立共享 Query Planning 和质量检查文档。

完成标准：

- Skill 能稳定调用 MCP 工具；
- 联合查询不会退化为单概念结果集合；
- 输出包含检索条件、结果来源和覆盖限制。

### M4：受控写工具与研究工作流

任务：

- 增加收藏；
- 增加阅读历史；
- 增加保存查询；
- 增加阅读列表；
- 增加写操作确认与审计；
- 实现 Review Workflow；
- 实现 Research Digest。

---

## 21. 测试矩阵

### 搜索引擎测试

| 测试层级 | 内容 |
|---|---|
| 单元测试 | Tag Normalization、Query Planning、Must/Should Parsing、Filter Predicate、Score Features |
| 数据库测试 | Canonical Tag Migration、allTags SQL、excludeTags SQL、索引同步 |
| 集成测试 | API 参数到最终结果的完整语义 |
| 搜索回归测试 | Exact、Strict、Broad、CJK、Vector、Fallback |
| UI 测试 | 标签输入、All/Any/Exclude、未知标签提示、结果解释 |
| 性能测试 | P50/P95、向量不可用降级 |
| 评测测试 | Recall、NDCG、Conjunctive Precision、Constraint Violation |

### MCP 与 Skills 测试

| 测试层级 | 内容 |
|---|---|
| Schema 测试 | Tool 输入边界、非法标签、分页、输出字段 |
| Service 测试 | REST 与 MCP 复用同一领域服务 |
| MCP 集成测试 | Server 启动、Tool Discovery、Tool Call、Resource Read |
| 安全测试 | 任意路径、任意 SQL、超大 Limit、非法写操作、配置泄露 |
| 降级测试 | Embedding 离线、索引重建、数据库锁、文档不存在 |
| Skill 场景测试 | 联合检索、比较、研究空白分析、结果不足处理 |
| 回归测试 | MCP 接入不影响桌面应用和现有 API |

建议质量命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm search:eval
pnpm search:eval:compare
pnpm test:mcp
pnpm test:skills
```

命令应在对应脚本实际创建后再纳入强制质量门槛。

---

## 22. 风险与控制

### 风险 1：严格 AND 导致结果过少

控制：

- Strict 与 Relaxed 分层；
- 用户显式选择是否允许宽松结果；
- 不自动修改用户过滤条件。

### 风险 2：Canonical Tag 迁移影响旧数据

控制：

- 采用派生索引表；
- 不立即删除 JSON 标签；
- 迁移前后比较覆盖率；
- 保留可重建脚本。

### 风险 3：规则与排序逻辑分散

控制：

- Query Plan、Filter、Recall、Fusion、Explanation 分层；
- 每个特征独立测试；
- API、MCP 和数据库层不重复实现同一规则。

### 风险 4：Reranker 增加延迟

控制：

- 默认关闭或仅处理小规模 Top-K；
- 本地和远程模式分开统计；
- 失败自动回退。

### 风险 5：MCP 复制搜索逻辑

控制：

- 先抽取 Domain Service；
- REST 与 MCP 仅作为 Adapter；
- 查询解析、过滤和排序只保留一份实现。

### 风险 6：MCP 工具边界过宽

控制：

- 采用白名单工具；
- 不提供通用数据库工具；
- 写能力按具体动作拆分；
- 限制结果数量和全文长度。

### 风险 7：Skills 掩盖底层搜索问题

控制：

- Skills 必须读取 Match Explanation；
- 对 Relaxed 和 Degraded 结果显式标记；
- 搜索质量不达标时不宣称结果完整。

---

## 23. 推荐组合实施路线

### 第一阶段：搜索质量基线

执行：

- S0：评测与诊断；
- S1：标签语义和硬过滤；
- S2：Canonical Tag。

输出：

- 可复现问题；
- 稳定过滤契约；
- 统一标签体系；
- Constraint Violation Rate 为 0。

### 第二阶段：联合相关性

执行：

- S3：Must / Should Concept；
- 联合特征重排；
- Strict / Semantic / Relaxed 分层；
- Result Explanation。

输出：

- `LLM + synthetic data` 优先返回真正联合主题论文；
- 用户能够理解结果来源；
- 真实联合查询评测达标。

### 第三阶段：MCP 只读能力

执行：

- M0：领域服务抽取；
- M1：基础 MCP Server；
- M2：增强只读工具。

输出：

- 外部 Agent 能稳定搜索和读取本地语料；
- MCP 与桌面搜索结果一致。

### 第四阶段：Skills 与高级排序

并行评估：

- S4：Reranker 与多向量；
- M3：首批 Skills。

输出：

- 更高质量的复杂查询排序；
- 可复用的文献检索、比较和研究空白分析流程。

### 第五阶段：反馈闭环与受控写能力

执行：

- S5：反馈数据诊断；
- M4：收藏、阅读列表和调研工作流。

输出：

- 搜索失败查询持续进入评测集；
- Agent 能在用户确认下组织本地研究资料。

---

## 24. 建议任务拆分

后续可拆分为以下任务：

```text
TASK_search_eval_conjunctive_baseline.md
TASK_search_filter_contract.md
TASK_search_unknown_tag_behavior.md
TASK_search_canonical_tag_registry.md
TASK_search_tag_index_migration.md
TASK_search_query_plan.md
TASK_search_joint_relevance.md
TASK_search_result_explanation.md
TASK_search_reranker_spike.md
TASK_search_multivector_spike.md
TASK_domain_search_service.md
TASK_mcp_server_foundation.md
TASK_mcp_search_papers_tool.md
TASK_mcp_document_and_tag_tools.md
TASK_skill_literature_search.md
TASK_skill_paper_comparison.md
TASK_skill_research_gap.md
```

每个任务文档至少包含：

- Goal；
- Why Now；
- Non-goals；
- Current Behavior；
- Expected Behavior；
- Files to Read；
- Files to Edit；
- API / Schema Changes；
- Data Migration；
- Validation Commands；
- Acceptance Criteria；
- Stop Conditions；
- Rollback Considerations。

---

## 25. 最终验收标准

### 搜索引擎

- 多标签 All / Any / Exclude 行为准确；
- 未知标签不再静默改变语义；
- 同义标签统一为 Canonical Tag；
- 硬约束违规率为 0；
- 多概念查询优先返回联合相关论文；
- Vector 结果不能绕过 Must Concept；
- 搜索结果具有可解释匹配原因；
- 真实查询集和回归评测进入质量门槛。

### MCP

- MCP 与 REST API 复用同一领域服务；
- 工具输入输出具有稳定 Schema；
- 默认只读、本地运行；
- 不存在任意 SQL、文件或命令执行；
- 降级、索引错误和文档缺失具有结构化错误；
- MCP 接入不影响桌面应用现有功能。

### Skills

- Skills 只调用注册的 MCP 工具；
- 能执行文献检索、比较和研究空白分析；
- 能检查 Must Concept、过滤条件和结果层级；
- 不把本地无结果解释为领域无研究；
- 输出包含检索策略、纳入标准、证据来源和覆盖限制。

---

## 26. 最终建议

推荐采用以下顺序：

```text
先优化搜索引擎
→ 再稳定领域服务契约
→ 接入只读 MCP
→ 建设 Agent Skills
→ 最后增加 Reranker、多向量和受控写能力
```

不建议直接通过 MCP 或 Skills 解决当前搜索质量问题，因为二者只能消费底层搜索结果，不能自动修复标签 OR、未知标签降级、Vector 单概念误召回和多概念覆盖不足。

第一优先级应完成 S0～S3，使 PaperHub 的本地搜索在语义正确性、联合相关性和可评测性上达到稳定状态；随后再将该能力通过 MCP 和 Skills 对外提供。
