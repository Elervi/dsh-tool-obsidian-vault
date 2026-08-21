import type { Context } from '@deepseek-ai/cordis'
// Load the cordis Context augmentations for `ctx.systemPrompt` (typed service).
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config } from './config.js'
import type { VaultConfig } from './config.js'
import { installPreset } from './install.js'
import { buildPromptSection } from './prompt.js'
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
 * Two mount shapes share this entry:
 *   - agent-plane mount (the preset's `agent.cordis.yml` row) — registers the
 *     `vault_*` tools and the `tools:obsidian-vault` prompt section into the
 *     preset's scope, so only sessions on this preset can call them;
 *   - host-plane installer mount (the bundle's `cordis.patch.yml` row, with
 *     `installPreset: true, registerTools: false`) — on boot, copies this
 *     package's `presets/obsidian/` into `$DSH_HOME/.agent-presets/obsidian`
 *     so the preset appears in the new-session picker, and registers nothing.
 *
 * The tools register into the host `ctx.tools` registry (global layer), so
 * every agent mounted on this profile can call them.
 */
export const name = 'tool-obsidian-vault'
export const inject = ['tools', 'fs', 'systemPrompt'] as const
export { Config }

export async function apply(ctx: Context, config: VaultConfig): Promise<void> {
  if (config.installPreset) {
    await installPreset({ log: (line) => ctx.logger.info(line) })
  }
  if (!config.registerTools) return
  const text = await buildPromptSection()
  ctx.systemPrompt.section({
    name: 'tools:obsidian-vault',
    order: 110,
    text,
  })
  registerTools(ctx, config)
}
