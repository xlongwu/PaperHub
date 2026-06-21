# PaperHub 搜索引擎优化（第一部分）

本轮完成计划中的 S0–S5 搜索优化，并保持 REST/UI 兼容。

## 已落地

- 统一 `SearchQueryPlan`：All / Any / Exclude Tags、Must / Should / Exclude Concepts、来源、日期与降级策略。
- 旧 `tags` 参数继续兼容，但多标签默认改为交集；未知标签返回结构化 `UNKNOWN_TAG`，不再静默转成主题词。
- 新增 Canonical Tag Registry 与 `document_search_tags` 派生索引；JSON 标签继续保留。
- Canonical Tag 统计由派生索引触发器自动维护，文档标签更新或删除后标签页计数保持一致。
- 方法类 Canonical Tags 可从标题、摘要和摘要结果中确定性派生，历史文档通过迁移回填。
- SQL、向量召回、内存复核和标签统计共用 Canonical Tag 语义。
- Vector、CJK、Broad 等候选返回前统一执行硬过滤和 Must Concept 覆盖复核。
- 搜索结果分为 Strict / Semantic / Relaxed，并返回命中标签、概念、字段、召回路径和分数拆解。
- 新增整体、标题摘要、标签三路向量，使用 Late Fusion；可设置 `PAPERHUB_MULTI_VECTOR=off` 关闭。
- 新增本地 Top-K reranker；可设置 `PAPERHUB_RERANKER=off` 关闭，通过 `PAPERHUB_RERANK_TOP_K` 控制规模。
- 匿名反馈增加 Query Intent、No-click Rate、Click MRR、失败查询哈希和 Hard Negative 文档候选。

## 数据库迁移

- v14：Canonical 搜索标签索引。
- v15：搜索事件查询类型。
- v16：标题摘要与标签向量表。
- v17：搜索事件结果与 Hard Negative 诊断数据。
- v18：Canonical Tag 统计自动同步触发器。
- v19：方法类内容标签派生与历史索引回填。

升级时保留原始标签 JSON；多向量迁移会把文档标为待重新索引，关键词搜索仍可用。

## 评测结果

固定 Phase 6 联合查询集（19 条）：

- Constraint Violation Rate：0%
- All-tag Accuracy：100%
- Conjunctive Precision@5：96%
- Recall@20：97.37%
- NDCG@10：97.29%
- 中文 Recall@20：100%

完整合成语料（200 条查询 / 200 篇文档）：

- Constraint Violation Rate：0%
- All-tag Accuracy：100%
- Conjunctive Precision@5：99.87%
- Recall@20：100%
- NDCG@10：95.06%
- P95 Latency：94 ms

关闭 reranker 与多向量的消融结果为 NDCG@10 94.79%、MRR@10 99.15%；默认启用后分别为 95.06% 和 99.56%，代价是平均延迟从 34 ms 增至 47 ms。

## 验证命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm ui:build
pnpm search:eval
pnpm search:eval:baseline
pnpm search:eval:compare
```
