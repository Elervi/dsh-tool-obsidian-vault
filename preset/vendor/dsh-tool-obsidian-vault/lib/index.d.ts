import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import type { VaultConfig } from './config.js';
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
export declare const name = "tool-obsidian-vault";
export declare const inject: readonly ["tools", "fs", "systemPrompt"];
export { Config };
export declare function apply(ctx: Context, config: VaultConfig): Promise<void>;
