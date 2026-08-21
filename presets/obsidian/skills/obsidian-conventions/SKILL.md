---
name: obsidian-conventions
description: 在 Obsidian 库中正确工作的补充约定——Callout、嵌入、标签、每日笔记命名与安全编辑。在创建或重构笔记前加载。
whenToUse: 正在操作 Obsidian vault，或用户询问笔记、链接、标签、库结构相关问题。
---

# Obsidian 库写作约定（补充）

> 系统提示词的 `tools:obsidian-vault` 段已覆盖库结构、工作流与全部 vault 工具规则；本技能只补充以下细节，避免重复。

## 笔记元素
- 引用块用 Obsidian Callout：`> [!note] 标题`（常见类型：note / tip / warning / danger / info）。
- 嵌入资源用 `![[图片.png]]`。
- 标签沿用库里已有风格（`#标签` 或 `#标签/子标签`），不要随手发明新标签。
- 新增 frontmatter 字段前先看同类笔记用了哪些字段，保持库内一致。

## 命名与忽略
- 每日笔记通常形如 `YYYY-MM-DD.md`；先确认库里现有的命名/目录习惯再动手。
- `.obsidian/`、`.trash`、`.git` 等目录由 vault 工具忽略，不要手动改动。

## 安全编辑
- 重命名或移动笔记用 `vault_rename_note`：它会自动更新全库 wikilink 与 markdown 链接并改写笔记自身引用（失败自动回滚；`keep_old: "stub"` 可留跳转占位）。不要手工逐处改引用。
- 覆盖已有笔记要谨慎：先读原内容，确认后再写入。
