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
 *      最权威 —— 在 A 库的服务里提问不会解析成 B 库);
 *   5. the most recently active open vault from the global registry
 *      (newest `.obsidian/workspace.json` among open vaults);
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
  /**
   * Use the dsh-dock Obsidian API bridge when available (bridge-first, file
   * fallback). Default `true`. Turn off to always read files directly.
   */
  bridge: boolean
  /**
   * Self-install the bundled agent preset (`presets/obsidian/` in this
   * package) into `$DSH_HOME/.agent-presets/obsidian` at plugin start.
   *
   * This is the one-command install path: the package is added as a profile
   * bundle (`dsh plugin --profile web add github:...`), this flag runs the
   * copy, and the preset shows up in the new-session picker on next boot.
   * The copy is idempotent and, in `'merge'` mode (default), syncs to the
   * bundled snapshot on every upgrade while keeping user edits — see
   * `presetMode`. Default `false` (the preset's own agent-plane mount never
   * sets it).
   */
  installPreset: boolean
  /**
   * Behavior when `~/.dsh/.agent-presets/obsidian` already exists:
   *   - `'merge'`     (default) 3-way sync against a baseline manifest: update
   *     files the user never touched, keep user-edited and user-added files,
   *     add new plugin files, drop plugin-removed files. Fixes "upgrading the
   *     plugin leaves the preset at the old snapshot".
   *   - `'preserve'`  never overwrite an existing preset (historical behavior).
   *   - `'overwrite'` replace the whole preset with the bundled snapshot.
   */
  presetMode: 'merge' | 'preserve' | 'overwrite'
  /**
   * Whether this mount registers the `vault_*` tools and the
   * `tools:obsidian-vault` prompt section. The preset's agent-plane row
   * leaves it on (default); the host-plane installer row turns it off so the
   * tools stay confined to the preset instead of leaking into every session.
   */
  registerTools: boolean
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
  bridge: z.boolean().default(true),
  installPreset: z.boolean().default(false),
  presetMode: z.string().pattern(/^(merge|preserve|overwrite)$/).default('merge'),
  registerTools: z.boolean().default(true),
})
