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
