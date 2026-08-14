import z from '@deepseek-ai/schemastery'

/**
 * Resolved plugin configuration handed to `apply()`.
 *
 * `vaultRoot` is optional: when omitted, each tool call falls back to the
 * calling agent's session workspace (`exec.agent.session.header.cwd`), which
 * is exactly the directory the profile was launched from.
 */
export interface VaultConfig {
  /** Absolute path to the vault root; default = the calling session's cwd. */
  vaultRoot?: string
  /** Maximum hits returned by `vault_search`. */
  maxResults: number
  /** Directory names skipped during vault walking (plus every dot-directory). */
  ignoreDirs: string[]
}

/** The schemastery schema the loader validates the patch `config` against. */
export const Config = z.object({
  // In schemastery an object property is optional unless `.required()` is
  // called, so a bare `z.string()` here already means "may be absent".
  vaultRoot: z.string(),
  maxResults: z.number().min(1).default(20),
  ignoreDirs: z.array(z.string()).default(['.obsidian', '.git', '.claudian', '.trash']),
})
