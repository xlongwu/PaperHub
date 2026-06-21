/**
 * Centralized i18n strings for bilingual (zh/en) report generation.
 */

export type Lang = "zh" | "en";

/** Get a bilingual string by language key. */
function t(zh: string, en: string): Record<Lang, string> {
  return { zh, en };
}

// ---------------------------------------------------------------------------
// Status & error messages (used in index.ts, rollup.ts)
// ---------------------------------------------------------------------------

export const MSG = {
  noActivity: t("过去24小时无活动。", "No activity in the last 24 hours."),
  summaryFailed: t("⚠️ 摘要生成失败。", "⚠️ Summary generation failed."),
  skillsFailed: t("⚠️ Skills 摘要生成失败。", "⚠️ Skills summary generation failed."),
  trendingNoData: t(
    "⚠️ 今日趋势数据获取失败，无法生成报告。",
    "⚠️ Trending data unavailable, unable to generate report.",
  ),
  trendingFailed: t("⚠️ 趋势报告生成失败。", "⚠️ Trending report generation failed."),
} as const;

// ---------------------------------------------------------------------------
// Report headers & labels (used in report-builders.ts, index.ts, rollup.ts)
// ---------------------------------------------------------------------------

export const CLI_REPORT = {
  title: t("AI CLI 工具社区动态日报", "AI CLI Tools Community Digest"),
  meta: (utcStr: string, count: number, lang: Lang) =>
    lang === "en"
      ? `> Generated: ${utcStr} UTC | Tools covered: ${count}\n\n`
      : `> 生成时间: ${utcStr} UTC | 覆盖工具: ${count} 个\n\n`,
  skillsHeading: t("Claude Code Skills 社区热点", "Claude Code Skills Highlights"),
  skillsSource: t("数据来源", "Source"),
  comparison: t("横向对比", "Cross-Tool Comparison"),
  detail: t("各工具详细报告", "Per-Tool Reports"),
} as const;

export const OPENCLAW_REPORT = {
  title: t("OpenClaw 生态日报", "OpenClaw Ecosystem Digest"),
  deepDive: t("OpenClaw 项目深度报告", "OpenClaw Deep Dive"),
  comparison: t("横向生态对比", "Cross-Ecosystem Comparison"),
  peers: t("同赛道项目详细报告", "Peer Project Reports"),
} as const;

export const WEB_REPORT = {
  title: t("AI 官方内容追踪报告", "Official AI Content Report"),
  firstCrawl: t("首次全量", "First full crawl"),
  todayUpdate: t("今日更新", "Today's update"),
  newContent: (count: number, lang: Lang) =>
    lang === "en" ? `New content: ${count} articles` : `新增内容: ${count} 篇`,
  generated: (utcStr: string, lang: Lang) =>
    lang === "en" ? `Generated: ${utcStr} UTC` : `生成时间: ${utcStr} UTC`,
  sourcesHeader: t("数据来源:", "Sources:"),
  issueTitle: (dateStr: string, isFirstRun: boolean, lang: Lang) =>
    lang === "en"
      ? `🌐 Official AI Content Report ${dateStr}${isFirstRun ? " (First Crawl)" : ""}`
      : `🌐 AI 官方内容追踪报告 ${dateStr}${isFirstRun ? "（首次全量）" : ""}`,
} as const;

export const TRENDING_REPORT = {
  title: t("AI 开源趋势日报", "AI Open Source Trends"),
  sources: t("数据来源: GitHub Trending + GitHub Search API", "Sources: GitHub Trending + GitHub Search API"),
  issueTitle: (dateStr: string, lang: Lang) =>
    lang === "en" ? `📈 AI Open Source Trends ${dateStr}` : `📈 AI 开源趋势日报 ${dateStr}`,
} as const;

export const HN_REPORT = {
  title: t("Hacker News AI 社区动态日报", "Hacker News AI Community Digest"),
  issueTitle: (dateStr: string, lang: Lang) =>
    lang === "en" ? `📰 Hacker News AI Digest ${dateStr}` : `📰 Hacker News AI 社区动态日报 ${dateStr}`,
} as const;

export const PH_REPORT = {
  title: t("Product Hunt AI 产品日报", "Product Hunt AI Products Digest"),
  issueTitle: (dateStr: string, lang: Lang) =>
    lang === "en" ? `🚀 Product Hunt AI Digest ${dateStr}` : `🚀 Product Hunt AI 产品日报 ${dateStr}`,
} as const;

export const ARXIV_REPORT = {
  title: t("ArXiv AI 研究日报", "ArXiv AI Research Digest"),
  issueTitle: (dateStr: string, lang: Lang) =>
    lang === "en" ? `📚 ArXiv AI Research Digest ${dateStr}` : `📚 ArXiv AI 研究日报 ${dateStr}`,
} as const;

export const HF_REPORT = {
  title: t("Hugging Face 热门模型日报", "Hugging Face Trending Models Digest"),
  issueTitle: (dateStr: string, lang: Lang) =>
    lang === "en" ? `🤗 Hugging Face Trending Models ${dateStr}` : `🤗 Hugging Face 热门模型日报 ${dateStr}`,
} as const;

export const COMMUNITY_REPORT = {
  title: t("技术社区 AI 动态日报", "Tech Community AI Digest"),
  issueTitle: (dateStr: string, lang: Lang) =>
    lang === "en" ? `💬 Tech Community AI Digest ${dateStr}` : `💬 技术社区 AI 动态日报 ${dateStr}`,
} as const;

export const WEEKLY_REPORT = {
  title: t("AI 工具生态周报", "AI Tools Ecosystem Weekly Report"),
  coverage: t("覆盖日期", "Coverage"),
  issueTitle: (weekStr: string) => `📅 AI 工具生态周报 ${weekStr}`,
} as const;

export const MONTHLY_REPORT = {
  title: t("AI 工具生态月报", "AI Tools Ecosystem Monthly Report"),
  issueTitle: (monthStr: string) => `📆 AI 工具生态月报 ${monthStr}`,
} as const;

export const ISSUE_LABELS = {
  cli: t("digest", "digest-en"),
  openclaw: t("openclaw", "openclaw-en"),
  web: t("web", "web-en"),
  trending: t("trending", "trending-en"),
  hn: t("hn", "hn-en"),
  ph: t("ph", "ph-en"),
  arxiv: t("arxiv", "arxiv-en"),
  hf: t("hf", "hf-en"),
  community: t("community", "community-en"),
} as const;

export const CLI_ISSUE_TITLE = (dateStr: string, lang: Lang) =>
  lang === "en" ? `📊 AI CLI Tools Digest ${dateStr}` : `📊 AI CLI 工具社区动态日报 ${dateStr}`;

export const OPENCLAW_ISSUE_TITLE = (dateStr: string, lang: Lang) =>
  lang === "en" ? `🦞 OpenClaw Ecosystem Digest ${dateStr}` : `🦞 OpenClaw 生态日报 ${dateStr}`;

// ---------------------------------------------------------------------------
// Footer (used in report.ts)
// ---------------------------------------------------------------------------

export const FOOTER = {
  autoGen: t("本日报由", "This digest is auto-generated by"),
} as const;

// ---------------------------------------------------------------------------
// Telegram notification labels (used in notify.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Report labels for manifest/RSS (used in generate-manifest.ts)
// ---------------------------------------------------------------------------

export const REPORT_LABELS: Record<string, string> = {
  "ai-cli": "AI CLI 工具社区动态日报",
  "ai-cli-en": "AI CLI Tools Digest",
  "ai-agents": "AI Agents 生态日报",
  "ai-agents-en": "AI Agents Ecosystem Digest",
  "ai-web": "AI 官方内容追踪报告",
  "ai-web-en": "Official AI Content Report",
  "ai-trending": "AI 开源趋势日报",
  "ai-trending-en": "AI Open Source Trends",
  "ai-hn": "Hacker News AI 社区动态日报",
  "ai-hn-en": "Hacker News AI Community Digest",
  "ai-ph": "Product Hunt AI 产品日报",
  "ai-ph-en": "Product Hunt AI Products Digest",
  "ai-arxiv": "ArXiv AI 研究日报",
  "ai-arxiv-en": "ArXiv AI Research Digest",
  "ai-hf": "Hugging Face 热门模型日报",
  "ai-hf-en": "Hugging Face Trending Models Digest",
  "ai-community": "技术社区 AI 动态日报",
  "ai-community-en": "Tech Community AI Digest",
  "ai-weekly": "AI 工具生态周报",
  "ai-weekly-en": "AI Tools Weekly Digest",
  "ai-monthly": "AI 工具生态月报",
  "ai-monthly-en": "AI Tools Monthly Digest",
};

export const NOTIFY_LABELS: Record<string, Record<Lang, string>> = {
  "ai-cli": t("AI CLI 工具", "AI CLI Tools"),
  "ai-agents": t("AI Agents 生态", "AI Agents Ecosystem"),
  "ai-web": t("官网动态", "Official Updates"),
  "ai-trending": t("GitHub 趋势", "GitHub Trends"),
  "ai-hn": t("HN 社区动态", "HN Community"),
  "ai-ph": t("Product Hunt", "Product Hunt"),
  "ai-arxiv": t("ArXiv 研究", "ArXiv Research"),
  "ai-hf": t("HF 模型", "HF Models"),
  "ai-community": t("技术社区", "Tech Community"),
  "ai-weekly": t("AI 工具生态周报", "AI Tools Weekly"),
  "ai-monthly": t("AI 工具生态月报", "AI Tools Monthly"),
};

// ---------------------------------------------------------------------------
// PaperHub summary UI
// ---------------------------------------------------------------------------

export const SUMMARY_UI = {
  switchLabel: t("摘要语言", "Summary language"),
  chinese: t("中文", "Chinese"),
  english: t("英文", "English"),
  summaryTab: t("总结", "Summary"),
  abstractTab: t("原始摘要", "Original abstract"),
  summaryHeading: t("中文总结", "English summary"),
  generating: t("正在生成中文总结…", "Generating English summary…"),
  generationFailed: t("中文总结生成失败。", "English summary generation failed."),
  retry: t("重试", "Retry"),
} as const;

export const LLM_CONNECTION_UI = {
  kicker: t("AI 配置", "AI settings"),
  title: t("LLM 连接管理", "LLM connection manager"),
  description: t(
    "保存多个厂商或自定义 API 连接，并选择一个用于摘要、标签和搜索报告。",
    "Save multiple provider or custom API connections and choose one for summaries, tags, and search reports.",
  ),
  connectionList: t("连接列表", "Connections"),
  newConnection: t("新增连接", "New connection"),
  active: t("当前启用", "Active"),
  environmentOverride: t(
    "环境变量正在覆盖本地启用连接；本地切换仍会保存，但需移除环境变量后才会生效。",
    "Environment variables currently override the locally active connection.",
  ),
  connectionName: t("连接名称", "Connection name"),
  providerPreset: t("厂商预设", "Provider preset"),
  apiKey: t("API 密钥", "API key"),
  keepKey: t("已保存密钥；留空可继续使用", "A key is saved; leave blank to keep it"),
  pasteKey: t("由用户自行填入 API 密钥", "Enter an API key"),
  removeKey: t("删除已保存密钥", "Remove saved key"),
  baseUrl: t("API 根地址", "API base URL"),
  insecureHttp: t(
    "该远程地址使用明文 HTTP，API 密钥可能被窃听。",
    "This remote endpoint uses plain HTTP; API credentials may be exposed.",
  ),
  model: t("模型 ID", "Model ID"),
  discoverModels: t("获取模型", "Fetch models"),
  noModelDiscovery: t(
    "该连接未配置模型发现接口，可直接手填模型 ID。",
    "This connection has no model discovery request; enter a model ID manually.",
  ),
  test: t("测试连接", "Test connection"),
  save: t("保存", "Save"),
  saveActivate: t("保存并启用", "Save and activate"),
  activate: t("设为启用", "Activate"),
  duplicate: t("复制连接", "Duplicate"),
  delete: t("删除连接", "Delete"),
  advanced: t("高级协议配置", "Advanced protocol settings"),
  protocol: t("协议", "Protocol"),
  authType: t("鉴权方式", "Authentication"),
  authHeader: t("密钥 Header 名称", "API key header"),
  authQuery: t("密钥 Query 参数", "API key query parameter"),
  requestMethod: t("请求方法", "Request method"),
  requestPath: t("生成请求路径", "Generation path"),
  requestHeaders: t("附加请求头（JSON）", "Additional headers (JSON)"),
  requestBody: t("请求体模板（JSON）", "Request body template (JSON)"),
  responsePath: t("文本响应路径", "Text response path"),
  modelsTemplate: t("模型发现模板（JSON，null 表示关闭）", "Model discovery template (JSON or null)"),
  structuralError: t("请修正高级配置中的 JSON 或必填字段。", "Fix invalid JSON or required fields."),
  testSuccess: t("连接测试成功", "Connection test succeeded"),
  unsaved: t("尚未保存", "Unsaved"),
  lastTest: t("最近测试", "Last test"),
} as const;

export const WEB_SEARCH_CONNECTION_UI = {
  kicker: t("Web 搜索", "Web search"),
  title: t("Web 搜索连接", "Web search connections"),
  description: t(
    "配置 OpenAlex、Tavily、Brave Search 和可选的本地 Search MCP。未配置商业搜索密钥时，arXiv 搜索仍可使用。",
    "Configure OpenAlex, Tavily, Brave Search, and an optional local Search MCP. arXiv remains available without commercial search keys.",
  ),
  name: t("连接名称", "Connection name"),
  baseUrl: t("API 根地址", "API base URL"),
  apiKey: t("API 密钥", "API key"),
  command: t("启动命令", "Executable command"),
  arguments: t("命令参数（每行一个）", "Arguments (one per line)"),
  toolName: t("搜索 Tool 名称", "Search tool name"),
  keepKey: t("已保存密钥；留空继续使用", "A key is saved; leave blank to keep it"),
  save: t("保存连接", "Save connection"),
  activate: t("设为启用", "Activate"),
  test: t("测试连接", "Test connection"),
  removeKey: t("删除已保存密钥", "Remove saved key"),
  active: t("当前启用", "Active"),
  notConfigured: t("尚未配置。", "Not configured."),
} as const;

// ---------------------------------------------------------------------------
// App shell (App.tsx)
// ---------------------------------------------------------------------------

export const APP_UI = {
  navDesk: t("工作台", "Desk"),
  navSearch: t("搜索", "Search"),
  navTags: t("标签", "Tags"),
  navProfile: t("个人", "Profile"),
  brandKicker: t("论文智能工作台", "Paper Intelligence Desk"),
  searchPlaceholder: t("搜索论文、主题、模型", "Search papers, themes, models"),
  searchButton: t("搜索", "Open search"),
  searchAriaLabel: t("全局搜索", "Global search"),
} as const;

// ---------------------------------------------------------------------------
// Home page (HomePage.tsx)
// ---------------------------------------------------------------------------

export const HOME_UI = {
  heroKicker: t("研究前线", "Research Frontline"),
  heroTitle: t(
    "本地智能工作台：论文、实验室与 AI 生态，一站汇聚。",
    "A local intelligence desk for papers, labs, and fast-moving AI ecosystems.",
  ),
  heroDescription: t(
    "PaperHub 将推荐、检索与记忆融合为统一的阅读面板。从热门看板开始，深入档案库，追踪你关心的标签。",
    "PaperHub combines recommendation, retrieval, and memory into a single reading surface. Start with the hot board, move into the archive, then follow the tags that matter.",
  ),
  hotStatLabel: t("热门", "Hot board"),
  hotStatNote: t("每日更新", "Daily rebuild"),
  forYouStatLabel: t("推荐", "For you"),
  forYouStatNote: t("个性化匹配", "Profile matched"),
  latestStatLabel: t("最新", "Latest"),
  latestStatNote: t("最新收录", "Fresh entries"),
  hotKicker: t("今日", "Today"),
  hotTitle: t("热门看板", "Hot board"),
  hotDescription: t(
    "基于时间衰减算法与来源多样性自动生成推荐。",
    "Time-decayed picks with source diversity, rebuilt from the recommendation cache.",
  ),
  hotActionLabel: t("搜索全部", "Search everything"),
  personalKicker: t("个性化", "Personal"),
  personalTitle: t("为你推荐", "For you"),
  personalDescription: t(
    "根据兴趣标签、记忆词条、阅读历史和收藏进行个性化匹配。",
    "Matches drawn from interests, memory terms, reading history, and favorites.",
  ),
  personalActionLabel: t("个人配置", "Open profile"),
  recentKicker: t("最近", "Recent"),
  recentTitle: t("最新收录", "New on the desk"),
  recentDescription: t(
    "最近收录到本地知识库的论文，随时阅读与跟进。",
    "The latest additions from the local corpus, ready for reading and follow-up search.",
  ),
  recentActionLabel: t("浏览标签", "Browse tags"),
  noHotTitle: t("暂无热门推荐", "No hot recommendations yet"),
  noHotDescription: t("请执行内容采集或重建议推荐缓存以填充看板。", "Run collection or rebuild recommendations to populate the board."),
  noPersonalTitle: t("个人资料信号不足", "Profile needs more signal"),
  noPersonalDescription: t("添加兴趣标签或重建用户记忆以解锁个性化推荐。", "Add interest tags or rebuild user memory to unlock personalized picks."),
} as const;

// ---------------------------------------------------------------------------
// Search page (SearchPage.tsx)
// ---------------------------------------------------------------------------

export const SEARCH_UI = {
  webSearchTab: t("Web 搜索", "Web Search"),
  localSearchTab: t("本地知识库", "Local Library"),
  webSearchKicker: t("在线发现", "Live discovery"),
  webSearchTitle: t("Web 搜索", "Web Search"),
  webSearchDescription: t(
    "发现尚未保存到本地知识库的论文。Web 搜索结果在显式保存前为临时状态。",
    "Discover papers that have not been saved to your local library. Web results remain temporary until you explicitly save them.",
  ),
  webQueryLabel: t("搜索词", "Web query"),
  scopeLabel: t("范围", "Scope"),
  scopeAcademic: t("学术", "Academic"),
  scopeTechnical: t("技术", "Technical"),
  scopeMixed: t("混合", "Mixed"),
  publishedAfter: t("发布时间不早于", "Published after"),
  publishedBefore: t("发布时间不晚于", "Published before"),
  includeDomains: t("包含域名", "Include domains"),
  excludeDomains: t("排除域名", "Exclude domains"),
  searchBudget: t("搜索预算", "Search budget"),
  budgetLowCost: t("低成本", "Low cost"),
  budgetBalanced: t("平衡", "Balanced"),
  budgetBroad: t("广泛（并行搜索）", "Broad (parallel Web providers)"),
  maxResults: t("结果数量", "Number of results"),
  autoSummarize: t("生成带有引用的综述", "Generate an evidence-based overview with citations"),
  includeMcp: t("包含已配置的 Search MCP", "Include configured Search MCP provider"),
  searchButton: t("搜索网络", "Search the Web"),
  searching: t("正在启动搜索…", "Starting search…"),
  searchError: t("无法启动 Web 搜索。", "Web Search could not be started."),
  webResultsKicker: t("Web 结果", "Web results"),
  webResultsTitle: t("新发现", "New discoveries"),
  noSessionTitle: t("暂无 Web 搜索会话", "No Web Search session"),
  noSessionDescription: t("无需商业搜索密钥即可使用 arXiv 搜索。", "arXiv search works without a commercial Web Search key."),
  searchFailedTitle: t("搜索失败", "Search failed"),
  synthesisKicker: t("综合报告", "Synthesis"),
  synthesisTitle: t("研究报告", "Research report"),
  synthesisDescription: t("从搜索结果生成深度方法论分类综述。", "Generate a deep method-taxonomy review from the search results above."),
  noSynthesis: t("尚未生成综合报告。", "No synthesis has been generated for this session."),
  generateOverview: t("生成引用综述", "Generate cited overview"),
  generatingOverview: t("正在生成综述…", "Generating overview…"),
  reportError: t("报告生成失败。", "Report generation failed."),
  papersInReport: t("报告涉及论文数", "Papers in report"),
  reportInfo: (count: number) => t(`从最多 ${count} 篇论文生成。调整数量以修改。`, `Generated from up to ${count} papers. Edit count to adjust.`),
  reportWaiting: (count: number) => t(`报告可使用最多 ${count} 篇匹配论文作为证据。`, `A report can use up to ${count} matched papers as evidence.`),
  localKicker: t("研究模式", "Research mode"),
  localTitle: t("搜索", "Search"),
  localDescription: t(
    "关键词、语义及混合检索统一入口。使用来源和标签过滤器缩小范围。",
    "Keyword, semantic, and hybrid retrieval all land here. Use source and tag filters to narrow the desk.",
  ),
  queryLabel: t("查询", "Query"),
  modeLabel: t("模式", "Mode"),
  modeHybrid: t("混合", "Hybrid"),
  modeKeyword: t("关键词", "Keyword"),
  modeSemantic: t("语义", "Semantic"),
  allTagsLabel: t("全部标签", "All tags"),
  anyTagsLabel: t("任一标签", "Any tags"),
  excludeTagsLabel: t("排除标签", "Exclude tags"),
  timeRangeLabel: t("发布时间", "Published within"),
  timeAll: t("不限", "Any time"),
  time7d: t("最近 7 天", "Last 7 days"),
  time30d: t("最近 30 天", "Last 30 days"),
  time90d: t("最近 90 天", "Last 90 days"),
  time365d: t("最近一年", "Last 365 days"),
  tagHint: t(
    "全部标签要求同时满足；任一标签至少满足一项；已在全部标签中的标签自动从任一标签中移除。",
    "All tags requires every selected tag. Any tags requires at least one; duplicates already present in All tags are removed automatically.",
  ),
  runSearch: t("执行搜索", "Run search"),
  resultsKicker: t("结果", "Results"),
  resultsTitle: t("结果列表", "Result list"),
  matchedDescription: (candidateCount: number, modeUsed: string) =>
    t(
      `匹配 ${candidateCount} 条候选，使用模式 ${modeUsed}。`,
      `Matched ${candidateCount} candidates with mode ${modeUsed}.`,
    ),
  noSearchTitle: t("尚未搜索", "No search yet"),
  noSearchDescription: t("输入主题、模型或工作流模式开始搜索。", "Start with a topic, model, or workflow pattern."),
  noMatchesTitle: t("未找到匹配", "No matches found"),
  noMatchesDescription: t("尝试扩大查询范围、切换搜索模式或减少过滤条件。", "Try widening the query, changing the mode, or removing some filters."),
  keywordFallbackTitle: t("语义搜索暂时不可用", "Semantic search is temporarily unavailable"),
  keywordFallbackDescription: t("当前由关键词搜索提供结果。", "Results are currently provided by keyword search."),
  queryPlanTitle: t("有效查询计划", "Effective query plan"),
  coverageTitle: t("本地知识库概况", "Local corpus coverage"),
  searchErrorTitle: t("搜索条件需要调整", "Search filters need attention"),
  paginationLabel: t("搜索结果", "Search results"),
  prevPage: t("上一页", "Previous"),
  nextPage: t("下一页", "Next"),
  saveMetadata: t("保存元数据", "Save metadata"),
  saveContent: t("保存内容", "Save content"),
  saveFavorite: t("保存并收藏", "Save & favorite"),
  favorited: t("已收藏", "Favorited"),
  downloadPdf: t("下载 PDF", "Download PDF"),
  pdfDownloaded: t("已下载 PDF", "PDF downloaded"),
  openLocal: t("打开本地记录", "Open local record"),
  saveError: t("Web 结果保存失败。", "Web result could not be saved."),
  evidencePanel: t("证据综合", "Evidence synthesis"),
  evidenceChunks: (count: number) => t(`证据片段 ${count}`, `${count} evidence chunks`),
} as const;

// ---------------------------------------------------------------------------
// Document detail page (DocumentPage.tsx)
// ---------------------------------------------------------------------------

export const DOCUMENT_UI = {
  readingKicker: t("阅读室", "Reading room"),
  noDocumentTitle: t("文档不存在", "Document missing"),
  noDocumentDescription: t("在本地档案中未找到该文档。", "The requested document could not be found in the local archive."),
  saveFavorite: t("收藏", "Save to favorites"),
  removeFavorite: t("取消收藏", "Remove favorite"),
  markRead: t("标记已读", "Mark as read"),
  markedRead: t("已标记已读", "Marked as read"),
  openOriginal: t("查看原文", "Open original source"),
  authorsLabel: t("作者", "Authors"),
  authorsUnknown: t("未知作者", "Unknown authorship"),
  labelsLabel: t("标签", "Labels"),
} as const;

// ---------------------------------------------------------------------------
// Tags page (TagsPage.tsx)
// ---------------------------------------------------------------------------

export const TAGS_UI = {
  kicker: t("分类", "Taxonomy"),
  title: t("标签图谱", "Tag atlas"),
  description: t(
    "按领域、模型、方法、来源、类型或年份浏览知识库。",
    "Explore the archive by domain, model family, source, content type, or year.",
  ),
  catAll: t("全部", "All"),
  catDomain: t("领域", "Domain"),
  catModel: t("模型", "Model"),
  catMethod: t("方法", "Method"),
  catTask: t("任务", "Task"),
  catSource: t("来源", "Source"),
  catType: t("类型", "Type"),
  catYear: t("年份", "Year"),
  focusKicker: t("标签聚焦", "Tag focus"),
  focusDescription: (tag: string) =>
    t(`当前关联标签「${tag}」的文档。`, `Documents currently associated with the tag ${tag}.`),
  sortBy: t("排序", "Sort by"),
  sortNewest: t("最新优先", "Newest first"),
  sortSummaries: t("已总结优先", "Summaries first"),
  noHitsTitle: t("无匹配文档", "No tag hits"),
  noHitsDescription: t("尚未有文档被映射到此标签。", "No documents have been mapped to this tag yet."),
  paginationLabel: t("标签文档", "Tag documents"),
} as const;

// ---------------------------------------------------------------------------
// User center page (UserCenterPage.tsx)
// ---------------------------------------------------------------------------

export const USER_CENTER_UI = {
  // Profile settings
  profileKicker: t("偏好", "Controls"),
  profileTitle: t("个人设置", "Profile settings"),
  profileDescription: t(
    "调整兴趣标签、阅读偏好与推荐数量。",
    "Adjust explicit interests, reading defaults, and the size of the recommendation surface.",
  ),
  interestTagsLabel: t("兴趣标签", "Interest tags"),
  defaultLanguageLabel: t("默认语言", "Default language"),
  languageZh: t("中文", "中文"),
  languageEn: t("英文", "English"),
  summaryLengthLabel: t("总结长度", "Summary length"),
  summaryShort: t("简短", "Short"),
  summaryDetailed: t("详细", "Detailed"),
  dailyRecommendLabel: t("每日推荐数", "Daily recommendation count"),
  savePreferences: t("保存设置", "Save preferences"),
  // Embedding
  embeddingKicker: t("搜索", "Search"),
  embeddingTitle: t("Embedding 连接", "Embedding connection"),
  embeddingDescription: t(
    "配置语义搜索使用的 Embedding 模型。切换模型后需重建向量索引。",
    "Configure the embedding model used for semantic search. Changes take effect immediately; rebuild the vector index if you switch models.",
  ),
  embeddingProviderLabel: t("提供商", "Provider"),
  embeddingOpenAI: t("OpenAI (API)", "OpenAI (API)"),
  embeddingOllama: t("Ollama (本地)", "Ollama (Local)"),
  embeddingModelLabel: t("模型", "Model"),
  embeddingBaseUrlLabel: t("API 根地址", "Base URL"),
  embeddingApiKeyLabel: t("API 密钥", "API key"),
  embeddingKeyStored: t("已保存密钥；留空继续使用", "A key is already configured; leave blank to keep it"),
  embeddingKeyPlaceholder: t("粘贴 Embedding API 密钥", "Paste your embedding API key"),
  embeddingDimensionsLabel: t("检测维度", "Detected dimensions"),
  embeddingNotProbed: t("未探测", "Not probed"),
  embeddingStatusUnsaved: t("保存以启用此 Embedding 配置。", "Save to activate this embedding configuration."),
  embeddingStatusEnv: t("配置由环境变量设定，此处不可覆盖。", "Configuration is set via environment variables and cannot be overridden here."),
  embeddingStatusNoKey: t("已保存 — 但未存储 API 密钥。在保存密钥前语义搜索将失败。", "Saved — but no API key stored. Semantic search will fail until a key is saved."),
  embeddingStatusSaved: t("Embedding 设置已保存。如切换模型请重建向量索引。", "Embedding settings saved. Rebuild the vector index if you changed the model."),
  embeddingStatusDefaultOllama: t("使用内置默认值。保存以应用您的 Ollama 配置。", "Using built-in defaults. Save to apply your Ollama configuration."),
  embeddingStatusDefault: t("使用内置默认值。保存以持久化您的配置。", "Using built-in defaults. Save to persist your configuration."),
  saveEmbedding: t("保存 Embedding 设置", "Save embedding settings"),
  saving: t("保存中…", "Saving..."),
  removeKey: t("删除已保存密钥", "Remove saved key"),
  testConnection: t("测试连接", "Test connection"),
  testing: t("测试中…", "Testing..."),
  rebuildIndex: t("重建向量索引", "Rebuild vector index"),
  starting: t("启动中…", "Starting..."),
  indexStatus: (status: string, ready: number, total: number, pending: number, failed: number) =>
    t(
      `索引 ${status}：${ready}/${total} 就绪，${pending} 待处理，${failed} 失败。`,
      `Index ${status}: ${ready}/${total} ready, ${pending} pending, ${failed} failed.`,
    ),
  // Web search status
  webSearchKicker: t("运维", "Operations"),
  webSearchTitle: t("Web 搜索状态", "Web Search status"),
  webSearchDescription: t(
    "本地 Web 搜索的健康、成本、缓存和可靠性信号（最近 7 天）。",
    "Local-only health, cost, cache, and reliability signals from the last seven days.",
  ),
  healthLabel: t("健康", "Health"),
  enabledProviders: (count: number) => t(`${count} 个已启用提供商`, `${count} enabled providers`),
  searches7d: t("搜索 · 7天", "Searches · 7d"),
  providerFailures: (rate: string) => t(`${rate}% 提供商失败`, `${rate}% provider failures`),
  estimatedCredits: t("预估积分", "Estimated credits"),
  storedLocally: t("本地存储", "stored locally"),
  tempCache: t("临时缓存", "Temporary cache"),
  resultsCache: t("条结果", "results"),
  fetchedPages: t("已抓取页面", "fetched pages"),
  lastCleanup: t("上次清理：", "Last cleanup: "),
  notRecorded: t("未记录", "not recorded"),
  calls: t("调用", "calls"),
  success: t("成功率", "success"),
  // User memory
  memoryKicker: t("记忆", "Memory"),
  memoryTitle: t("用户记忆", "User memory"),
  memoryDescription: t(
    "从近期摘要中提取的长期词条，已加权纳入个人资料。",
    "These are the long-lived terms currently extracted from recent digests and weighted into the profile.",
  ),
  rebuildMemory: t("重建记忆", "Rebuild memory"),
  noMemoryTitle: t("暂无记忆词条", "No memory terms yet"),
  noMemoryDescription: t("首次摘要重建后记忆将出现。", "Memory will appear after the first digest rebuild."),
  weightLabel: (weight: string) => t(`权重 ${weight}`, `weight ${weight}`),
  // Reading history
  historyKicker: t("历史", "History"),
  historyTitle: t("阅读历史", "Reading history"),
  historyDescription: t(
    "近期阅读行为反馈至个人资料构建与已读排除。",
    "Recent reading activity is fed back into profile construction and read exclusion.",
  ),
  noHistoryTitle: t("暂无阅读历史", "No history yet"),
  noHistoryDescription: t("在详情页将论文标记为已读即可记录。", "Mark a document as read from the detail page to register a reading event."),
  // Favorites
  favoritesKicker: t("收藏", "Pinned"),
  favoritesTitle: t("收藏夹", "Favorites"),
  favoritesDescription: t(
    "收藏是固定的研究资料，默认不进入个性化推荐队列。",
    "Favorites are pinned research artifacts and are excluded from the default personalized queue.",
  ),
  noFavoritesTitle: t("暂无收藏", "No favorites yet"),
  noFavoritesDescription: t("在详情页收藏论文即可在此处固定。", "Save a paper from the detail page to pin it here."),
  removeFavorite: t("移除", "Remove"),
} as const;
