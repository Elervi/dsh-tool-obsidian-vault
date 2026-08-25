# dsh-tool-obsidian-vault

> 给 DSH（DeepSeek Harness）的 Obsidian 库工具插件：20 个 `vault_*` 工具，让 Agent
> 直接搜索、读写本地 Obsidian 笔记，支持反向链接、frontmatter 与安全重命名。
> 附带一个 **Obsidian 模式** agent preset——一条命令装完即用，无需构建、无需改路径。
> 与 Obsidian 插件 [obsidian-dsh-dock](https://github.com/Elervi/obsidian-dsh-dock)
> **珠联璧合**：它让 DSH 住进 Obsidian，本工具让 Agent 认识 Obsidian。

## ✨ 特性

- 📦 **一条命令安装** — `dsh plugin --profile web add -w github:Elervi/dsh-tool-obsidian-vault`，重启即装好（bundle 装进 profile，重启时把内置 preset 自安装为 Obsidian 模式）
- 🗂️ **多库自动发现** — 读 Obsidian 全局注册表，自动解析当前库；dsh-dock per-vault 注入（`DSH_OBSIDIAN_VAULT_PATH`）优先于一切猜测
- 🔌 **Obsidian API 桥（B1）** — dsh-dock 开着时工具**桥优先**：frontmatter / 出链 / 反向链接 / 标签 / 重命名引用更新全部换成 Obsidian 官方解析（metadataCache / fileManager），写后 UI 与索引即时刷新；桥不可用自动回退文件直读（`ctx.fs`），CLI 直跑不退化
- 🔍 **20 个 vault 工具** — 搜索 / 读写 / 反链 / frontmatter / 安全重命名 / 回收站删除 / 打开笔记 / 全库标签 / 生成链接
- 🔒 **安全默认** — 库外路径、符号链接越界、未注册绝对路径默认一律拒绝

## 🚀 快速安装

前置：已安装 DSH（`npm i -g @deepseek-ai/dsh`）并启动过一次界面。

**推荐：一条命令（v0.6.0+）**

```sh
dsh plugin --profile web add -w github:Elervi/dsh-tool-obsidian-vault
```

（`-w`：profile 目录带 `pnpm-workspace.yaml`，pnpm 会要求显式声明添加到
workspace 根；若你的 pnpm 已配置 `ignore-workspace-root-check`，可省略。）

包作为 profile bundle 装入后，重启 `dsh web` 时会把内置的
[`presets/obsidian/`](presets/obsidian/README.md) 自安装为 agent preset
（落点 `~/.dsh/.agent-presets/obsidian/`，幂等：已存在则跳过，绝不覆盖你的修改）：

1. 重启 DSH，新建会话
2. 预设选择器里选 **Obsidian 模式**
3. 会话里出现 `vault_list_vaults` / `vault_search` 等 `vault_*` 工具即成功 ✅

**更新**：`dsh plugin --profile web update dsh-tool-obsidian-vault`（只更新包；
预设副本会在下次启动时按 `presetMode`（默认 `merge`）**自动同步到新版快照**：
你改过的文件保留、没动过的文件更新、插件新增/移除的文件跟随，见 `src/install.ts`。
若你的旧预设由旧版插件或手工放下、无基线清单会先按“保留”落地清单，想彻底跟上
新版可删除 `~/.dsh/.agent-presets/obsidian` 后重启一次，或按
[`presets/obsidian/README.md`](presets/obsidian/README.md) 手动覆盖）。
**卸载**：`dsh plugin --profile web remove dsh-tool-obsidian-vault`（可再删
`~/.dsh/.agent-presets/obsidian`）。
## 🤝 与 obsidian-dsh-dock 珠联璧合

[obsidian-dsh-dock](https://github.com/Elervi/obsidian-dsh-dock) 已上架
[Obsidian 插件市场](https://obsidian.md/plugins?id=dsh-dock)（搜索 **DSH Dock** 一键安装），
把官方 DSH Web UI 嵌成 Obsidian 侧边栏面板，per-vault 模式（默认）注入
`DSH_OBSIDIAN_VAULT_PATH` 并设会话 cwd 为库根。两者一个管「门」、一个管「钥匙」：
dock 让 DSH 住进 Obsidian，本工具让 Agent 认识 Obsidian——合起来即开箱即用的
「Obsidian 内 Agent 笔记工作流」。

**三步启用**：① 市场安装并启用 **DSH Dock** → ② 按上文装好本工具的 **Obsidian 模式**
preset → ③ 面板新建会话选「Obsidian 模式」，说「读一下今天的笔记」「把这段整理进
[[xxx]]」，Agent 自动读写当前库，无需任何路径配置。

> 仅 dock 的 **per-vault** 模式注入 `DSH_OBSIDIAN_VAULT_PATH`；shared 模式本工具退回
> 「最近活跃打开库 / 工作目录」解析。

**Obsidian API 桥（v0.5.0）**：dock 插件加载即在本机 127.0.0.1 起一个 token 鉴权的
HTTP 桥（`DSH_OBSIDIAN_BRIDGE_URL/TOKEN` 经 env 与 `~/.dsh/current-vault.json` 标记
文件双通道暴露）。工具侧**桥优先、文件回退**：

- 桥模式下 frontmatter / 出链 / 嵌入 / 标签 / 别名 / 反向链接 / 未解析链接 / 全库标签
  全部来自 `metadataCache` 官方解析（不再用正则近似）；`vault_update_frontmatter` 走
  `fileManager.processFrontMatter`（原子、YAML 官方序列化）；`vault_rename_note` 走
  `fileManager.renameFile`（按用户「自动更新内部链接」设置更新 wikilink/markdown/
  frontmatter 引用）；`vault_delete_note` 走 `fileManager.trashFile`（回收站语义，
  可恢复）；`vault_open_note` 走 `workspace.openLinkText`；`vault_note_link` 走
  `fileManager.generateMarkdownLink`（遵循用户链接设置）；写入后 Obsidian 立即刷新
  UI 与索引。
- 桥不可用（没装/没开 dock、Obsidian 未运行、桥服务的不是目标库）时逐调用回退
  `ctx.fs` 文件直读，行为与旧版完全一致 —— 命令行 `dsh web` 直跑不退化。
  其中 `vault_all_tags` / `vault_note_link` 有文件回退实现；`vault_delete_note` /
  `vault_open_note` 依赖 Obsidian UI/回收站语义，无桥时明确报错（提示用 bash rm）。
- 关闭桥：dock 设置里关「启用 API 桥」，或本工具配置 `bridge: false`。

## 🧰 工具一览

| 工具 | 作用 |
| --- | --- |
| `vault_list_vaults` / `vault_current` | 列出全部库 / 当前库及判定依据 |
| `vault_list_notes` / `vault_list_folders` | 列笔记 / 列文件夹结构 |
| `vault_search` / `vault_search_tags` / `vault_all_tags` | 全文检索 / 标签检索 / 全库标签聚合 |
| `vault_read_note` / `vault_note_info` | 读笔记（按行切片）/ 单篇元信息 |
| `vault_create_note` / `vault_edit_note` / `vault_append_note` | 新建 / 精准编辑 / 追加 |
| `vault_frontmatter` / `vault_update_frontmatter` | 读 / 改 Properties |
| `vault_backlinks` / `vault_note_links` / `vault_note_link` | 反向链接 / 出链 / 生成标准链接文本 |
| `vault_rename_note` | 安全重命名（自动更新全库引用，失败自动回滚） |
| `vault_delete_note` / `vault_open_note` | 回收站删除（可恢复）/ 在 Obsidian 中打开笔记 |

**当前库解析顺序**：`vault` 参数 → 配置 `vaultRoot` → dsh-dock 注入的本库
（`DSH_OBSIDIAN_VAULT_PATH`，per-vault 模式下优先于工作目录巧合）→
会话工作目录（若为库）→ 最近活跃打开库 → 会话工作目录 / `process.cwd()`。

**安全默认**：`allowArbitraryRoots` / `allowSymlinkEscape` 默认关闭；
笔记路径强制为库内相对路径（拒绝 `/`、盘符、`..` 穿越）。

## 🔢 错误码（稳定契约）

所有 `vault_*` 工具的失败都抛 `VaultError`（`src/errors.ts`），带两条通道：

- **模型通道（`message`）**：模型只看到 `Error: <message>`，消息始终包含中文描述
  与恢复指令（如「请先 vault_read_note 重新读取，再重试」）——模型照此行动，不解析任何码。
- **程序通道（`code`）**：`VaultError extends HarnessError`，宿主工具注册表会把
  `{ name: 'VaultError', code }` 放进 `ToolFailure.info`（`tool/result` 事件），
  策略 / 重试 / 诊断按 code 路由，**绝不解析 message**。

**词表**（`VaultCode`，`VAULT_*` 前缀，发布后语义不变则码不变）：

| code | 含义 |
| --- | --- |
| `VAULT_UNKNOWN_VAULT` / `VAULT_ROOT_UNREGISTERED` | 库名未发现 / 未注册绝对路径且 `allowArbitraryRoots` 关闭 |
| `VAULT_PATH_INVALID` / `VAULT_PATH_ESCAPE` | 笔记路径非法 / 越出库（含符号链接越界） |
| `VAULT_INVALID_ARGS` | 参数校验失败（query/tag/old_string/content/title 为空等） |
| `VAULT_NOTE_NOT_FOUND` / `VAULT_NOT_FILE` / `VAULT_EXISTS` | 笔记不存在 / 不是文件 / 目标已存在 |
| `VAULT_FRONTMATTER_UNCLOSED` / `_MULTILINE` / `_NO_FIELDS` | 围栏未闭合 / 值含换行 / 无 frontmatter 却只传 delete |
| `VAULT_REGEX_INVALID` | 正则无效 |
| `VAULT_RENAME_UPDATE_FAILED` / `_ROLLBACK_FAILED` / `_STUB_FAILED` | 重命名改引用失败 / 回滚残留 / 写跳转占位失败 |
| `VAULT_TRASH_UNAVAILABLE` / `VAULT_OPEN_UNAVAILABLE` | 回收站删除 / 打开笔记需要 dsh-dock 桥（文件模式无此能力） |

**fs 语义失败复用宿主 `FsErrorCode`**（`FS_STALE_VERSION` / `FS_NOT_OBSERVED` /
`FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND` / `FS_IO_ERROR` …），不重复造码。
## 📜 更新记录

| 日期 | 更新 |
| --- | --- |
| 2026-08-23 | **消除双包危害（v0.6.1）**：preset 改用**裸包名**挂载插件（`name: 'dsh-tool-obsidian-vault'`），移除 `presets/obsidian/vendor/` 自包含拷贝——插件与宿主共用同一份 `@deepseek-ai/*` 模块实例，`VaultError` 的 `instanceof HarnessError` 成立，`ToolFailure.info` 结构化错误码恢复；依赖声明对齐（运行时依赖全部为 peer：cordis/dsh-tools/dsh-llm/schemastery；devDependencies 升到 0.1.1-rc.2 与 peer 一致，`npm install` 不再 ERESOLVE）；重建发布物（tarball + preset zip） |
| 2026-08-21 | **一条命令安装（v0.6.0）**：包声明 `dsh.bundle` 成为 profile bundle，`dsh plugin --profile web add -w github:Elervi/dsh-tool-obsidian-vault` 装完重启即自动把 `presets/obsidian/` 自安装为 agent preset（`~/.dsh/.agent-presets/obsidian`，幂等不覆盖）；新增 `installPreset`/`registerTools` 配置与安装器（`src/install.ts`，`$DSH_HOME` 优先、`~/.dsh` 兜底）；`preset/` 更名为 `presets/obsidian/`（目录名即预设 id） |
| 2026-08-21 | **API 全覆盖（v0.5.0 扩展）**：补齐 4 个工具使核心 Obsidian API 全覆盖——`vault_delete_note`（`fileManager.trashFile` 回收站语义，旧版降级 `vault.trash`）、`vault_open_note`（`workspace.openLinkText`）、`vault_all_tags`（`metadataCache.getAllTags` 全库标签聚合）、`vault_note_link`（`fileManager.generateMarkdownLink` 按用户链接设置）；错误码新增 `VAULT_TRASH_UNAVAILABLE`/`VAULT_OPEN_UNAVAILABLE`；桥端点 `/v1/{trash,open,all-tags,link}`；冒烟与 vendor 同步；工具总数 16 → 20 |
| 2026-08-21 | **Obsidian API 桥（B1，v0.5.0）**：dsh-dock 起 127.0.0.1 token 鉴权 HTTP 桥，工具侧「桥优先、文件回退」——frontmatter/出链/嵌入/标签/别名/反向链接/未解析链接换用 metadataCache 官方解析，frontmatter 修改走 fileManager.processFrontMatter，重命名走 fileManager.renameFile（按用户「自动更新内部链接」设置）；桥经 `DSH_OBSIDIAN_BRIDGE_URL/TOKEN` env + `~/.dsh/current-vault.json` 标记文件双通道发现（per-vault env 权威、shared 多窗口按标记文件匹配）；配置 `bridge: false` 可强制文件模式；新增 `src/bridge.ts` 客户端与 `scripts/smoke.mjs` 假桥集成冒烟；vendor 同步 |
| 2026-08-19 | README 精简「与 obsidian-dsh-dock 珠联璧合」章节：dock 已上架 Obsidian 插件市场，三步启用改为市场一键安装（旧手动目录名 `obsidian-dsh-dock/` 有误，已随市场安装一并消除）；移除冗余对照表与失效的「双向印证」引用 |
| 2026-08-19 | 结构化错误码：全部失败改抛 `VaultError`（`VAULT_*` 词表 + 复用宿主 `FS_*`），宿主可路由 `ToolFailure.info`；regression 增加错误码断言；`preset/vendor` 依赖链整体对齐宿主 rc.6（此前 peer 漂到 rc.7）；版本升至 0.4.0 |
| 2026-08-19 | README 新增「与 obsidian-dsh-dock 珠联璧合」章节（配合机制 / 三步启用）；修正当前库解析顺序为「注入优先于工作目录」——README 与系统提示词（`src/prompt.ts`，已重新构建并同步 `preset/vendor`）全部对齐 `tools.ts` 实现；FAQ 补充 dock 排障 |
| 2026-08-19 | 自包含 preset 开箱即用（`preset/`，vendor 内置构建产物与依赖）；`lib/` 入库；移除 dsh-dock 焦点标记，per-vault 以 `DSH_OBSIDIAN_VAULT_PATH` 注入为准 |
| 2026-08-17 | `vault_current`；rename 事务回滚；frontmatter `aliases` 解析；markdown 尖括号路径；广度优先限并发遍历 |
