import type { Context } from '@deepseek-ai/cordis'
// Load the cordis Context augmentations for `ctx.systemPrompt` (typed service).
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config } from './config.js'
import type { VaultConfig } from './config.js'
import { PROMPT_SECTION } from './prompt.js'
import { registerTools } from './tools.js'

/**
 * A DSH tool plugin over a local Obsidian vault.
 *
 * Plugin shape (the Cordis contract):
 *   - `name`       — the plugin id, used by patch rows and diagnostics
 *   - `inject`     — services this plugin hard-requires before `apply` runs
 *   - `Config`     — a schemastery schema the loader validates `config` against
 *   - `apply`      — the effect body; registers tools + prompt guidance here
 *
 * The tools register into the host `ctx.tools` registry (global layer), so
 * every agent mounted on this profile can call them.
 */
export const name = 'tool-obsidian-vault'
export const inject = ['tools', 'fs', 'systemPrompt'] as const
export { Config }

export function apply(ctx: Context, config: VaultConfig): void {
  ctx.systemPrompt.section({
    name: 'tools:obsidian-vault',
    order: 110,
    text: PROMPT_SECTION,
  })
  registerTools(ctx, config)
}
