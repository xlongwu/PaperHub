# 第六阶段 Windows 实机执行清单

> 读者：负责 Windows 首版发布验证的工程师  
> 目标：拿到一台 `Windows + Node 20.x` 机器后，按顺序完成安装前门禁、打包、启动验证、人工验收和结果记录。

---

## 使用方式

- [ ] 全程使用 PowerShell 执行命令
- [ ] 从仓库根目录执行以下命令
- [ ] 每完成一项就手动打勾
- [ ] 任一步失败，先记录报错，再继续处理，不要跳过

建议先开启执行日志：

```powershell
Start-Transcript -Path .\phase6-windows-verify.log -Force
```

完成后再关闭：

```powershell
Stop-Transcript
```

---

## 1. 环境前提检查

- [ ] 确认当前机器是 Windows 10/11 x64
- [ ] 确认已安装 Node.js 20.x

```powershell
node -v
node -p "process.platform + ' ' + process.arch"
```

预期：

- `node -v` 输出为 `v20.x.x`
- 平台输出包含 `win32 x64`

- [ ] 确认已启用 Corepack

```powershell
corepack enable
```

- [ ] 确认 pnpm 可用

```powershell
pnpm -v
```

- [ ] 如需原生模块编译，确认 Python 可用

```powershell
python --version
```

说明：

- 如果后续 `install-app-deps` 或原生模块步骤失败，优先检查 Python 和 Windows C++ Build Tools 是否齐全。

---

## 2. 进入项目并安装依赖

- [ ] 进入项目目录

```powershell
cd <你的 PaperHub 仓库目录>
```

- [ ] 确认当前目录正确

```powershell
Get-ChildItem package.json
```

- [ ] 安装依赖

```powershell
pnpm install --frozen-lockfile
```

---

## 3. 发布前基础门禁

- [ ] 类型检查

```powershell
pnpm typecheck
```

- [ ] 测试

```powershell
pnpm test
```

- [ ] 前端构建

```powershell
pnpm ui:build
```

- [ ] 第六阶段 release smoke

```powershell
pnpm test:e2e
```

- [ ] 如需一次性复核核心门禁，可额外执行

```powershell
pnpm release:verify
```

通过标准：

- 上述命令全部退出码为 `0`
- 不允许带着失败用例进入打包步骤

---

## 4. Windows 打包前核对

- [ ] 确认 Node 版本仍为 20.x

```powershell
node -v
```

- [ ] 确认当前环境确实是 Windows

```powershell
node -p "process.platform"
```

- [ ] 记录当前版本号

```powershell
node -p "require('./package.json').version"
```

说明：

- `desktop:build:dir` 和 `desktop:build` 在非 Windows 或非 Node 20.x 下会直接失败，这是预期保护。

---

## 5. 生成 unpacked 目录构建

- [ ] 生成 Windows unpacked 目录

```powershell
pnpm desktop:build:dir
```

- [ ] 检查 `dist-desktop` 产物

```powershell
Get-ChildItem .\dist-desktop
Get-ChildItem .\dist-desktop\win-unpacked
```

- [ ] 启动 unpacked 版本

```powershell
Start-Process .\dist-desktop\win-unpacked\PaperHub.exe
```

- [ ] 确认 unpacked 版本能启动成功
- [ ] 确认没有白屏
- [ ] 确认首页能正常打开

---

## 6. 生成正式安装包

- [ ] 生成 Windows 安装包

```powershell
pnpm desktop:build
```

- [ ] 检查安装包产物

```powershell
Get-ChildItem .\dist-desktop\*.exe
```

- [ ] 记录生成的安装包文件名
- [ ] 确认同时存在可安装包或便携版产物

---

## 7. 安装包实机验证

- [ ] 运行安装包
- [ ] 完成安装流程
- [ ] 从开始菜单或桌面快捷方式启动应用
- [ ] 首次启动无白屏、无卡死、无静默退出
- [ ] 关闭后再次启动一次
- [ ] 卸载流程可正常打开

如需直接启动安装后的应用，请记录实际安装路径后执行：

```powershell
Start-Process "<安装后的 PaperHub.exe 路径>"
```

---

## 8. 五个核心页面人工验收

### 8.1 首页

- [ ] 热点推荐可见
- [ ] 个性化推荐可见
- [ ] 最新文档可见
- [ ] 顶部导航可正常跳转

### 8.2 搜索页

- [ ] 输入关键词后能返回结果
- [ ] Search mode 切换生效
- [ ] 来源筛选生效
- [ ] 标签筛选生效
- [ ] 时间范围筛选生效
- [ ] 分页前进和返回生效
- [ ] Memo 面板能正常显示或正常空态降级

### 8.3 详情页

- [ ] 可从首页或搜索结果打开详情页
- [ ] 标题、作者、标签、摘要、Abstract 均可见
- [ ] `Save to favorites` 生效
- [ ] `Mark as read` 生效
- [ ] `Open original source` 可拉起系统浏览器

### 8.4 标签页

- [ ] Tag atlas 正常显示
- [ ] 分类切换可用
- [ ] 标签详情页可打开
- [ ] 排序切换可用
- [ ] 分页切换可用

### 8.5 用户中心

- [ ] Interest tags 可编辑并保存
- [ ] 重启后偏好仍保留
- [ ] User memory 正常显示
- [ ] `Rebuild memory` 可执行
- [ ] Reading history 能看到刚才标记已读的文档
- [ ] Favorites 能看到刚才收藏的文档
- [ ] 移除收藏后列表能更新

---

## 9. 原生依赖重点确认

- [ ] 应用启动过程中没有 `better-sqlite3` 加载失败
- [ ] 应用启动过程中没有 `sqlite-vec` 加载失败
- [ ] 搜索、推荐、标签相关页面可正常工作

如需快速复核依赖是否被打入产物目录，可执行：

```powershell
Get-ChildItem .\dist-desktop -Recurse | Select-String "better-sqlite3"
Get-ChildItem .\dist-desktop -Recurse | Select-String "sqlite-vec"
```

---

## 10. 结果回写

- [ ] 记录本次验证机器信息

```powershell
systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type"
node -v
pnpm -v
```

- [ ] 记录本次通过的命令
- [ ] 记录本次生成的安装包文件名
- [ ] 记录 blocker / non-blocker 问题
- [ ] 把结果同步回第六阶段审查报告
- [ ] 把完成项同步回第六阶段 Windows 打包与发布任务清单

建议回写最少包含：

- 验证日期
- Windows 版本
- Node 版本
- 是否通过 `typecheck / test / ui:build / test:e2e`
- 是否通过 `desktop:build:dir / desktop:build`
- 是否完成人工验收
- 是否存在 blocker

---

## 11. 失败时的最小排查顺序

- [ ] 如果 `pnpm install` 失败，先排查 Node / pnpm / 网络
- [ ] 如果 `pnpm test:e2e` 失败，先看 release smoke 报错是不是数据、断言或环境变量问题
- [ ] 如果 `pnpm desktop:build:dir` 失败，先看是不是 Node 版本不对
- [ ] 如果安装包启动失败，优先排查本地 API 拉起、原生依赖和用户目录写权限
- [ ] 如果只有 GUI 某一页异常，但自动化门禁通过，先记录为人工验收问题再定级

---

## 12. 通过标准

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] `pnpm ui:build` 通过
- [ ] `pnpm test:e2e` 通过
- [ ] `pnpm desktop:build:dir` 通过
- [ ] `pnpm desktop:build` 通过
- [ ] 安装包人工验收通过
- [ ] 无 blocker 问题残留

当以上全部打勾后，才可以把 Windows 首版候选标记为“可发布”。
