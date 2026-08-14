/**
 * Model-facing guidance about this vault's conventions. Registered as a
 * system-prompt section named `tools:obsidian-vault`.
 */
export const PROMPT_SECTION = `Obsidian vault 约定：vault 是一棵 Markdown 笔记树，笔记之间用 [[wikilink]] 互链，frontmatter 用 YAML 包裹在 --- 之间。工作流程建议：先用 vault_search 定位、vault_list_notes 列目录，再 vault_read_note 读原文、vault_backlinks 看反向链接，最后用 vault_create_note 新建或覆盖笔记。所有路径都用 vault 根目录的相对路径（/ 分隔），vault_create_note/vault_read_note 的路径可省略 .md 后缀。`
