import z from '@deepseek-ai/schemastery';
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
    vaultRoot?: string;
    /** Extra vault roots that are always searchable even if not in the Obsidian registry. */
    vaultRoots?: string[];
    /** Read the Obsidian global registry (`obsidian.json`) to discover every vault. */
    discoverVaults: boolean;
    /** Maximum hits returned by `vault_search`. */
    maxResults: number;
    /** Directory names skipped during vault walking (plus every dot-directory). */
    ignoreDirs: string[];
    /**
     * Allow a `vault` argument that is an absolute path to an unregistered
     * directory. Default `false`: only discovered vaults, `vaultRoots` and
     * `vaultRoot` may be targeted.
     */
    allowArbitraryRoots: boolean;
    /**
     * Follow symlinks that resolve outside the vault root. Default `false`:
     * note paths escaping through symlinks are rejected, and vault walks skip
     * symlinked entries pointing outside.
     */
    allowSymlinkEscape: boolean;
}
/** The schemastery schema the loader validates the patch `config` against. */
export declare const Config: z<Schemastery.ObjectS<{
    vaultRoot: z<string, string>;
    vaultRoots: z<string[], string[]>;
    discoverVaults: z<boolean, boolean>;
    maxResults: z<number, number>;
    ignoreDirs: z<string[], string[]>;
    allowArbitraryRoots: z<boolean, boolean>;
    allowSymlinkEscape: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    vaultRoot: z<string, string>;
    vaultRoots: z<string[], string[]>;
    discoverVaults: z<boolean, boolean>;
    maxResults: z<number, number>;
    ignoreDirs: z<string[], string[]>;
    allowArbitraryRoots: z<boolean, boolean>;
    allowSymlinkEscape: z<boolean, boolean>;
}>>;
