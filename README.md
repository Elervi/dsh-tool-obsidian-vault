# dsh-tool-obsidian-vault

> 给 DSH（DeepSeek Harness）的 Obsidian 库工具插件：16 个 `vault_*` 工具，让 Agent
> 直接搜索、读写本地 Obsidian 笔记，支持反向链接、frontmatter 与安全重命名。
> 附带一个**开箱即用**的 agent preset——复制目录即安装，无需构建、无需改路径。
> 与 Obsidian 插件 [obsidian-dsh-dock](https://github.com/Elervi/obsidian-dsh-dock)
> **珠联璧合**：它让 DSH 住进 Obsidian，本工具让 Agent 认识 Obsidian。

## ✨ 特性

- 📦 **开箱即用** — 自带自包含 preset（构建产物 + 运行时依赖已打包），无 npm / 构建 / 路径配置
- 🗂️ **多库自动发现** — 读 Obsidian 全局注册表，自动解析当前库；dsh-dock per-vault 注入（`DSH_OBSIDIAN_VAULT_PATH`）优先于一切猜测
- 🔍 **16 个 vault 工具** — 搜索 / 读写 / 反链 / frontmatter / 安全重命名
- 🔒 **安全默认** — 库外路径、符号链接越界、未注册绝对路径默认一律拒绝

## 🚀 快速安装

前置：已安装 DSH（`npm i -g @deepseek-ai/dsh`）并启动过一次界面。

```sh
git clone git@github.com:Elervi/dsh-tool-obsidian-vault.git
mkdir -p ~/.dsh/.agent-presets
cp -R dsh-tool-obsidian-vault/preset ~/.dsh/.agent-presets/obsidian
```

1. 重启 DSH，新建会话
2. 预设选择器里选 **Obsidian 模式**
3. 会话里出现 `vault_list_vaults` / `vault_search` 等 `vault_*` 工具即成功 ✅

> 目录名即预设 id（可改成 `obsidian-lite` 等任意小写字母/数字/连字符）。
> 工具只挂载到该预设（agent 平面），不污染其它模式。
> 自定义与升级：见 [`preset/README.md`](preset/README.md)。

## 🤝 与 obsidian-dsh-dock 珠联璧合

[obsidian-dsh-dock](https://github.com/Elervi/obsidian-dsh-dock) 是 Obsidian 侧的小插件：
在 Obsidian 桌面端内 spawn 官方 `dsh web`，把 DSH Web UI 嵌成侧边栏面板，并提供
per-vault 隔离。本工具跑在 **DSH 侧**。两者一个管"门"、一个管"钥匙"，合起来就是
开箱即用的「Obsidian 内 Agent 笔记工作流」：

| 环节 | obsidian-dsh-dock（Obsidian 侧） | 本工具如何受益（DSH 侧） |
| --- | --- | --- |
| 启动 DSH | 点一下机器人图标，面板里就是官方 DSH Web UI | 无需自己开终端跑 `dsh web` |
| 定位当前库 | per-vault 模式注入 `DSH_OBSIDIAN_VAULT_PATH` | 「注入的本库」在解析顺序里优先于工作目录巧合，多库同开不串 |
| 会话工作目录 | spawn `cwd = vaultRoot` | 会话 cwd 即库根，`vault_current` 判定依据清晰 |
| 多库并行 | 端口按库 hash 偏移互不冲突 | 每个库的 DSH 面板共享同一份 preset，工具一次装好全库可用 |
| 配置共享 | `cordis.patch.yml` 把模型/密钥/主题指回 `~/.dsh` | 配一次全库生效，只有会话/历史按库隔离 |

**三步启用即珠联璧合**：

1. Obsidian 里装好并启用 **DSH Dock**（`main.js` + `manifest.json` + `styles.css`
   复制到 `.obsidian/plugins/obsidian-dsh-dock/`）；
2. 按上文装好本工具的 **Obsidian 模式** preset；
3. 点 dock 的机器人图标打开面板 → 新建会话选「Obsidian 模式」→ 直接说
   "读一下今天的笔记"、"把这段整理进 [[xxx]]"，Agent 会自动定位当前库读写，
   无需任何路径配置。

> 配套说明：只有 dock 的 DSH_HOME 模式为 **per-vault** 时才注入
> `DSH_OBSIDIAN_VAULT_PATH`；shared 模式下本工具退回「最近活跃打开库 / 工作目录」解析。
> 双向印证见 obsidian-dsh-dock 的 README「与 dsh-tool-obsidian-vault 联动」一节。

## 🧰 工具一览

| 工具 | 作用 |
| --- | --- |
| `vault_list_vaults` / `vault_current` | 列出全部库 / 当前库及判定依据 |
| `vault_list_notes` / `vault_list_folders` | 列笔记 / 列文件夹结构 |
| `vault_search` / `vault_search_tags` | 全文检索 / 标签检索 |
| `vault_read_note` / `vault_note_info` | 读笔记（按行切片）/ 单篇元信息 |
| `vault_create_note` / `vault_edit_note` / `vault_append_note` | 新建 / 精准编辑 / 追加 |
| `vault_frontmatter` / `vault_update_frontmatter` | 读 / 改 Properties |
| `vault_backlinks` / `vault_note_links` | 反向链接 / 出链 |
| `vault_rename_note` | 安全重命名（自动更新全库引用，失败自动回滚） |

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

**fs 语义失败复用宿主 `FsErrorCode`**（`FS_STALE_VERSION` / `FS_NOT_OBSERVED` /
`FS_AMBIGUOUS_EDIT` / `FS_EDIT_NOT_FOUND` / `FS_IO_ERROR` …），不重复造码。

> ⚠️ **部署差异**：`ToolFailure.info` 的提取依赖「工具的 `@deepseek-ai/dsh-llm` 与宿主
> 是同一模块实例」。仓库开发环境（node_modules 软链到宿主）成立；`preset/` 自包含拷贝
> 是独立实例，`info` 不会出现——但模型可见的 `message`（含恢复指令）两条路径完全一致，
> 无功能回退。

## 🔧 开发者 / 深度定制

```sh
git clone git@github.com:Elervi/dsh-tool-obsidian-vault.git
cd dsh-tool-obsidian-vault
npm install        # 依赖说明见下
npm run build      # tsc → lib/
```

在 preset 的 `agent.cordis.yml` 里挂载：

```yaml
- id: tool-obsidian-vault
  name: '/绝对/路径/dsh-tool-obsidian-vault/lib/index.js'
  config:
    maxResults: 20
    ignoreDirs: ['.obsidian', '.git', '.claudian', '.trash']
```

> ⚠️ **依赖有坑**：运行时依赖是 rc 版（`@deepseek-ai/dsh-tools@0.1.0-rc.6`），
> peer 版本互相钳制，直接 `npm install` 会 ERESOLVE 失败。推荐从 DSH 安装目录
> 软链同版本副本（`typescript` 正常安装）：
>
> ```sh
> DSH_PREFIX="$(npm root -g)/@deepseek-ai/dsh"
> for p in dsh-tools cordis dsh-fs dsh-system-prompt dsh-llm; do
>   ln -sfn "$DSH_PREFIX/node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
> done
> ln -sfn "$DSH_PREFIX/node_modules/schemastery" node_modules/schemastery
> ```
>
> 改 `src/` 后重新 `npm run build`；想省事直接用 `preset/` 的自包含版本即可。
> 本仓库同时是 DSH 插件开发方法示例（`src/tools.ts` 工具定义、`src/vault.ts` 扫描逻辑）。

### 常见问题

| 现象 | 解决 |
| --- | --- |
| 工具不出现 | 检查挂载路径 / `preset/` 目录完整性，重启 DSH |
| `vault` 传绝对路径被拒 | 加入 `vaultRoots`，或 `allowArbitraryRoots: true` |
| 符号链接目录里的笔记搜不到 | 配置 `allowSymlinkEscape: true` |
| `Cannot find module lib/index.js` | 改过 `src/` 需重新构建 |
| 面板里 `vault_*` 认不到当前库 | dock 需为 per-vault 模式（注入 `DSH_OBSIDIAN_VAULT_PATH`）；shared 模式退回「最近活跃库 / 工作目录」解析 |

## 📜 更新记录

| 日期 | 更新 |
| --- | --- |
| 2026-08-19 | 结构化错误码：全部失败改抛 `VaultError`（`VAULT_*` 词表 + 复用宿主 `FS_*`），宿主可路由 `ToolFailure.info`；regression 增加错误码断言；`preset/vendor` 依赖链整体对齐宿主 rc.6（此前 peer 漂到 rc.7）；版本升至 0.4.0 |
| 2026-08-19 | README 新增「与 obsidian-dsh-dock 珠联璧合」章节（配合机制 / 三步启用）；修正当前库解析顺序为「注入优先于工作目录」——README 与系统提示词（`src/prompt.ts`，已重新构建并同步 `preset/vendor`）全部对齐 `tools.ts` 实现；FAQ 补充 dock 排障 |
| 2026-08-19 | 自包含 preset 开箱即用（`preset/`，vendor 内置构建产物与依赖）；`lib/` 入库；移除 dsh-dock 焦点标记，per-vault 以 `DSH_OBSIDIAN_VAULT_PATH` 注入为准 |
| 2026-08-17 | `vault_current`；rename 事务回滚；frontmatter `aliases` 解析；markdown 尖括号路径；广度优先限并发遍历 |
