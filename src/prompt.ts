/**
 * Model-facing guidance about this vault's conventions. Registered as a
 * system-prompt section named `tools:obsidian-vault`.
 */
export const PROMPT_SECTION = `Obsidian vault 约定：vault 是一棵 Markdown 笔记树，笔记之间用 [[wikilink]] 互链，frontmatter 用 YAML 包裹在 --- 之间。工作流程建议：先用 vault_list_vaults 查看本机有哪些 Obsidian 库，用 vault_search 定位、vault_list_notes 列目录，再 vault_read_note 读原文、vault_backlinks 看反向链接，最后用 vault_create_note 新建或覆盖笔记。查看笔记元数据用 vault_frontmatter，梳理出链用 vault_note_links，重命名或移动笔记务必用 vault_rename_note（它会自动更新全库引用，重命名后旧文件需自行清理）。所有 vault 工具都接受可选的 vault 参数（库名或绝对路径）来指定操作哪个库，不传时自动解析当前库。所有路径都用 vault 根目录的相对路径（/ 分隔），vault_create_note/vault_read_note 等工具的路径可省略 .md 后缀。`
