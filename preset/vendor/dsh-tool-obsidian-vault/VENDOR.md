# Vendored plugin snapshot

`dsh-tool-obsidian-vault` is vendored here (built `lib/` + runtime `node_modules/`)
so this preset is self-contained: installing the preset requires no npm steps and
no absolute paths — the loader resolves `./vendor/dsh-tool-obsidian-vault/lib/index.js`
against this preset's own directory.

## What is inside

- `lib/` — the plugin's compiled ESM output (from the plugin repository's `src/`).
- `node_modules/` — real (non-symlink) installs of the runtime dependencies the
  plugin's `lib/` imports: `@deepseek-ai/dsh-tools` (pinned to the same version the
  host harness runs, so tool definitions are byte-identical) plus its peer packages
  (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-scope`,
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, …).
- `package.json` — trimmed to the runtime surface (`type: module`, `main`, `types`).

## How to refresh

From the plugin repository root:

1. Rebuild: `npm run build` (or `node node_modules/typescript/bin/tsc -p tsconfig.json`)
2. Reinstall runtime deps into a clean staging dir. Pin the WHOLE `@deepseek-ai`
   chain to the host's version — pinning only `dsh-tools` lets npm resolve its
   `^0.1.0-rc.6` peers to a NEWER rc (this once drifted every other package to
   rc.7), which breaks module identity with the host and the `ToolFailure.info`
   extraction:

   ```sh
   npm install --prefix /tmp/vendor-stage --no-audit --no-fund \
     @deepseek-ai/dsh-tools@0.1.0-rc.6 \
     @deepseek-ai/dsh-llm@0.1.0-rc.6 \
     @deepseek-ai/dsh-agent@0.1.0-rc.6 \
     @deepseek-ai/dsh-attachment@0.1.0-rc.6 \
     @deepseek-ai/dsh-brand@0.1.0-rc.6 \
     @deepseek-ai/dsh-code-runtime@0.1.0-rc.6 \
     @deepseek-ai/dsh-invariants@0.1.0-rc.6 \
     @deepseek-ai/dsh-scope@0.1.0-rc.6 \
     @deepseek-ai/dsh-session@0.1.0-rc.6 \
     @deepseek-ai/dsh-system-prompt@0.1.0-rc.6 \
     @deepseek-ai/dsh-timeout@0.1.0-rc.6 \
     @deepseek-ai/dsh-typert-protocol@0.1.0-rc.6 \
     @deepseek-ai/dsh-user-approval@0.1.0-rc.6 \
     @deepseek-ai/schemastery@3.18.1
   ```
3. Copy in (replace, don't nest — `cp -R` into an existing dir creates `lib/lib`):
   - `rm -rf <this-dir>/lib && cp -R lib <this-dir>/lib`
   - `rm -rf <this-dir>/node_modules && cp -R /tmp/vendor-stage/node_modules <this-dir>/node_modules`
   - `rm -rf <this-dir>/node_modules/.bin` (CLI shims are not needed at runtime)
   - update `package.json` version if it changed

Never symlink dependencies here: symlinks are machine-specific and break the
"copy and run" promise of this preset.
