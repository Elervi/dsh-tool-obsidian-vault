# dsh-tool-obsidian-vault

> 给 DSH（DeepSeek Harness）的 Obsidian 库工具插件：16 个 `vault_*` 工具，让 Agent
> 直接搜索、读写本地 Obsidian 笔记，支持反向链接、frontmatter 与安全重命名。
> 附带一个**开箱即用**的 agent preset——复制目录即安装，无需构建、无需改路径。

## ✨ 特性

- 📦 **开箱即用** — 自带自包含 preset（构建产物 + 运行时依赖已打包），无 npm / 构建 / 路径配置
- 🗂️ **多库自动发现** — 读 Obsidian 全局注册表，自动解析当前库（dsh-dock 注入优先）
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

**当前库解析顺序**：`vault` 参数 → `vaultRoot` → 会话工作目录（若为库）→
dsh-dock 注入的本库（`DSH_OBSIDIAN_VAULT_PATH`）→ 最近活跃打开库 → 工作目录。

**安全默认**：`allowArbitraryRoots` / `allowSymlinkEscape` 默认关闭；
笔记路径强制为库内相对路径（拒绝 `/`、盘符、`..` 穿越）。

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
> for p in dsh-tools cordis dsh-fs dsh-system-prompt; do
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

## 📜 更新记录

| 日期 | 更新 |
| --- | --- |
| 2026-08-19 | 自包含 preset 开箱即用（`preset/`，vendor 内置构建产物与依赖）；`lib/` 入库；移除 dsh-dock 焦点标记，per-vault 以 `DSH_OBSIDIAN_VAULT_PATH` 注入为准 |
| 2026-08-17 | `vault_current`；rename 事务回滚；frontmatter `aliases` 解析；markdown 尖括号路径；广度优先限并发遍历 |
