import z from '@deepseek-ai/schemastery'

/**
 * Resolved plugin configuration handed to `apply()`.
 *
 * Resolution order for the vault a tool call operates on:
 *   1. the call's optional `vault` argument (vault name or path);
 *   2. an explicit `vaultRoot` (single vault pinned in config);
 *   3. the calling session's workspace (`exec.agent.session.header.cwd`)
 *      when it is one of the discovered vaults;
 *   4. the vault dsh-dock injected for this service
 *      (`DSH_OBSIDIAN_VAULT_PATH` env; per-vault 模式下本服务所属库，
 *      比全局焦点标记更权威 —— 在生物备课的服务里提问不会解析成生物题库);
 *   5. the vault dsh-dock marked as the focused Obsidian window
 *      (`~/.dsh/current-vault.json`), falling back to the most recently
 *      active open vault from the global registry;
 *   6. the calling session's workspace, then `process.cwd()`.
 */
export interface VaultConfig {
  /** Absolute path to the vault root; default = discovery / session cwd. */
  vaultRoot?: string
  /** Extra vault roots that are always searchable even if not in the Obsidian registry. */
  vaultRoots?: string[]
  /** Read the Obsidian global registry (`obsidian.json`) to discover every vault. */
  discoverVaults: boolean
  /** Maximum hits returned by `vault_search`. */
  maxResults: number
  /** Directory names skipped during vault walking (plus every dot-directory). */
  ignoreDirs: string[]
  /**
   * Allow a `vault` argument that is an absolute path to an unregistered
   * directory. Default `false`: only discovered vaults, `vaultRoots` and
   * `vaultRoot` may be targeted.
   */
  allowArbitraryRoots: boolean
  /**
   * Follow symlinks that resolve outside the vault root. Default `false`:
   * note paths escaping through symlinks are rejected, and vault walks skip
   * symlinked entries pointing outside.
   */
  allowSymlinkEscape: boolean
}

/** The schemastery schema the loader validates the patch `config` against. */
export const Config = z.object({
  // In schemastery an object property is optional unless `.required()` is
  // called, so a bare `z.string()` here already means "may be absent".
  vaultRoot: z.string(),
  vaultRoots: z.array(z.string()),
  discoverVaults: z.boolean().default(true),
  maxResults: z.number().min(1).default(20),
  ignoreDirs: z.array(z.string()).default(['.obsidian', '.git', '.claudian', '.trash']),
  allowArbitraryRoots: z.boolean().default(false),
  allowSymlinkEscape: z.boolean().default(false),
})
