import z from '@deepseek-ai/schemastery';
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
});
