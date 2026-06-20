# PaperHub 接入 Ollama Embedding 模型实施方案

## 一、改造目标

为 PaperHub 增加 Ollama 本地 Embedding Provider，使系统能够：

1. 使用本机 Ollama 生成文档和查询向量；
2. 在 OpenAI、Ollama 和 Mock Embedding 之间切换；
3. 自动识别模型输出维度；
4. 模型或维度发生变化时安全重建向量索引；
5. Ollama 不可用时不影响应用启动、全文搜索和基本阅读功能；
6. 保证文档索引和搜索查询使用完全相同的模型配置；
7. 保留现有缓存、索引状态、失败重试和混合搜索机制。

本次改造不包含：

* 将 Ollama 打包进 PaperHub 安装包；
* 自动下载或自动启动 Ollama；
* 同时维护多个 Embedding 模型的索引；
* 对论文进行分块级向量检索；
* 引入独立向量数据库。

首版继续采用“每篇文档一个向量”的现有结构。

---

## 二、总体技术方案

目标调用链调整为：

```text
PaperHub 配置
    ↓
Embedding Runtime Resolver
    ↓
Embedding Provider Factory
    ├── OpenAIEmbeddingProvider
    ├── OllamaEmbeddingProvider
    └── MockEmbeddingProvider
    ↓
统一的 embed / embedBatch 接口
    ↓
缓存层
    ↓
sqlite-vec 向量索引
    ↓
向量搜索 / 混合搜索
```

核心原则：

* Provider 只负责生成向量；
* Runtime 负责确定模型、地址、维度和签名；
* 数据库层负责检查当前索引是否与 Runtime 匹配；
* 模型切换时必须清空并重建旧向量；
* 索引重建期间回退到 FTS5 关键词搜索；
* 不允许新旧模型向量同时存在于一个索引中。

---

## 三、推荐默认配置

首版建议采用以下环境变量：

```env
EMBEDDING_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b

EMBEDDING_TIMEOUT_MS=30000
EMBEDDING_BATCH_SIZE=8
EMBEDDING_KEEP_ALIVE=5m
EMBEDDING_TRUNCATE=true
```

可增加一个可选校验变量：

```env
EMBEDDING_EXPECTED_DIMENSIONS=
```

该变量为空时，通过第一次测试请求自动获取维度；填写时，返回向量维度不一致则拒绝启用该模型。

不建议要求用户手动填写向量维度作为唯一来源，因为不同模型和模型标签可能产生不同维度。

配置优先级建议为：

```text
环境变量
→ PaperHub 本地 Embedding 设置
→ 系统默认值
```

首个版本可以先只支持环境变量，确保核心功能稳定；后续再加入桌面端设置页面。

---

## 四、Provider 抽象设计

### 4.1 类型定义

新增统一接口：

```ts
export type EmbeddingProviderName = "openai" | "ollama" | "mock";

export interface EmbeddingRuntime {
  provider: EmbeddingProviderName;
  model: string;
  baseUrl?: string;
  dimensions: number;
  signature: string;
  truncate: boolean;
  keepAlive?: string;
  timeoutMs: number;
}

export interface EmbeddingProvider {
  readonly name: EmbeddingProviderName;

  embed(input: string): Promise<number[]>;

  embedBatch(input: string[]): Promise<number[][]>;

  probe(): Promise<EmbeddingProbeResult>;
}

export interface EmbeddingProbeResult {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  reachable: boolean;
}
```

### 4.2 文件组织

保留当前公共入口 `src/embedding.ts`，避免修改大量现有 import。

建议新增：

```text
src/
├── embedding.ts
└── embedding/
    ├── types.ts
    ├── runtime.ts
    ├── cache.ts
    └── providers/
        ├── openai.ts
        ├── ollama.ts
        └── mock.ts
```

职责划分：

* `embedding.ts`：兼容现有调用，导出 `generateEmbedding`、`generateEmbeddings`、`getEmbeddingRuntime`；
* `runtime.ts`：读取配置、创建 Provider、生成签名；
* `cache.ts`：根据 Runtime 动态校验维度；
* `ollama.ts`：实现 Ollama HTTP 调用；
* `openai.ts`：迁移现有 OpenAI 逻辑；
* `mock.ts`：迁移现有测试向量逻辑。

---

## 五、Ollama Provider 实现要求

### 5.1 请求格式

请求地址：

```text
POST {OLLAMA_BASE_URL}/api/embed
```

请求体：

```json
{
  "model": "qwen3-embedding:0.6b",
  "input": ["text one", "text two"],
  "truncate": true,
  "keep_alive": "5m"
}
```

只有明确配置了输出维度时才传递：

```json
{
  "dimensions": 1024
}
```

不要默认强制把所有模型转换成 1536 维。

### 5.2 地址处理

`OLLAMA_BASE_URL` 必须：

* 去除末尾 `/`；
* 只允许 `http` 或 `https`；
* 默认使用 `http://127.0.0.1:11434`；
* 日志中不得输出 URL 中可能存在的认证信息；
* 连接失败时提供明确错误，而不是只输出 `fetch failed`。

### 5.3 超时和错误处理

使用 `AbortController` 实现超时。

需要区分以下错误：

```text
OLLAMA_UNREACHABLE
OLLAMA_MODEL_NOT_FOUND
OLLAMA_TIMEOUT
OLLAMA_INVALID_RESPONSE
OLLAMA_DIMENSION_MISMATCH
OLLAMA_EMPTY_EMBEDDING
```

用户可读错误示例：

```text
无法连接到 Ollama：请确认 Ollama 已启动，并检查
http://127.0.0.1:11434。

模型 qwen3-embedding:0.6b 不存在，请先执行：
ollama pull qwen3-embedding:0.6b
```

不要由 PaperHub 自动执行 `ollama pull`，避免未经用户确认下载大型模型。

### 5.4 响应校验

每次响应必须检查：

* `embeddings` 是否存在；
* 返回向量数量是否与输入数量一致；
* 每个向量是否非空；
* 所有向量维度是否一致；
* 所有值是否为有限数字；
* 返回维度是否与 Runtime 记录一致。

---

## 六、Embedding Runtime 与签名

当前签名机制可以继续使用，但需要扩展。

建议签名格式：

```text
{provider}:{model}:{dimensions}:{textProfileVersion}:{endpointFingerprint}
```

例如：

```text
ollama:qwen3-embedding-0.6b:1024:document-v2:localhost-11434
```

签名必须包含：

* Provider；
* 模型完整名称及标签；
* 实际向量维度；
* 文档向量文本拼接规则版本；
* Ollama Endpoint 指纹。

不需要包含：

* 超时时间；
* Batch Size；
* keep_alive；
* API Key。

增加 `textProfileVersion` 的原因是：即使模型不变，只要文档向量的输入内容发生变化，也必须重建索引。

例如：

```ts
const EMBEDDING_TEXT_PROFILE_VERSION = "document-v2";
```

---

## 七、文档向量内容构建

当前逻辑将以下内容拼接成一个向量：

```text
标题
摘要
全文
中文总结
英文总结
领域标签
模型标签
```

首版可以继续沿用，但应抽出独立函数：

```ts
export function buildDocumentEmbeddingText(doc: Document): string
```

建议顺序：

```text
Title: ...
Abstract: ...
Summary Zh: ...
Summary En: ...
Domain Tags: ...
Model Tags: ...
Full Text: ...
```

不要继续在多个位置直接使用 `.slice(0, 8000)`。

增加统一配置：

```env
EMBEDDING_MAX_INPUT_CHARS=24000
```

首版仍可按字符截断，但必须：

* 标题和摘要优先保留；
* 总结优先于全文；
* 全文只使用剩余长度；
* 不得让超长全文挤掉标题、摘要和标签。

后续单独开发论文分块检索，不与本次 Ollama 接入混在一起。

---

## 八、缓存改造

当前缓存校验固定要求向量长度为 1536，需要改为：

```ts
if (data.length === runtime.dimensions) {
  return data;
}
```

缓存文件键继续包含 Runtime Signature。

模型切换后：

* 旧缓存不需要立即删除；
* 因为签名变化，旧缓存不会再被读取；
* 可以增加后台缓存清理功能，但不属于本次 P0 范围。

缓存内容建议从裸数组升级为：

```json
{
  "signature": "ollama:...",
  "dimensions": 1024,
  "embedding": []
}
```

这样可以更容易定位缓存不一致问题。

---

## 九、数据库与向量维度迁移

这是本次改造中风险最高的部分。

### 9.1 当前问题

sqlite-vec 表在创建时已经固定向量维度，因此不能把不同维度的模型直接写入同一张表。

必须新增数据库迁移版本，例如 v10。

### 9.2 元数据扩展

扩展 `embedding_index_metadata`，至少保存：

```text
signature
provider
model
dimensions
status
last_error
rebuild_started_at
rebuild_completed_at
updated_at
```

其中 `status` 建议为：

```text
unconfigured
probing
ready
rebuild_required
rebuilding
failed
```

### 9.3 启用新 Runtime 的流程

严格按照以下顺序执行：

```text
读取新配置
→ 调用 Ollama probe
→ 获取真实向量维度
→ 验证响应有效
→ 生成新 signature
→ 与当前索引元数据比较
→ 判断是否需要重建
```

只有 Ollama Probe 成功后，才允许修改现有索引。

绝对不能在 Ollama 尚未连接成功时先清空现有向量。

### 9.4 模型不变

如果：

```text
旧 signature == 新 signature
且旧 dimensions == 新 dimensions
```

则：

* 不重建索引；
* 不修改已有向量；
* 直接进入 ready 状态。

### 9.5 模型或维度变化

如果签名或维度发生变化：

1. 将索引状态设为 `rebuild_required`；
2. 启动事务；
3. 删除或重建 `document_vectors_v2`；
4. 使用新维度创建 sqlite-vec 表；
5. 清空所有旧向量；
6. 将所有文档索引状态改为 `pending`；
7. 清空 `vector_indexed_at`；
8. 将元数据更新为新 Runtime；
9. 状态改为 `rebuilding`；
10. 后台重新生成全部向量。

动态建表形式：

```sql
CREATE VIRTUAL TABLE document_vectors_v2 USING vec0(
  document_id TEXT PRIMARY KEY,
  embedding float[${dimensions}] distance_metric=cosine
);
```

`dimensions` 只能来自经过验证的整数，并限制在合理范围内，例如：

```text
32 <= dimensions <= 8192
```

禁止直接把未经验证的环境变量拼入 SQL。

### 9.6 防止新旧向量混用

即使两个模型输出维度相同，也必须清空旧索引。

例如：

```text
OpenAI 1536 维
→ 某个 Ollama 模型也输出 1536 维
```

维度一致不代表两个向量处于同一个语义空间，不能直接混合搜索。

判断依据必须是完整 Signature，而不是只有 Dimensions。

---

## 十、索引重建流程

复用现有：

* `document_index_state`；
* `embedding_status`；
* `embedding_attempts`；
* `last_error`；
* `getPendingVectorDocuments()`；
* `vector_signature`。

建议增加：

```ts
rebuildEmbeddingIndex()
getEmbeddingIndexProgress()
finalizeEmbeddingIndex()
```

重建过程：

```text
读取 pending 文档
→ 批量构建 Embedding 文本
→ Ollama batch embed
→ 校验全部向量
→ 事务写入 sqlite-vec
→ 更新各文档索引状态
→ 继续下一批
→ 全部成功后状态改为 ready
```

建议 Batch Size：

```text
默认 8
最小 1
最大 32
```

失败处理：

* 单批失败时，将该批拆分成单条重试；
* 单文档最多重试 5 次；
* 一个文档失败不得阻断其他文档；
* 最终状态中展示成功数、失败数和待处理数。

---

## 十一、搜索降级策略

### 11.1 Ollama 未配置

行为：

```text
keyword 模式：正常
semantic 模式：返回不可用原因
hybrid 模式：自动退化为 keyword_fallback
```

### 11.2 Ollama 未启动

不能导致：

* API 服务启动失败；
* Electron 页面白屏；
* 普通关键词搜索失败；
* 文档采集或摘要功能失败。

### 11.3 索引重建中

建议首版在 `rebuilding` 状态下暂时禁用向量搜索。

原因：

* 重建中的索引覆盖率不完整；
* 搜索结果会随着后台任务不断变化；
* 很难向用户解释结果缺失。

Hybrid Search 应返回：

```json
{
  "mode": "keyword_fallback",
  "degraded": true,
  "reason": "embedding_index_rebuilding"
}
```

重建完成后自动恢复向量搜索。

---

## 十二、设置管理方案

### 第一阶段：环境变量

先完成：

```env
EMBEDDING_PROVIDER
OLLAMA_BASE_URL
OLLAMA_EMBEDDING_MODEL
EMBEDDING_TIMEOUT_MS
EMBEDDING_BATCH_SIZE
EMBEDDING_KEEP_ALIVE
EMBEDDING_TRUNCATE
```

优点：

* 改动范围小；
* 方便测试；
* 不涉及前端设置交互；
* 更适合先验证索引迁移逻辑。

### 第二阶段：桌面端设置页面

新增“Embedding 设置”区域：

```text
Provider：OpenAI / Ollama
Base URL
Model
连接测试
检测到的向量维度
当前索引状态
已索引文档数
失败文档数
重建索引按钮
```

建议 API：

```text
GET  /api/settings/embedding
PUT  /api/settings/embedding
POST /api/settings/embedding/test
POST /api/index/embedding/rebuild
GET  /api/index/embedding/status
```

保存新配置时不要立即清空索引。

正确流程：

```text
保存候选配置
→ 测试连接
→ 显示模型、维度和重建影响
→ 用户确认
→ 激活配置并开始重建
```

---

## 十三、开发任务拆分

不要把所有内容放进一个 Codex 任务。

### Task 1：Embedding Provider 抽象

目标：

* 拆分 OpenAI、Mock Provider；
* 新增 Ollama Provider；
* 保持 `generateEmbedding()` 现有调用兼容；
* 增加单条和批量 Embedding；
* 增加超时、响应校验和错误类型。

主要文件：

```text
src/embedding.ts
src/embedding/types.ts
src/embedding/runtime.ts
src/embedding/cache.ts
src/embedding/providers/openai.ts
src/embedding/providers/ollama.ts
src/embedding/providers/mock.ts
```

本任务不修改数据库结构。

### Task 2：动态向量维度与索引重建

目标：

* 新增数据库迁移；
* 扩展 Embedding 元数据；
* 根据实际维度重建 sqlite-vec 表；
* 防止新旧模型向量混用；
* 增加整库 pending、rebuilding、ready 状态。

主要文件：

```text
src/db/index.ts
src/db/search.ts
src/db/embedding-index.ts
```

### Task 3：索引 Worker 与降级逻辑

目标：

* 批量调用 Ollama；
* 增加索引进度；
* 重建期间禁用向量搜索；
* Ollama 不可用时 Hybrid Search 回退到 FTS；
* 补充失败重试和最终状态统计。

主要文件：

```text
现有索引调度文件
src/db/search.ts
src/search.ts
src/api/相关索引路由
```

### Task 4：设置 API 与桌面端配置

目标：

* 支持 Ollama 配置保存；
* 支持连接测试；
* 支持手动重建；
* 展示索引状态和错误。

该任务必须在前三项稳定后实施。

### Task 5：检索质量评估与文档

目标：

* 更新 README；
* 增加 Ollama 安装和模型拉取说明；
* 使用现有 Search Eval 对比 OpenAI、Ollama 和 Mock；
* 记录速度、召回率和索引耗时。

---

## 十四、测试方案

### 14.1 Provider 单元测试

覆盖：

* 单字符串 Embedding；
* Batch Embedding；
* Base URL 末尾斜杠；
* 超时；
* HTTP 404；
* 模型不存在；
* 空响应；
* 向量数量错误；
* 向量维度不一致；
* 非数字向量；
* Ollama 离线。

测试中使用本地 Mock HTTP Server，不依赖真实 Ollama。

### 14.2 缓存测试

覆盖：

* 同模型同文本命中缓存；
* 模型变化不命中旧缓存；
* 维度变化不读取旧缓存；
* 损坏的缓存文件自动忽略；
* Signature 变化产生不同缓存文件。

### 14.3 数据库迁移测试

覆盖：

* 1536 维旧索引迁移到新模型；
* 相同维度但不同模型仍清空重建；
* 不同维度重建 sqlite-vec 表；
* Probe 失败时不删除旧索引；
* 重建失败后索引状态为 failed；
* 应用重启后继续处理 pending 文档。

### 14.4 搜索测试

覆盖：

* Ollama ready 时 semantic 搜索正常；
* Ollama 未配置时 keyword 正常；
* Ollama 离线时 hybrid 自动回退；
* rebuilding 时不执行向量查询；
* 模型切换后查询向量和文档向量使用同一 Signature；
* 中文查询能够召回英文论文；
* 英文查询能够召回中文总结。

### 14.5 实机测试

至少在 Windows 桌面端完成：

```text
安装并启动 Ollama
ollama pull qwen3-embedding:0.6b
启动 PaperHub
测试连接
重建索引
执行中英文语义搜索
关闭 Ollama
确认关键词搜索仍然正常
重启 Ollama
确认语义搜索恢复
```

---

## 十五、验收标准

功能验收必须同时满足：

1. `EMBEDDING_PROVIDER=ollama` 时可以生成真实本地向量；
2. 未配置 OpenAI API Key 也能使用语义搜索；
3. Ollama 不可用时 PaperHub 仍能正常启动；
4. 关键词搜索不依赖 Ollama；
5. 模型切换会触发一次完整索引重建；
6. 旧模型向量不会与新模型向量混用；
7. 向量维度不再硬编码为 1536；
8. 相同配置重启后不会重复重建；
9. 缓存按模型和维度隔离；
10. 索引进度和失败原因可查询；
11. 所有现有测试通过；
12. 新增 Ollama Provider、迁移和降级测试通过；
13. `pnpm typecheck`、`pnpm test` 和搜索评估命令通过。

---

## 十六、风险与回滚

### 风险一：向量维度不一致

处理：

* Probe 自动检测；
* 写入前再次验证；
* sqlite-vec 建表维度使用检测结果；
* 不允许静默截断或补零。

### 风险二：切换模型导致索引不可用

处理：

* Probe 成功后才修改索引；
* 重建期间自动回退到 FTS；
* 原始文档数据不受影响；
* 向量可以随时重新生成。

### 风险三：Ollama 长时间无响应

处理：

* 请求超时；
* AbortController；
* 单文档失败不阻断队列；
* 限制并发和 Batch Size。

### 风险四：本地资源不足

处理：

* 默认使用较小模型；
* Batch Size 可配置；
* 支持 `keep_alive`；
* 前端展示明确错误；
* 不在 PaperHub 内自动下载模型。

### 回滚方案

保留：

```env
EMBEDDING_PROVIDER=openai
```

当 Ollama 出现问题时：

1. 切回 OpenAI；
2. 重新 Probe；
3. 清空 Ollama 向量索引；
4. 使用 OpenAI Signature 重建；
5. FTS5 搜索在整个过程中保持可用。

---

## 十七、后续优化

Ollama 接入稳定后，再单独规划：

1. 论文按章节或语义分块；
2. 文档级向量与 Chunk 级向量双层召回；
3. 为查询和文档增加不同任务指令；
4. 支持 Reranker；
5. 支持多个 Embedding 索引共存；
6. 自动评估模型切换前后的检索质量；
7. 根据设备内存推荐本地模型；
8. 后台限速与空闲时索引；
9. 模型下载和磁盘占用管理。

这些内容不应进入首个 Ollama 接入 PR。
