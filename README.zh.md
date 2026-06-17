# PaperHub

[English](./README.md) | 中文

PaperHub 是一个本地优先的论文与 AI 官方博客情报桌面应用。它会抓取论文和博客内容，写入本地 SQLite 档案库，生成摘要与标签，并提供搜索、推荐、标签浏览、阅读历史和收藏等能力。

## 当前状态

- 项目现在已经以 `PaperHub` 桌面应用为主，不再是早期的 `agents-radar` 仓库定位
- 第六阶段代码侧审查与修复已完成
- 当前仓库内的核心验证链路已通过：
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm ui:build`
  - `pnpm test:e2e`
- 当前剩余发布工作主要是：在真实 `Windows + Node 20.x` 机器上完成打包与最终人工验收

## 核心能力

- 抓取并标准化论文和博客文档
- 使用本地 SQLite 存储摘要、标签、历史、收藏和用户偏好
- 支持关键词、语义和混合搜索
- 提供热点推荐和个性化推荐
- 提供详情页、标签页、用户中心等主链路页面
- 通过 Electron 作为本地桌面应用运行

## 技术栈

- 后端：Node.js、TypeScript、Express
- 前端：React、Vite、React Query、React Router
- 存储：SQLite、`better-sqlite3`、`sqlite-vec`
- 桌面端：Electron

## 快速开始

### 前置要求

- 推荐使用 Node.js 20.x
- `pnpm`

### 安装依赖

```bash
pnpm install
```

### 本地开发运行 Web 版本

启动本地 API：

```bash
pnpm api:dev
```

启动前端界面：

```bash
pnpm ui:dev
```

### 本地开发运行桌面版

```bash
pnpm desktop:dev
```

### 写入一套固定验证数据

```bash
pnpm phase6:seed
```

这套固定数据主要用于验证：

- 首页推荐
- 搜索
- 详情页动作
- 标签页分页与排序
- 历史与收藏

## 验证命令

执行当前核心校验：

```bash
pnpm typecheck
pnpm test
pnpm ui:build
pnpm test:e2e
```

其中 `pnpm test:e2e` 当前实际执行的是第六阶段 release smoke：

- 先构建 UI
- 再注入固定夹具数据
- 再对真实本地 API 逻辑执行回归测试

## Windows 打包

Windows 打包现在被明确限制在真实 Windows 发布主机上执行。

要求：

- Windows x64
- Node.js 20.x

命令：

```bash
pnpm desktop:build:dir
pnpm desktop:build
```

前者生成 unpacked 目录版本，后者生成 Windows 安装包产物。

## 发布文档

- [第六阶段运行手册](./docs/phase6-runbook.md)
- [第六阶段人工验收清单](./docs/phase6-manual-checklist.md)
- [第六阶段基线记录](./docs/phase6-baseline.md)
- [第六阶段审查报告](./第六阶段审查报告.md)
- [第六阶段 Windows 打包与发布任务清单](./第六阶段Windows打包与发布任务清单.md)
- [第六阶段 Windows 实机执行清单](./第六阶段Windows实机执行清单.md)

## 仓库说明

- 历史 digest 数据仍保留在 `digests/` 下
- 部分内部集成和历史模块仍保留早期 `agents-radar` 命名
- 当前仓库已经独立迁移到 `PaperHub` 项目名下，后续可继续逐步清理内部遗留命名
