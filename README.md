# dsh-tool-obsidian-vault

面向本地 Obsidian vault 的 DSH 工具插件 —— 一个「插件开发方法」学习示例。

它导出标准 Cordis 插件形（`name` / `inject` / `Config` / `apply`），通过
`ctx.tools.register()` 注册 9 个模型可调用的工具，并注册一条 `tools:obsidian-vault`
提示段。所有 vault I/O 都走 `ctx.fs`（继承沙箱、原子写、版本守卫），扫描逻辑
放在 `src/vault.ts`，工具定义放在 `src/tools.ts`。

## 多库支持

插件默认开启 `discoverVaults`：读取 Obsidian 全局注册表（macOS
`~/Library/Application Support/obsidian/obsidian.json`、Linux `~/.config/obsidian/`、
Windows `%APPDATA%\obsidian\`）自动发现本机全部 vault。每个工具都接受可选
`vault` 参数（库名或绝对路径）指定操作目标；不传时的解析顺序为：
调用参数 → `config.vaultRoot` → 会话工作目录（若在已发现库中）→ 当前打开的库
→ 会话工作目录 → `process.cwd()`。`vault_list_vaults` 可查看发现结果。

## 工具一览

| 工具 | 作用 | 教什么 |
|---|---|---|
| `vault_list_vaults` | 列出本机全部 Obsidian 库 | 读全局配置自动发现、多库路由 |
| `vault_list_notes` | 递归列出 `.md` 笔记 | 参数 schema、输出 schema、`presentCall` |
| `vault_search` | 关键字搜索文件名+正文 | 检索工具、结果上限、摘要、增量缓存 |
| `vault_read_note` | 读单篇笔记 | `ctx.fs.stat` / `readText`、`FsError` 码映射 |
| `vault_create_note` | 新建/覆盖笔记 | `createIfAbsent` / `replaceIfVersion` 版本守卫 |
| `vault_backlinks` | 找 `[[wikilink]]` 反向链接 | 正文处理 + render |
| `vault_frontmatter` | 读笔记 frontmatter 并校验 | YAML 子集解析、问题报告 |
| `vault_note_links` | 列笔记的全部出链 | 链接解析（锚点/别名/嵌入） |
| `vault_rename_note` | 重命名/移动笔记并更新全库引用 | 多文件写、版本守卫并发安全 |

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
```

重启 DSH 会话后，vault 工具即可用。

### 5. 验证

```sh
npm test             # 冒烟测试：对真实 vault 跑 list/search/backlinks，对临时目录跑 create/rename
```

### 常见问题

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `Cannot find module lib/index.js` | clone 后未构建（`lib/` 被 gitignore） | `npm run build` |
| ESM 解析失败 / 依赖版本报错 | 软链缺失或版本与 DSH 不一致 | 重跑第 2 步软链，确认版本与 `@deepseek-ai/dsh` 相同 |
| 工具不出现 | 配置没生效 | 检查 preset 配置的 `name` 绝对路径，重启会话 |
| 只能操作一个库 | 未启用多库发现 | 确认未设 `vaultRoot`，且 Obsidian 全局注册表可读（见「多库支持」） |

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
