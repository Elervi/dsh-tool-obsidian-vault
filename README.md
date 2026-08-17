# dsh-tool-obsidian-vault

面向本地 Obsidian vault 的 DSH 工具插件 —— 一个「插件开发方法」学习示例。

它导出标准 Cordis 插件形（`name` / `inject` / `Config` / `apply`），通过
`ctx.tools.register()` 注册 15 个模型可调用的工具，并注册一条 `tools:obsidian-vault`
提示段。所有 vault I/O 都走 `ctx.fs`（继承沙箱、原子写、版本守卫），扫描逻辑
放在 `src/vault.ts`，工具定义放在 `src/tools.ts`。

## 多库支持

插件默认开启 `discoverVaults`：读取 Obsidian 全局注册表（macOS
`~/Library/Application Support/obsidian/obsidian.json`、Linux `~/.config/obsidian/`、
Windows `%APPDATA%\obsidian\`）自动发现本机全部 vault。每个工具都接受可选
`vault` 参数（库名或绝对路径）指定操作目标；不传时的解析顺序为：
调用参数 → `config.vaultRoot` → 会话工作目录（若在已发现库中）→ 当前打开的库
→ 会话工作目录 → `process.cwd()`。`vault_list_vaults` 可查看发现结果。

### 安全默认值

- **`allowArbitraryRoots`（默认 false）**：`vault` 参数只接受已发现的库、
  `vaultRoots` 或 `vaultRoot` 中注册的路径；未注册的任意绝对路径一律拒绝。
  需要操作注册表之外的库时显式开启。
- **`allowSymlinkEscape`（默认 false）**：笔记路径经符号链接指向库外的，
  读写被拒绝、遍历被跳过（通过 `fs.contains` 规范包含检查）。
- 笔记路径强制为库相对路径：拒绝前导 `/`、盘符（`C:\…`）、`..` 段（Windows
  下含 `\` 分隔），任何平台都无法穿越出库。

## 工具一览

| 工具 | 作用 | 教什么 |
|---|---|---|
| `vault_list_vaults` | 列出本机全部 Obsidian 库 | 读全局配置自动发现、多库路由 |
| `vault_list_notes` | 递归列出 `.md` 笔记（`all: true` 时含附件） | 参数 schema、输出 schema、`presentCall`、`getFiles` vs `getMarkdownFiles` |
| `vault_list_folders` | 列出全部文件夹及各自的笔记数（含空文件夹） | 遍历统计、Obsidian 文件树计数 |
| `vault_search` | 关键字/正则/多词 AND 检索（文件名+正文） | 检索工具、结果上限、摘要、增量缓存 |
| `vault_search_tags` | 按标签检索（内联 `#tag` + frontmatter tags，含子标签） | `#tag` 搜索语义、frontmatter 标签解析 |
| `vault_read_note` | 读单篇笔记（按行切片） | `ctx.fs.stat` / `readText`、`FsError` 码映射、越界钳制 |
| `vault_note_info` | 单篇综合元信息：标签/别名/出链/反链统计 | `extractTags`、markdown 链接解析、Dataview 式概览 |
| `vault_create_note` | 新建/覆盖笔记（`unique` 自动唯一名） | `createIfAbsent` / `replaceIfVersion` 版本守卫、Obsidian 唯一名行为 |
| `vault_edit_note` | 精准字面替换编辑（同 DSH `edit` / `vault.process`） | `editText` 字面编辑、歧义/未找到错误码映射、版本守卫 |
| `vault_append_note` | 末尾追加（同 `vault.append`） | 读-改-写 + 版本守卫、换行胶水 |
| `vault_backlinks` | 反向链接（`format` 支持 wikilink/markdown/all） | `[[wikilink]]` + `[text](path)` 双语法、同名笔记用 `path` 精确指定 |
| `vault_frontmatter` | 读 frontmatter 并校验 | YAML 子集解析、问题报告 |
| `vault_update_frontmatter` | 增删改 Properties（无 frontmatter 时自动创建） | 行级 YAML 块改写、保留字段顺序、Obsidian Properties |
| `vault_note_links` | 列笔记的全部出链 | 链接解析（锚点/别名/嵌入） |
| `vault_rename_note` | 重命名/移动并更新全库引用（wikilink + markdown 链接，`keep_old: 'stub'` 留跳转占位） | 多文件写、版本守卫、写前预检、自引用改写、相对路径重算 |

### 文件操作要点

- **小改优先 `vault_edit_note`**：字面替换、默认恰好一次匹配（多次须 `replace_all: true`），带版本守卫——对应
  [Obsidian 官方推荐的 `Vault.process()`](https://github.com/obsidianmd/obsidian-developer-docs/blob/31946e5a/en/Plugins/Vault.md) 的「读-改-写不被并发打断」。
- **元数据用 `vault_update_frontmatter`**：`set`/`delete` 增删改 Properties，没有 frontmatter 时自动创建，保留其余字段顺序与正文。
- **删除的限制**：`ctx.fs` 服务没有删除/回收站原语（对应 Obsidian 的 `vault.trash()`/`vault.delete()` 在 DSH 侧由 bash 承担），
  所以重命名后旧文件默认保留（可用 `keep_old: 'stub'` 替换为跳转占位），彻底删除请用 bash 清理。
- **搜索语法**：默认字面子串（大小写不敏感）；`regex: true` 用正则；`match_all: true` 空格分词、每词必中（AND）。
- **标签**：识别正文内联 `#tag`（`#tag/子标签`）与 frontmatter `tags`/`tag` 属性，`vault_search_tags` 按 Obsidian `#tag` 语义匹配。

## 从 git 安装

> 这个插件是 **DSH（DeepSeek Harness）的工具插件**，不是 Obsidian 第三方插件——安装分四步：clone → 装依赖 → 构建 → 挂载到 DSH 的 agent preset。

### 0. 前置条件

- **Node.js ≥ 20**（推荐 22+）
- **DSH 已安装**：`npm i -g @deepseek-ai/dsh`（插件运行时依赖从 DSH 安装目录解析）

### 1. 获取代码

```sh
git clone git@github.com:Elervi/dsh-tool-obsidian-vault.git
cd dsh-tool-obsidian-vault
```

### 2. 安装依赖（关键，有坑）

运行时依赖 `@deepseek-ai/dsh-tools`（`defineTool`）与 `@deepseek-ai/schemastery`（`Config`）
是 rc 版本（`0.1.0-rc.6` / `3.18.1`），官方源通常装不到正确版本（rc 包被放在
`next` tag 下、`latest` 仍是旧版）。**推荐做法：从 DSH 安装目录软链同版本副本**
（类型依赖 `cordis` / `dsh-fs` / `dsh-system-prompt` 一并软链，`typescript` 正常安装）：

```sh
# typescript 等 devDependencies 正常安装
npm install

# 软链运行时 + 类型依赖（版本必须与 DSH 安装目录一致）
DSH_PREFIX="$(npm root -g)/@deepseek-ai/dsh"
mkdir -p node_modules/@deepseek-ai
for p in dsh-tools cordis dsh-fs dsh-system-prompt; do
  ln -sfn "$DSH_PREFIX/node_modules/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
ln -sfn "$DSH_PREFIX/node_modules/schemastery" node_modules/schemastery
```

如果官方源恰好能装到这些 rc 版本（`npm install` 成功且版本匹配），可以跳过软链。

### 3. 构建

```sh
npm run build        # tsc -p tsconfig.json → lib/
```

> ⚠️ `lib/` 在 `.gitignore` 中，clone 后不存在，**必须先构建**再挂载，否则会报
> `Cannot find module .../lib/index.js`。

### 4. 挂载到 DSH（agent preset）

在 agent preset 配置（如 `~/.dsh/.agent-presets/obsidian/agent.cordis.yml`）
的 tools 层添加一行（绝对路径指向实际 clone 位置）：

```yaml
- id: tool-obsidian-vault
  name: '/绝对/路径/dsh-tool-obsidian-vault/lib/index.js'
  config:
    maxResults: 20
    ignoreDirs: ['.obsidian', '.git', '.claudian', '.trash']
    # allowArbitraryRoots: false  # 默认拒绝未注册的任意绝对路径
    # allowSymlinkEscape: false   # 默认拒绝经符号链接越出 vault 的读写
```

重启 DSH 会话后，vault 工具即可用。

### 5. 验证

```sh
SMOKE_VAULT=/path/to/your/vault npm test   # 对真实 vault 跑 list/search/backlinks；不设置 SMOKE_VAULT 时跳过只读测试，写测试使用系统临时目录
```

### 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `Cannot find module lib/index.js` | clone 后未构建（`lib/` 被 gitignore） | `npm run build` |
| ESM 解析失败 / 依赖版本报错 | 软链缺失或版本与 DSH 不一致 | 重跑第 2 步软链，确认版本与 `@deepseek-ai/dsh` 相同 |
| 工具不出现 | 配置没生效 | 检查 preset 配置的 `name` 绝对路径，重启会话 |
| 只能操作一个库 | 未启用多库发现 | 确认未设 `vaultRoot`，且 Obsidian 全局注册表可读（见「多库支持」） |
| `vault` 传绝对路径被拒 | 默认只允许已注册的库 | 将该路径加入 `vaultRoots`，或配置 `allowArbitraryRoots: true` |
| 符号链接目录里的笔记搜不到 | 链接指向库外，默认被跳过 | 配置 `allowSymlinkEscape: true` 放行 |

## 构建

```sh
pnpm --dir . install   # 或见下方「离线依赖」说明
pnpm --dir . build     # tsc -p tsconfig.json → lib/
```

## 依赖说明

`@deepseek-ai/dsh-tools`（`defineTool`）与 `@deepseek-ai/schemastery`（`Config`）
是运行时依赖；`@deepseek-ai/cordis` / `@deepseek-ai/dsh-fs` / `@deepseek-ai/dsh-system-prompt`
仅用于类型。由于镜像源把 rc 包放在 `next` tag 下、`latest` 仍是旧版，
本学习项目选择把这几包直接软链到 dsh 安装目录的同版本副本（见上方
「从 git 安装 · 第 2 步」），typescript 单独从镜像安装。
