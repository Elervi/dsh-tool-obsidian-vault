# dsh-tool-obsidian-vault

面向本地 Obsidian vault 的 DSH 工具插件 —— 一个「插件开发方法」学习示例。

它导出标准 Cordis 插件形（`name` / `inject` / `Config` / `apply`），通过
`ctx.tools.register()` 注册 5 个模型可调用的工具，并注册一条 `tools:obsidian-vault`
提示段。所有 vault I/O 都走 `ctx.fs`（继承沙箱、原子写、版本守卫），扫描逻辑
放在 `src/vault.ts`，工具定义放在 `src/tools.ts`。

## 工具一览

| 工具 | 作用 | 教什么 |
|---|---|---|
| `vault_list_notes` | 递归列出 `.md` 笔记 | 参数 schema、输出 schema、`presentCall` |
| `vault_search` | 关键字搜索文件名+正文 | 检索工具、结果上限、摘要 |
| `vault_read_note` | 读单篇笔记 | `ctx.fs.stat` / `readText`、`FsError` 码映射 |
| `vault_create_note` | 新建/覆盖笔记 | `createIfAbsent` / `replaceIfVersion` 版本守卫 |
| `vault_backlinks` | 找 `[[wikilink]]` 反向链接 | 正文处理 + render |

## 构建

```sh
pnpm --dir . install   # 或见下方「离线依赖」说明
pnpm --dir . build     # tsc -p tsconfig.json → lib/
```

## 依赖说明

`@deepseek-ai/dsh-tools`（`defineTool`）与 `@deepseek-ai/schemastery`（`Config`）
是运行时依赖；`@deepseek-ai/cordis` / `@deepseek-ai/dsh-fs` / `@deepseek-ai/dsh-system-prompt`
仅用于类型。由于镜像源把 rc 包放在 `next` tag 下、`latest` 仍是旧版，
本学习项目选择把这几包直接软链到 dsh 安装目录的同版本副本（见仓库根 README
的「离线依赖」一节），typescript 单独从镜像安装。
