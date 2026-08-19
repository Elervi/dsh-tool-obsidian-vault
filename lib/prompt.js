/**
 * Model-facing guidance about this vault's conventions. Registered as a
 * system-prompt section named `tools:obsidian-vault`.
 *
 * The section is built dynamically at session start. When dsh-dock bound this
 * service to a vault (`DSH_OBSIDIAN_VAULT_PATH`, per-vault isolation) the
 * dynamic part asserts that binding so the model knows which vault is current
 * without calling a tool. Without a binding it falls back to the session
 * working directory: if the cwd happens to be a registered vault, that vault
 * is asserted as current (same rule as the tools' resolution order). Only
 * when neither applies does the section say the session is NOT vault-bound —
 * the model must not claim a "current vault" (a mtime-guessed one would
 * mislead). The static part keeps the conventions and the fallback
 * instructions (`vault_current` re-check).
 */
import { discoverVaults, injectedVaultPath, injectedVaultName } from './vault.js';
const BASE = `Obsidian vault 约定：vault 是一棵 Markdown 笔记树，笔记之间用 [[wikilink]] 或 [text](path) 互链，frontmatter（Properties）用 YAML 包裹在 --- 之间。工作流程：先定位（vault_search / vault_search_tags，或 vault_list_folders / vault_list_notes 看结构），再 vault_read_note 读原文、vault_backlinks 看反向链接（库里有同名笔记时传 path 精确指定目标），最后才写入（vault_create_note / vault_edit_note / vault_append_note / vault_update_frontmatter，各自行为见工具描述）。重命名或移动笔记务必用 vault_rename_note（自动更新全库 wikilink 与 markdown 链接并改写笔记自身引用；失败会自动回滚；keep_old: "stub" 可留跳转占位）。注意：ctx.fs 无删除原语，彻底删除请用 bash rm 清理。所有 vault 工具都接受可选 vault 参数（库名或已注册路径），不传时自动解析当前库（解析顺序：vault 参数 → 配置 vaultRoot → dsh-dock 注入的本服务所属库（per-vault 隔离时即本库）→ 会话工作目录若是库 → 最近活跃的已打开库 → 会话工作目录）；未注册的任意绝对路径默认被拒绝。所有路径都用 vault 根目录的相对路径（/ 分隔），可省略 .md 后缀，父目录不存在会自动创建。`;
/** 会话启动时求值：有 dsh-dock 绑定才断言"当前库"，否则明示未绑定。 */
export async function buildPromptSection() {
    const injected = injectedVaultPath();
    if (injected) {
        const name = injectedVaultName() ?? '(未知)';
        // 注入的路径优先于任何猜测：per-vault 模式下 env 就是本服务服务的库。
        return `本次会话已由 dsh-dock 绑定到 Obsidian 库「${name}」（${injected}），判定依据：per-vault 注入。\n\n${BASE}`;
    }
    // 无注入：若会话工作目录恰好是已注册库（工具解析顺序的兜底之一），断言该库为当前库；
    // 否则明示未绑定，模型不得把"最近活跃"之类的猜测当作当前库报告。
    const vaults = await discoverVaults().catch(() => []);
    const strip = (p) => p.replace(/[\\/]+$/, '');
    const cwdVault = vaults.find((v) => strip(v.path) === strip(process.cwd()));
    if (cwdVault) {
        return `本次会话的当前 Obsidian 库为「${cwdVault.name}」（${cwdVault.path}），判定依据：会话工作目录恰好是已注册库。\n\n${BASE}`;
    }
    const hint = vaults.length > 0
        ? 'vault 工具会自动回退到最近活跃的已打开库，但那是猜测，不是"当前库"。'
        : '本机未发现 Obsidian 库。';
    return `本次会话未绑定到任何 Obsidian 库（没有 dsh-dock per-vault 注入）。${hint}用户问到"工作目录/当前库"时，报告会话工作目录即可；不要声称存在"当前库"。若用户明确要求操作某个库，先调用 vault_list_vaults 或 vault_current 确认。\n\n${BASE}`;
}
