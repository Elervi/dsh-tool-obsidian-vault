import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import path from 'node:path'
import type { VaultConfig } from './config.js'
import {
  walkNotes, searchNotes, findBacklinks, extractLinks, extractMarkdownLinks,
  parseFrontmatter, rewriteWikilinks, rewriteMarkdownLinks, applyFrontmatterUpdate,
  joinRel, createBodyCache, discoverVaults, selectCurrentVault, buildLinkResolver, resolveLinkTarget,
  stemOf, dirOf, extractTags, findNotesByTag, listFolders, resolveMarkdownTarget,
  splitListValue, mapLimit, indexAliases, injectedVaultPath,
} from './vault.js'
import type { VaultNote, BacklinkFormat } from './vault.js'

/** Read the stable `code` off a thrown `FsError` (or fall back to the message). */
function errorLabel(err: unknown): string {
  const e = err as { code?: string; message?: string } | null
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    return `[${e.code}] ${e.message ?? ''}`
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Record an authoritative observation of a target we just wrote, so the host's
 * own `read`/`write`/`edit` tools (whose policy keys off `fs/observed`) see a
 * correct baseline afterwards. Fire-and-forget: a missing listener is fine.
 */
function emitObserved(ctx: Context, target: FsTarget, version: FsVersion, exec: object | undefined): void {
  try {
    ctx.emit('fs/observed', target, { kind: 'present', version }, exec)
  } catch {
    // Observation recording is best-effort; tool results must not depend on it.
  }
}

/**
 * Reverse-rollback reference rewrites that already committed during a rename.
 * Each file is written back to its pre-rename body under a fresh version guard
 * (re-stat), so a concurrent edit after our write surfaces as a rollback
 * failure instead of silently clobbering the other writer. Returns the paths
 * that could not be rolled back — an empty list means a clean rollback with
 * no residue.
 */
async function rollbackRewrites(
  ctx: Context,
  fs: FileSystem,
  planned: ReadonlyArray<{ note: VaultNote; original: string }>,
  committed: number,
  exec: { signal?: AbortSignal },
): Promise<string[]> {
  const errors: string[] = []
  for (let i = committed - 1; i >= 0; i--) {
    const { note, original } = planned[i]!
    try {
      const info = await fs.stat(note.target, exec.signal)
      if (info && info.type === 'file') {
        const outcome = await fs.writeText(note.target, original, { kind: 'replaceIfVersion', version: info.version }, exec.signal)
        emitObserved(ctx, note.target, outcome.version, exec)
      }
    } catch (err) {
      errors.push(`${note.path}（${errorLabel(err)}）`)
    }
  }
  return errors
}

/** Loose view of `ToolRunContext` for reading the calling session's cwd. */
interface CwdExec {
  agent?: { session?: { header?: { cwd?: string } } }
}

/**
 * Resolve which vault root one call operates on. Order: the call's `vault`
 * argument (matched by name or path) → a pinned `config.vaultRoot` → the
 * vault dsh-dock injected for this service (`DSH_OBSIDIAN_VAULT_PATH`,
 * per-vault 模式下本服务所属库，比工作目录巧合更权威) → the session
 * workspace when it is a discovered vault → the most recently active open
 * vault in Obsidian (see {@link selectCurrentVault}) → the session
 * workspace → `process.cwd()`.
 */
async function resolveVaultRoot(
  config: VaultConfig,
  exec: CwdExec,
  vaultArg?: string,
): Promise<string> {
  const discovered = config.discoverVaults ? await discoverVaults() : []
  const roots = [
    config.vaultRoot,
    ...(config.vaultRoots ?? []),
    ...discovered.map((v) => v.path),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  const norm = (p: string) => p.replace(/\/+$/, '')
  if (vaultArg && vaultArg.trim().length > 0) {
    const target = vaultArg.trim()
    const byPath = roots.find((r) => norm(r) === norm(target))
    if (byPath) return norm(byPath)
    const byName = discovered.find((v) => v.name === target)
    if (byName) return norm(byName.path)
    const looksAbsolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
    if (!looksAbsolute) throw new Error(`未知的 Obsidian 库：${target}（可用 vault_list_vaults 查看，或传绝对路径）`)
    if (!config.allowArbitraryRoots) {
      throw new Error(
        `未注册的库路径：${target}（默认只允许已发现的库与 vaultRoots；如需放行任意绝对路径，请配置 allowArbitraryRoots: true）`,
      )
    }
    return norm(target)
  }
  if (config.vaultRoot && config.vaultRoot.length > 0) return norm(config.vaultRoot)
  // dsh-dock 注入优先于工作目录巧合：per-vault 模式下本服务只属于这一个
  // 库（DSH_OBSIDIAN_VAULT_PATH），工作目录"恰好是库"只是巧合，不应压过
  // 本服务归属（曾导致在 A 库服务里误写 B 库）。
  const injected = injectedVaultPath()
  if (injected) {
    const hit = discovered.find((v) => norm(v.path) === norm(injected))
    if (hit) return norm(hit.path)
  }
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const hit = discovered.find((v) => norm(v.path) === norm(cwd))
    if (hit) return norm(hit.path)
  }
  const openVault = selectCurrentVault(discovered)
  if (openVault) return norm(openVault.path)
  if (typeof cwd === 'string' && cwd.length > 0) return norm(cwd)
  return norm(process.cwd())
}

/** 当前自动解析的库及其判定依据（vault_current 工具的返回）。 */
interface CurrentVaultInfo {
  name: string
  path: string
  source: string
}

/**
 * 与 {@link resolveVaultRoot} 相同的解析顺序，但额外返回"判定依据"，
 * 让模型/用户一眼看清当前库是怎么选出来的（dsh-dock 注入的本库 →
 * 会话工作目录 → 最近活跃打开库 → process.cwd()）。
 */
async function resolveCurrentVault(config: VaultConfig, exec: CwdExec): Promise<CurrentVaultInfo> {
  const discovered = config.discoverVaults ? await discoverVaults() : []
  const norm = (p: string) => p.replace(/\/+$/, '')
  const cwd = exec.agent?.session?.header?.cwd
  if (config.vaultRoot && config.vaultRoot.length > 0) {
    const p = norm(config.vaultRoot)
    return { name: path.basename(p), path: p, source: '配置 vaultRoot 固定指定' }
  }
  // 与 resolveVaultRoot 同步：dsh-dock 注入优先于工作目录巧合。
  const injected = injectedVaultPath()
  if (injected) {
    const hit = discovered.find((v) => norm(v.path) === norm(injected))
    if (hit) return { name: hit.name, path: norm(hit.path), source: 'dsh-dock 注入的本服务所属库（per-vault 隔离）' }
  }
  if (typeof cwd === 'string' && cwd.length > 0) {
    const hit = discovered.find((v) => norm(v.path) === norm(cwd))
    if (hit) return { name: hit.name, path: norm(hit.path), source: '会话工作目录恰好是库' }
  }
  const cur = selectCurrentVault(discovered)
  if (cur) {
    return {
      name: cur.name,
      path: cur.path,
      source: '最近活跃的已打开库',
    }
  }
  const fallback = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  return {
    name: path.basename(norm(fallback)) || '(未知)',
    path: norm(fallback),
    source: '回退：会话工作目录 / process.cwd()（未发现库）',
  }
}

/**
 * Normalize a user-supplied note path to a vault-relative `dir/name.md`.
 * Rejects empty input, absolute/rooted forms (leading `/`, Windows drive
 * letters, UNC), `..` segments (with `/` and, on Windows, `\` separators),
 * and paths whose basename would be empty.
 */
function noteRelPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('笔记路径不能为空')
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error(`笔记路径必须是 vault 相对路径（/ 分隔，不含盘符）：${trimmed}`)
  }
  // On Windows `\` is a path separator and must be checked like `/`; on POSIX
  // it is an ordinary filename character and can never escape the vault.
  const segments = trimmed
    .split(process.platform === 'win32' ? /[\\/]+/ : /\/+/)
    .filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) {
    throw new Error(`笔记路径不能包含 .. 段：${trimmed}`)
  }
  const joined = segments.join('/')
  if (joined === '') throw new Error('笔记路径不能为空')
  const noExt = joined.replace(/\.md$/, '')
  const base = noExt.split('/').pop() ?? ''
  if (noExt === '' || base === '' || base === '.') {
    throw new Error(`笔记路径无效（缺少文件名）：${trimmed}`)
  }
  return noExt + '.md'
}

/**
 * Resolve a vault-relative note path into an `fs` target and verify — via the
 * backend's canonical `contains` check — that it stays inside the vault root.
 * The containment check also rejects paths that escape through a symlink
 * unless `allowSymlinkEscape` is configured.
 */
async function resolveNoteTarget(
  fs: FileSystem,
  root: string,
  rel: string,
  allowSymlinkEscape: boolean,
): Promise<FsTarget> {
  const rootTarget = await fs.resolve(root, { cwd: root })
  const target = await fs.resolve(joinRel(root, rel), { cwd: root })
  if (!allowSymlinkEscape && !fs.contains(rootTarget, target)) {
    throw new Error(`笔记路径越出 vault（或经符号链接指向库外）：${rel}（如需放行请配置 allowSymlinkEscape: true）`)
  }
  return target
}

/** Filter notes to those inside exactly `folder` (not a prefix lookalike). */
function inFolder(p: string, folder: string): boolean {
  const prefix = folder.replace(/^\/+/, '').replace(/\/+$/, '')
  if (prefix === '') return true
  return p === prefix || p.startsWith(prefix + '/')
}

/** Walk the vault once and return the notes (optionally all files). */
async function vaultNotes(
  fs: FileSystem,
  config: VaultConfig,
  root: string,
  exec: { signal?: AbortSignal },
  includeAll = false,
): Promise<VaultNote[]> {
  const rootTarget = await fs.resolve(root, { cwd: root })
  return walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal, !config.allowSymlinkEscape, includeAll)
}

export function registerTools(ctx: Context, config: VaultConfig): void {
  const fs = ctx.fs
  // Shared per-session body cache: validated by fs.stat version, so repeated
  // search / backlink queries re-read only files that actually changed.
  const bodyCache = createBodyCache()

  ctx.tools.register(defineTool({
    name: 'vault_list_vaults',
    description: '列出本机所有已注册的 Obsidian 库（读 Obsidian 全局配置自动发现），返回库名、路径、打开状态与自动解析的当前库。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          vaults: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                open: { type: 'boolean' },
                current: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; vaults: Array<{ name: string; path: string; open?: boolean; current?: boolean }> }
        const lines = v.vaults.map((x) => {
          const tag = x.current ? '（当前打开 · 自动解析）' : x.open ? '（当前打开）' : ''
          return `- ${x.name}  ${tag}\n    ${x.path}`
        })
        return [{ type: 'text', text: `发现 ${v.total} 个 Obsidian 库：\n${lines.length ? lines.join('\n') : '(未发现，将回退到会话工作目录)'}` }]
      },
    },
    async execute() {
      const vaults = await discoverVaults()
      const current = selectCurrentVault(vaults)
      return {
        total: vaults.length,
        vaults: vaults.map((v) => ({
          name: v.name,
          path: v.path,
          ...(v.open ? { open: true } : {}),
          ...(current && current.path === v.path ? { current: true } : {}),
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: '列出本机全部 Obsidian 库' }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_current',
    description: '返回当前自动解析的 Obsidian 库：不带 vault 参数时，vault 工具默认操作哪个库，含库名、路径与判定依据（dsh-dock 注入的本库 / 最近活跃打开库 / 会话工作目录 / cwd）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          source: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { name: string; path: string; source: string }
        return [{
          type: 'text',
          text: `当前 vault：${v.name}\n  ${v.path}\n判定依据：${v.source}`,
        }]
      },
    },
    async execute(_args, exec) {
      return resolveCurrentVault(config, exec as CwdExec)
    },
    presentCall: () => ({ card: 'generic', title: '查询当前自动解析的库' }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_list_notes',
    description: '递归列出 Obsidian vault 里的全部 .md 笔记（all: true 时同时列出附件等非 Markdown 文件，对应 Obsidian 的 getFiles），返回 vault 根目录的相对路径（/ 分隔）、字节大小与文件扩展名。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      folder: { type: 'string', description: '可选：只列该子目录下的文件（vault 相对路径，/ 分隔）。' },
      limit: { type: 'number', description: '最多返回条数，默认 100。' },
      all: { type: 'boolean', description: '可选：为 true 时列出所有文件（含非 .md 附件），并在结果中给出 extension；默认只列 .md 笔记。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          notes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                size: { type: 'number' },
                extension: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; notes: Array<{ path: string; size?: number; extension?: string }> }
        const lines = v.notes.map((n) => {
          const ext = n.extension !== undefined ? ` (${n.extension})` : ''
          return `- ${n.path}${ext}${n.size !== undefined ? `  (${n.size} B)` : ''}`
        })
        return [{ type: 'text', text: `共 ${v.total} 个文件：\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { folder?: string; limit?: number; all?: boolean }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      let notes = await vaultNotes(fs, config, root, exec, Boolean(a.all))
      const folder = a.folder
      if (folder) {
        notes = notes.filter((n) => inFolder(n.path, folder))
      }
      const limit = Math.max(1, Math.min(a.limit ?? 100, 1000))
      const sliced = notes.slice(0, limit)
      return {
        total: notes.length,
        notes: sliced.map((n) => {
          const item: { path: string; size?: number; extension?: string } = { path: n.path }
          if (n.size !== undefined) item.size = n.size
          if (a.all && n.extension !== undefined) item.extension = n.extension
          return item
        }),
      }
    },
    presentCall: (args) => {
      const a = args as { folder?: string }
      return { card: 'generic', title: a?.folder ? `列出 vault/${a.folder}` : '列出 vault 全部笔记' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vault_search',
    description: '在 Obsidian vault 里检索笔记，匹配文件名与正文。默认按字面子串、大小写不敏感（同 Obsidian）；可选正则（regex: true）、大小写敏感（case_sensitive: true）、多词 AND（match_all: true，空格分词、每词都必须命中）。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      query: { type: 'string', required: true, description: '检索关键字；regex: true 时为正则表达式。' },
      folder: { type: 'string', description: '可选：限定在某个子目录下检索。' },
      limit: { type: 'number', description: '最多返回条数，默认取插件配置 maxResults。' },
      regex: { type: 'boolean', description: '可选：把 query 当正则表达式用（大小写不敏感，除非 case_sensitive: true）。' },
      case_sensitive: { type: 'boolean', description: '可选：区分大小写。默认不区分。' },
      match_all: { type: 'boolean', description: '可选：把 query 按空白拆成多个词，全部词都要命中（AND）。默认整段按一个子串匹配。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; hits: Array<{ path: string; snippet: string }> }
        const lines = v.hits.map((h) => `- ${h.path}\n    ${h.snippet}`)
        return [{ type: 'text', text: `返回 ${v.total} 条命中：\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { query: string; folder?: string; limit?: number; regex?: boolean; case_sensitive?: boolean; match_all?: boolean }
      const q = a.query.trim()
      if (!q) throw new Error('query 不能为空')
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      let notes = await vaultNotes(fs, config, root, exec)
      const folder = a.folder
      if (folder) {
        notes = notes.filter((n) => inFolder(n.path, folder))
      }
      const limit = Math.max(1, Math.min(a.limit ?? config.maxResults, 200))
      const hits = await searchNotes(fs, notes, q, limit, exec.signal, bodyCache, undefined, {
        regex: a.regex,
        caseSensitive: a.case_sensitive,
        matchAll: a.match_all,
      })
      return { total: hits.length, hits }
    },
    presentCall: (args) => ({ card: 'generic', title: `在 vault 搜索“${(args as { query: string }).query}”` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_search_tags',
    description: '按标签检索 Obsidian 笔记：匹配正文内联 #tag（含 #tag/子标签）与 frontmatter 的 tags/tag 属性。查询词命中精确标签或它的任意子标签（如搜 tag 会命中 tag/sub），对应 Obsidian 的 #tag 搜索。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      tag: { type: 'string', required: true, description: '要检索的标签名，不带前导 #（如 tags 或 project/active）。' },
      folder: { type: 'string', description: '可选：限定在某个子目录下检索。' },
      limit: { type: 'number', description: '最多返回条数，默认取插件配置 maxResults。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const v = value as { total: number; hits: Array<{ path: string; tags: string[] }> }
        const lines = v.hits.map((h) => `- ${h.path}\n    #${h.tags.join('  #')}`)
        const tag = (args as { tag?: string }).tag ?? ''
        return [{ type: 'text', text: `返回 ${v.total} 篇带 #${tag} 标签的笔记：\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { tag: string; folder?: string; limit?: number }
      const tag = a.tag.trim()
      if (!tag) throw new Error('tag 不能为空')
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      let notes = await vaultNotes(fs, config, root, exec)
      const folder = a.folder
      if (folder) {
        notes = notes.filter((n) => inFolder(n.path, folder))
      }
      const limit = Math.max(1, Math.min(a.limit ?? config.maxResults, 200))
      const hits = await findNotesByTag(fs, notes, tag, limit, exec.signal, bodyCache)
      return { total: hits.length, hits }
    },
    presentCall: (args) => ({ card: 'generic', title: `搜索 #${(args as { tag: string }).tag} 标签` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_read_note',
    description: '读取 Obsidian vault 里一篇 Markdown 笔记的内容，可按行切片（offset 从 1 起，limit 限制行数，适合大文件）。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
      offset: { type: 'number', description: '可选：从第几行开始返回（1 起，默认 1）。' },
      limit: { type: 'number', description: '可选：最多返回的行数；默认返回全文。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
          bytes: { type: 'number' },
          totalLines: { type: 'number' },
          from: { type: 'number' },
          to: { type: 'number' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; content: string; totalLines?: number; from?: number; to?: number; truncated?: boolean }
        const note = v.truncated ? `第 ${v.from}–${v.to} 行 / 共 ${v.totalLines} 行（已截断）` : undefined
        const prefix = note ? `<!-- ${note} -->\n` : ''
        return [{ type: 'text', text: `${prefix}<note path="${v.path}">\n${v.content}\n</note>` }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string; offset?: number; limit?: number }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const content = await fs.readText(target, exec.signal)
        const lines = content.split('\n')
        const totalLines = lines.length
        const offset = Math.max(1, Math.floor(a.offset ?? 1))
        const rawStart = offset - 1
        let from: number
        let to: number
        let sliced: string
        let truncated: boolean
        if (rawStart >= totalLines) {
          // Past EOF: an empty window anchored at the last line, so `from`/`to`
          // stay consistent instead of reporting `from > to`.
          from = totalLines
          to = totalLines
          sliced = ''
          truncated = false
        } else {
          const limit = a.limit && a.limit > 0 ? Math.floor(a.limit) : undefined
          const end = limit !== undefined ? Math.min(totalLines, rawStart + limit) : totalLines
          sliced = lines.slice(rawStart, end).join('\n')
          from = offset
          to = end
          truncated = end < totalLines
        }
        const result: {
          path: string; content: string; bytes?: number;
          totalLines: number; from: number; to: number; truncated: boolean;
        } = {
          path: rel,
          content: sliced,
          totalLines,
          from,
          to,
          truncated,
        }
        if (info.size !== undefined) result.bytes = info.size
        return result
      } catch (err) {
        throw new Error(`读取失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `读取笔记 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_create_note',
    description: '在 Obsidian vault 里新建或覆盖一篇 Markdown 笔记，用 ctx.fs 的版本守卫做并发安全写入。unique: true 时像 Obsidian 一样在重名时自动追加“ 1”“ 2”后缀生成唯一文件名。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀；父目录不存在会自动创建。' },
      content: { type: 'string', required: true, description: '完整的 Markdown 正文。' },
      overwrite: { type: 'boolean', description: '为 true 时覆盖已存在的笔记；默认 false（已存在则报错）。' },
      unique: { type: 'boolean', description: '为 true 时若路径已存在，自动生成唯一名（name 1.md、name 2.md…）新建，不覆盖。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['create', 'update'] },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; operation: 'create' | 'update' }
        return [{ type: 'text', text: `${v.operation === 'create' ? '已新建' : '已覆盖'}笔记：${v.path}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string; content: string; overwrite?: boolean; unique?: boolean }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      let rel = noteRelPath(a.path)
      let target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      let info = await fs.stat(target, exec.signal)
      if (info && info.type !== 'file') throw new Error(`路径已存在但不是文件：${rel}`)
      if (info && a.unique) {
        // Obsidian-style unique naming: `name 1.md`, `name 2.md`, …
        const noExt = rel.replace(/\.md$/, '')
        const dir = dirOf(noExt)
        const base = noExt.split('/').pop() ?? 'name'
        let i = 1
        while (info) {
          rel = dir !== '' ? `${dir}/${base} ${i}.md` : `${base} ${i}.md`
          target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
          info = await fs.stat(target, exec.signal)
          i++
        }
      } else if (info && !a.overwrite) {
        throw new Error(`笔记已存在：${rel}（如需覆盖请传 overwrite: true，或传 unique: true 生成唯一名）`)
      }
      try {
        const intent = info
          ? { kind: 'replaceIfVersion' as const, version: info.version }
          : { kind: 'createIfAbsent' as const }
        const outcome = await fs.writeText(target, a.content, intent, exec.signal)
        emitObserved(ctx, target, outcome.version, exec)
        return { path: rel, operation: outcome.operation }
      } catch (err) {
        const e = err as { code?: string }
        if (e?.code === 'FS_NOT_OBSERVED') {
          throw new Error(`写入失败 ${rel}：文件在检查后被并发创建（createIfAbsent 拒绝覆盖）；如需覆盖请传 overwrite: true 重试`)
        }
        if (e?.code === 'FS_STALE_VERSION') {
          throw new Error(`写入失败 ${rel}：文件在检查后被并发修改（版本不匹配）；请先 vault_read_note 重新读取，再重试`)
        }
        throw new Error(`写入失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `写入笔记 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_edit_note',
    description: '对 Obsidian 笔记做精准的字面替换编辑（对应 DSH 的 edit / Obsidian 的 vault.process）：把 old_string 逐字替换为 new_string，默认要求恰好一次匹配，replace_all: true 时替换全部。带版本守卫，避免并发覆盖。适合小范围修改；大改请用 vault_create_note 整体重写。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
      old_string: { type: 'string', required: true, description: '要替换的原文，必须逐字精确匹配（含换行时按文件实际内容写）。' },
      new_string: { type: 'string', required: true, description: '替换后的文本；传空字符串表示删除匹配到的文本。' },
      replace_all: { type: 'boolean', description: '为 true 时替换所有匹配；默认 false（出现多次则报错，提示提供更长上下文）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
          matches: { type: 'number', required: true },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; before: string; after: string; matches: number }
        if (v.before === v.after) {
          return [{ type: 'text', text: `${v.path}：替换了 ${v.matches} 处匹配（内容未变化）` }]
        }
        const preview = (s: string) => (s.length > 300 ? s.slice(0, 300) + '…' : s)
        return [{
          type: 'text',
          text: `${v.path}：替换了 ${v.matches} 处匹配\n--- before ---\n${preview(v.before)}\n--- after ---\n${preview(v.after)}`,
        }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string; old_string: string; new_string: string; replace_all?: boolean }
      if (a.old_string === '') throw new Error('old_string 不能为空')
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const outcome = await fs.editText(
          target,
          { oldString: a.old_string, newString: a.new_string, replaceAll: Boolean(a.replace_all) },
          { version: info.version },
          exec.signal,
        )
        emitObserved(ctx, target, outcome.version, exec)
        // before/after 是后端 LF 归一化后的 diff basis；old_string 里的 CRLF
        // 也按同一规则归一化再计数，避免 CRLF 文件上匹配数被算成 0。
        const matches = outcome.before.split(a.old_string.replaceAll('\r\n', '\n')).length - 1
        return { path: rel, before: outcome.before, after: outcome.after, matches }
      } catch (err) {
        const e = err as { code?: string }
        if (e?.code === 'FS_AMBIGUOUS_EDIT') {
          throw new Error(`old_string 在 ${rel} 中出现多次（默认只允许一次精确替换）；请提供更长上下文，或设 replace_all: true`)
        }
        if (e?.code === 'FS_EDIT_NOT_FOUND') {
          throw new Error(`在 ${rel} 中未找到与 old_string 精确匹配的文本；编辑按字面匹配，请先 vault_read_note 核对原文（注意换行与首尾空白）`)
        }
        if (e?.code === 'FS_STALE_VERSION') {
          throw new Error(`编辑失败 ${rel}：文件已被并发修改（版本不匹配）；请先 vault_read_note 重新读取，再重试编辑`)
        }
        if (e?.code === 'FS_NOT_OBSERVED') {
          throw new Error(`编辑失败 ${rel}：本会话尚未读过该文件；请先 vault_read_note 再编辑`)
        }
        throw new Error(`编辑失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `编辑笔记 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_append_note',
    description: '向 Obsidian 笔记末尾追加文本（对应 Obsidian 的 vault.append），带版本守卫避免并发丢失。若原文不以换行结尾，会自动补一个换行再接追加内容。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
      content: { type: 'string', required: true, description: '要追加的文本（如需换行请自带 \\n）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          operation: { type: 'string', required: true, enum: ['append'] },
          addedChars: { type: 'number', required: true },
          bytes: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; addedChars: number; bytes?: number }
        return [{ type: 'text', text: `已向 ${v.path} 追加 ${v.addedChars} 字符${v.bytes !== undefined ? `（现 ${v.bytes} B）` : ''}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string; content: string }
      if (a.content === '') throw new Error('content 不能为空')
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}（如需新建请用 vault_create_note）`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const text = await fs.readText(target, exec.signal)
        const glued = text === '' || text.endsWith('\n') || a.content.startsWith('\n')
          ? text + a.content
          : text + '\n' + a.content
        const outcome = await fs.writeText(target, glued, { kind: 'replaceIfVersion', version: info.version }, exec.signal)
        emitObserved(ctx, target, outcome.version, exec)
        return {
          path: rel,
          operation: 'append' as const,
          addedChars: a.content.length,
          // 真实字节数（UTF-8），而不是 JS 字符串的 UTF-16 长度
          bytes: Buffer.byteLength(outcome.after, 'utf8'),
        }
      } catch (err) {
        const e = err as { code?: string }
        if (e?.code === 'FS_STALE_VERSION') {
          throw new Error(`追加失败 ${rel}：文件已被并发修改（版本不匹配）；请先 vault_read_note 重新读取，再重试`)
        }
        if (e?.code === 'FS_NOT_OBSERVED') {
          throw new Error(`追加失败 ${rel}：本会话尚未读过该文件；请先 vault_read_note 再追加`)
        }
        throw new Error(`追加失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `追加内容到 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_backlinks',
    description: '找出 vault 里所有链接到指定笔记的笔记，即反向链接（同 Obsidian 的反向链接面板）。默认统计 [[wikilink]]；format: markdown 时统计 [text](path) 形式（相对/根相对路径），format: all 时两种都算。库中有同名笔记时传 path 精确指定目标。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      title: { type: 'string', required: true, description: '目标笔记的文件名（不含 .md 后缀，也不含路径）。' },
      path: { type: 'string', description: '可选：目标笔记的 vault 相对路径（/ 分隔，可省略 .md）。提供时只统计精确解析到该笔记的链接，避免同名笔记混淆。' },
      format: { type: 'string', description: '可选：统计的链接语法，wikilink（默认）| markdown | all。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          backlinks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
          target: { type: 'string' },
          ambiguous: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; backlinks: Array<{ path: string; snippet: string }>; target?: string; ambiguous?: boolean }
        const lines = v.backlinks.map((b) => `- ${b.path}\n    ${b.snippet}`)
        const head = v.ambiguous
          ? `找到 ${v.total} 个反向链接（目标 ${v.target}；库里存在同名笔记，本结果按文件名匹配，可用 path 参数精确指定）：`
          : v.target
            ? `找到 ${v.total} 个反向链接（目标 ${v.target}）：`
            : `找到 ${v.total} 个反向链接：`
        return [{ type: 'text', text: `${head}\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { title: string; path?: string; format?: string }
      const title = a.title.trim()
      if (!title) throw new Error('title 不能为空')
      const format: BacklinkFormat = a.format === 'markdown' ? 'markdown' : a.format === 'all' ? 'all' : 'wikilink'
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const notes = await vaultNotes(fs, config, root, exec)
      let targetPath: string | undefined
      let ambiguous = false
      if (a.path && a.path.trim()) {
        const rel = noteRelPath(a.path)
        const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
        const info = await fs.stat(target, exec.signal)
        if (!info) throw new Error(`笔记不存在：${rel}`)
        if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
        targetPath = rel.replace(/\.md$/, '')
      } else {
        const candidates = notes.filter((n) => stemOf(n.path).toLowerCase() === title.toLowerCase())
        ambiguous = candidates.length > 1
        if (candidates.length > 0) {
          candidates.sort((x, y) => x.path.length - y.path.length || x.path.localeCompare(y.path))
          targetPath = candidates[0].path.replace(/\.md$/, '')
        }
      }
      const backlinks = targetPath
        ? await findBacklinks(fs, notes, { path: targetPath }, exec.signal, bodyCache, undefined, format)
        : await findBacklinks(fs, notes, { title }, exec.signal, bodyCache, undefined, format)
      return {
        total: backlinks.length,
        backlinks,
        ...(targetPath ? { target: targetPath, ambiguous } : {}),
      }
    },
    presentCall: (args) => {
      const a = args as { title: string; path?: string }
      return { card: 'generic', title: a?.path ? `查找 [[${a.title}]] 的反向链接（精确路径）` : `查找 [[${a.title}]] 的反向链接` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vault_frontmatter',
    description: '读取笔记的 YAML frontmatter（Obsidian 的 Properties），返回结构化字段与格式校验结果；无 frontmatter 时 present=false。修改字段用 vault_update_frontmatter。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          present: { type: 'boolean', required: true },
          valid: { type: 'boolean', required: true },
          fields: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                value: { type: 'string', required: true },
              },
            },
          },
          issues: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; present: boolean; valid: boolean; fields: Array<{ key: string; value: string }>; issues: string[] }
        if (!v.present) return [{ type: 'text', text: `${v.path} 没有 frontmatter（不以 --- 开头）` }]
        const head = v.valid ? 'frontmatter 格式正常' : 'frontmatter 存在问题'
        const fields = v.fields.map((f) => `- ${f.key}: ${f.value}`).join('\n') || '(空)'
        const issues = v.issues.length ? `\n问题：\n${v.issues.map((i) => `- ${i}`).join('\n')}` : ''
        return [{ type: 'text', text: `${v.path}：${head}${issues}\n字段：\n${fields}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const content = await fs.readText(target, exec.signal)
        const parsed = parseFrontmatter(content)
        return { path: rel, present: parsed.present, valid: parsed.valid, fields: parsed.fields, issues: parsed.issues }
      } catch (err) {
        throw new Error(`读取失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `读取 frontmatter ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_update_frontmatter',
    description: '修改笔记的 frontmatter（Obsidian Properties）：set 设置/覆盖字段，delete 删除字段。没有 frontmatter 时 set 会自动创建（对应 Obsidian 为笔记添加 Properties）；保留其余字段顺序与正文。值必须是单行 YAML 标量，列表用内联数组如 [a, b]。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
      set: { type: 'object', additionalProperties: true, description: '可选：要设置/覆盖的字段，值为字符串（如 {tags: "[读书, 笔记]", status: "done"}）。' },
      delete: { type: 'array', items: { type: 'string' }, description: '可选：要删除的字段名列表（含其块列表）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
          changes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                op: { type: 'string', required: true, enum: ['set', 'delete'] },
                key: { type: 'string', required: true },
                value: { type: 'string' },
              },
            },
          },
          before: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                value: { type: 'string', required: true },
              },
            },
          },
          after: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                value: { type: 'string', required: true },
              },
            },
          },
          issues: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const v = value as {
          path: string; created: boolean; changes: Array<{ op: 'set' | 'delete'; key: string; value?: string }>;
          issues: string[]
        }
        const lines = v.changes.map((c) => `- ${c.op === 'set' ? '设置' : '删除'} ${c.key}${c.value !== undefined ? ` = ${c.value}` : ''}`)
        const head = v.created ? `${v.path}：已创建 frontmatter` : `${v.path}：已更新 frontmatter`
        const issues = v.issues.length ? `\n注意：\n${v.issues.map((i) => `- ${i}`).join('\n')}` : ''
        return [{ type: 'text', text: `${head}\n${lines.join('\n') || '(无变更)'}${issues}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string; set?: Record<string, unknown>; delete?: string[] }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      const set: Record<string, string> = {}
      for (const [k, v] of Object.entries(a.set ?? {})) {
        const key = k.trim()
        if (key === '' || !/^[^:#][^:]*$/.test(key)) {
          throw new Error(`无效的 frontmatter 字段名：${k}`)
        }
        set[key] = typeof v === 'string' ? v : JSON.stringify(v)
      }
      const del = (a.delete ?? []).map((k) => k.trim()).filter((k) => k.length > 0)
      if (Object.keys(set).length === 0 && del.length === 0) {
        throw new Error('set 与 delete 至少提供其一')
      }
      try {
        const content = await fs.readText(target, exec.signal)
        const before = parseFrontmatter(content)
        const applied = applyFrontmatterUpdate(content, set, del)
        const outcome = await fs.writeText(target, applied.text, { kind: 'replaceIfVersion', version: info.version }, exec.signal)
        emitObserved(ctx, target, outcome.version, exec)
        const after = parseFrontmatter(applied.text)
        return {
          path: rel,
          created: applied.created,
          changes: applied.changes,
          before: before.fields,
          after: after.fields,
          issues: after.issues,
        }
      } catch (err) {
        const e = err as { code?: string }
        if (e?.code === 'FS_STALE_VERSION') {
          throw new Error(`更新 frontmatter 失败 ${rel}：文件已被并发修改（版本不匹配）；请先 vault_read_note 重新读取，再重试`)
        }
        if (e?.code === 'FS_NOT_OBSERVED') {
          throw new Error(`更新 frontmatter 失败 ${rel}：本会话尚未读过该文件；请先 vault_read_note 再修改`)
        }
        if (err instanceof Error && err.message.includes('frontmatter')) throw err
        throw new Error(`更新 frontmatter 失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `更新 frontmatter ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_note_links',
    description: '列出笔记中所有 [[wikilink]] 出链（去重，含嵌入 ![[...]]），返回链接目标、锚点、别名与是否嵌入。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          total: { type: 'number', required: true },
          links: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                target: { type: 'string', required: true },
                stem: { type: 'string', required: true },
                anchor: { type: 'string' },
                alias: { type: 'string' },
                embedded: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; total: number; links: Array<{ target: string; embedded: boolean }> }
        const lines = v.links.map((l) => `- ${l.embedded ? '!' : ''}[[${l.target}]]`)
        return [{ type: 'text', text: `${v.path} 共 ${v.total} 个出链：\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const content = await fs.readText(target, exec.signal)
        const links = extractLinks(content)
        return { path: rel, total: links.length, links }
      } catch (err) {
        throw new Error(`读取失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `列出出链 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_note_info',
    description: '返回笔记的综合元信息（只读）：字节数、frontmatter 概况、标签（内联 #tag + frontmatter tags）、别名（frontmatter aliases）、出链统计（wikilink/嵌入/markdown/未解析）与反向链接数量。类似 Dataview 的单篇概览。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number' },
          frontmatter: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              present: { type: 'boolean', required: true },
              valid: { type: 'boolean', required: true },
              fields: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          aliases: { type: 'array', required: true, items: { type: 'string' } },
          links: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              wikilinks: { type: 'number', required: true },
              embeds: { type: 'number', required: true },
              markdown: { type: 'number', required: true },
              unresolved: { type: 'number', required: true },
              total: { type: 'number', required: true },
            },
          },
          backlinks: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              total: { type: 'number', required: true },
              paths: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as {
          path: string; bytes?: number;
          frontmatter: { present: boolean; valid: boolean; fields: string[] };
          tags: string[]; aliases: string[];
          links: { wikilinks: number; embeds: number; markdown: number; unresolved: number; total: number };
          backlinks: { total: number; paths: string[] }
        }
        const fm = v.frontmatter.present ? `${v.frontmatter.fields.length} 个字段${v.frontmatter.valid ? '' : '（格式有问题）'}` : '无'
        const lines = [
          `${v.path}${v.bytes !== undefined ? `（${v.bytes} B）` : ''}`,
          `frontmatter: ${fm}`,
          `标签: ${v.tags.length ? v.tags.map((t) => `#${t}`).join(' ') : '无'}`,
          `别名: ${v.aliases.length ? v.aliases.join(', ') : '无'}`,
          `出链: wikilink ${v.links.wikilinks} / 嵌入 ${v.links.embeds} / markdown ${v.links.markdown} / 未解析 ${v.links.unresolved}（共 ${v.links.total}）`,
          `反向链接: ${v.backlinks.total}${v.backlinks.paths.length ? `（${v.backlinks.paths.slice(0, 5).join(', ')}${v.backlinks.paths.length > 5 ? '…' : ''}）` : ''}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await resolveNoteTarget(fs, root, rel, config.allowSymlinkEscape)
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const content = await fs.readText(target, exec.signal)
        const fm = parseFrontmatter(content)
        const tags = extractTags(content)
        const aliases = fm.fields
          .filter((f) => f.key.toLowerCase() === 'aliases')
          .flatMap((f) => splitListValue(f.value))
        const notes = await vaultNotes(fs, config, root, exec)
        const resolver = buildLinkResolver(notes)
        const noteDir = dirOf(rel)
        let wikilinks = 0
        let embeds = 0
        let unresolved = 0
        for (const link of extractLinks(content)) {
          if (link.embedded) embeds++
          else wikilinks++
          if (!resolveLinkTarget(resolver, link.target, link.stem)) unresolved++
        }
        const mdLinks = extractMarkdownLinks(content)
        let markdown = 0
        for (const md of mdLinks) {
          markdown++
          if (!resolveMarkdownTarget(md.target, noteDir, resolver)) unresolved++
        }
        const backlinkHits = await findBacklinks(fs, notes, { path: rel }, exec.signal, bodyCache, undefined, 'all')
        const result: {
          path: string; bytes?: number;
          frontmatter: { present: boolean; valid: boolean; fields: string[] };
          tags: string[]; aliases: string[];
          links: { wikilinks: number; embeds: number; markdown: number; unresolved: number; total: number };
          backlinks: { total: number; paths: string[] }
        } = {
          path: rel,
          frontmatter: { present: fm.present, valid: fm.valid, fields: fm.fields.map((f) => f.key) },
          tags,
          aliases,
          links: { wikilinks, embeds, markdown, unresolved, total: wikilinks + embeds + markdown },
          backlinks: { total: backlinkHits.length, paths: backlinkHits.slice(0, 10).map((h) => h.path) },
        }
        if (info.size !== undefined) result.bytes = info.size
        return result
      } catch (err) {
        throw new Error(`读取失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `笔记信息 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_list_folders',
    description: '递归列出 Obsidian vault 的全部文件夹及各自直接包含的 .md 笔记数（含空文件夹，同 Obsidian 文件树侧栏的计数）。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      folder: { type: 'string', description: '可选：只列该文件夹及其子文件夹。' },
      limit: { type: 'number', description: '最多返回条数，默认 100。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          folders: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                notes: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; folders: Array<{ path: string; notes: number }> }
        const lines = v.folders.map((f) => `- ${f.path === '' ? '.' : f.path}（${f.notes} 篇）`)
        return [{ type: 'text', text: `共 ${v.total} 个文件夹：\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { folder?: string; limit?: number }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rootTarget = await fs.resolve(root, { cwd: root })
      let folders = await listFolders(fs, rootTarget, config.ignoreDirs, exec.signal, !config.allowSymlinkEscape)
      const folder = a.folder?.trim()
      if (folder) {
        const prefix = folder.replace(/^\/+/, '').replace(/\/+$/, '')
        folders = folders.filter((f) => f.path === prefix || f.path.startsWith(prefix + '/'))
      }
      const limit = Math.max(1, Math.min(a.limit ?? 100, 1000))
      const sliced = folders.slice(0, limit)
      return { total: folders.length, folders: sliced }
    },
    presentCall: (args) => {
      const a = args as { folder?: string }
      return { card: 'generic', title: a?.folder ? `列出 vault/${a.folder} 的文件夹` : '列出 vault 全部文件夹' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vault_rename_note',
    description: '重命名或移动一篇笔记，并自动更新全库指向它的引用：[[wikilink]]（含嵌入、带路径的链接、frontmatter 里的链接与笔记自身引用）和 [text](path) markdown 链接（同 Obsidian 的“自动更新内部链接”）。keep_old 控制旧文件：keep（默认，保留原内容）或 stub（把旧文件替换为指向新位置的跳转占位）。写前先预检（只读），新文件用 createIfAbsent 守卫创建，引用更新用版本守卫写入。ctx.fs 无删除原语，无法真正删除旧文件；如需彻底删除请用 bash 清理。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      old_path: { type: 'string', required: true, description: '当前笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
      new_path: { type: 'string', required: true, description: '目标笔记的 vault 相对路径，可跨目录移动，可省略 .md 后缀。' },
      keep_old: { type: 'string', description: '可选：keep（默认，旧文件保留原内容）| stub（旧文件替换为指向新路径的跳转占位）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          old_path: { type: 'string', required: true },
          new_path: { type: 'string', required: true },
          totalLinks: { type: 'number', required: true },
          updated: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                count: { type: 'number', required: true },
              },
            },
          },
          old_handling: { type: 'string', required: true, enum: ['kept', 'stubbed'] },
        },
      },
      render: (_args, value) => {
        const v = value as {
          old_path: string; new_path: string; totalLinks: number;
          updated: Array<{ path: string; count: number }>; old_handling: 'kept' | 'stubbed'
        }
        const lines = v.updated.map((u) => `- ${u.path}（改写 ${u.count} 处）`)
        const tail = v.old_handling === 'stubbed'
          ? `旧文件 ${v.old_path} 已替换为跳转占位（如需彻底删除请用 bash 清理）。`
          : `旧文件仍保留在原路径 ${v.old_path}（如需删除请用 bash 清理）。`
        return [{
          type: 'text',
          text: `已将 ${v.old_path} 重命名为 ${v.new_path}，共改写 ${v.totalLinks} 处引用：\n${lines.length ? lines.join('\n') : '(无引用需更新)'}\n${tail}`,
        }]
      },
    },
    async execute(args, exec) {
      const a = args as { old_path: string; new_path: string; keep_old?: string }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const oldRel = noteRelPath(a.old_path)
      const newRel = noteRelPath(a.new_path)
      if (oldRel === newRel) throw new Error('新旧路径相同，无需重命名')
      const keepOld = a.keep_old === 'stub' ? 'stub' : 'keep'
      if (a.keep_old === 'delete') {
        throw new Error('ctx.fs 无删除原语，无法真正删除旧文件；可选 keep_old: "stub" 把旧文件替换为跳转占位，或重命名后用 bash 清理旧文件')
      }
      const rootTarget = await fs.resolve(root, { cwd: root })
      const oldTarget = await resolveNoteTarget(fs, root, oldRel, config.allowSymlinkEscape)
      const newTarget = await resolveNoteTarget(fs, root, newRel, config.allowSymlinkEscape)
      const oldInfo = await fs.stat(oldTarget, exec.signal)
      if (!oldInfo) throw new Error(`笔记不存在：${oldRel}`)
      if (oldInfo.type !== 'file') throw new Error(`路径不是文件：${oldRel}`)
      const newInfo = await fs.stat(newTarget, exec.signal)
      if (newInfo) throw new Error(`目标已存在：${newRel}`)
      let content: string
      try {
        content = await fs.readText(oldTarget, exec.signal)
      } catch (err) {
        throw new Error(`读取失败 ${oldRel}：${errorLabel(err)}`)
      }
      const oldRelNoExt = oldRel.replace(/\.md$/, '')
      const newRelNoExt = newRel.replace(/\.md$/, '')
      const oldStem = stemOf(oldRel)
      const newStem = stemOf(newRel)
      // 0) 预检阶段：只读不写。并行读完所有待扫描的笔记并算好改写内容，
      //    任何读失败都在产生任何修改之前终止，避免半完成的重命名。
      const notes = await vaultNotes(fs, config, root, exec)
      const resolver = buildLinkResolver(notes)
      const scanned = await mapLimit(notes.filter((n) => n.path !== oldRel), 8, async (note) => {
        let info: FsInfo | undefined
        try {
          info = await fs.stat(note.target, exec.signal)
        } catch (err) {
          throw new Error(`预检失败 ${note.path}：${errorLabel(err)}（尚未做任何修改）`)
        }
        if (!info || info.type !== 'file') return null
        let body: string
        try {
          body = await fs.readText(note.target, exec.signal)
        } catch (err) {
          throw new Error(`预检读取失败 ${note.path}：${errorLabel(err)}（尚未做任何修改）`)
        }
        return { note, info, body }
      })
      // frontmatter aliases 参与链接解析：[[别名]] 指向旧笔记的引用也要改写。
      indexAliases(resolver, scanned.flatMap((s) => s ? [{ path: s.note.path, body: s.body }] : []))
      // 笔记自身的自引用（[[old]] / [[别名]] / [x](old.md) 指向自己）也要改写到新位置。
      const selfWl = rewriteWikilinks(content, newStem, newRel, resolver, oldRelNoExt)
      const selfMd = rewriteMarkdownLinks(selfWl.text, newRel, resolver, oldRelNoExt, dirOf(newRel))
      const newContent = selfMd.text
      const selfCount = selfWl.count + selfMd.count
      const planned: Array<{ note: VaultNote; info: FsInfo; original: string; text: string; count: number }> = []
      for (const s of scanned) {
        if (!s) continue
        const wl = rewriteWikilinks(s.body, newStem, newRel, resolver, oldRelNoExt)
        const md = rewriteMarkdownLinks(wl.text, newRel, resolver, oldRelNoExt, dirOf(s.note.path))
        if (wl.count + md.count === 0) continue
        planned.push({ note: s.note, info: s.info, original: s.body, text: md.text, count: wl.count + md.count })
      }
      // 1) 先改写全库引用（guarded replace，可回滚）：任何失败都逆序回滚已写
      //    文件。新文件此时尚未创建，回滚后无任何残留。
      const updated: Array<{ path: string; count: number }> = []
      let totalLinks = 0
      let committed = 0
      try {
        for (const { note, info, text, count } of planned) {
          try {
            const outcome = await fs.writeText(note.target, text, { kind: 'replaceIfVersion', version: info.version }, exec.signal)
            emitObserved(ctx, note.target, outcome.version, exec)
          } catch (err) {
            const e = err as { code?: string }
            const reason = e?.code === 'FS_STALE_VERSION' ? '文件被并发修改（版本不匹配）' : errorLabel(err)
            throw new Error(`更新引用失败 ${note.path}（${reason}）`)
          }
          committed++
          updated.push({ path: note.path, count })
          totalLinks += count
        }
      } catch (err) {
        const rollbackErrors = await rollbackRewrites(ctx, fs, planned, committed, exec)
        const base = err instanceof Error ? err.message : String(err)
        if (rollbackErrors.length === 0) {
          throw new Error(`${base}；已自动回滚全部 ${committed} 处引用改写，未留下任何修改。`)
        }
        throw new Error(`${base}；已尝试回滚 ${committed} 处引用改写，但以下文件回滚失败（请检查）：${rollbackErrors.join('；')}`)
      }
      // 2) 创建新文件（guarded create），内容含自引用改写。此时再失败会把
      //    引用改写回滚掉，依旧不留残留。
      try {
        const outcome = await fs.writeText(newTarget, newContent, { kind: 'createIfAbsent' }, exec.signal)
        emitObserved(ctx, newTarget, outcome.version, exec)
      } catch (err) {
        const rollbackErrors = await rollbackRewrites(ctx, fs, planned, planned.length, exec)
        const base = `创建 ${newRel} 失败：${errorLabel(err)}`
        if (rollbackErrors.length === 0) {
          throw new Error(`${base}；已回滚全部 ${planned.length} 处引用改写，未留下任何修改。`)
        }
        throw new Error(`${base}；已尝试回滚引用改写，但以下文件回滚失败（请检查）：${rollbackErrors.join('；')}`)
      }
      if (selfCount > 0) {
        updated.unshift({ path: newRel, count: selfCount })
        totalLinks += selfCount
      }
      // 3) Optionally turn the old file into a redirect stub.
      let oldHandling: 'kept' | 'stubbed' = 'kept'
      if (keepOld === 'stub') {
        const stub = `---\nmoved: true\n---\n\n> 此笔记已移至 [[${newRelNoExt}]]。\n\n（原路径保留为跳转占位；如需彻底删除请用 bash 清理。）\n`
        try {
          const outcome = await fs.writeText(oldTarget, stub, { kind: 'replaceIfVersion', version: oldInfo.version }, exec.signal)
          emitObserved(ctx, oldTarget, outcome.version, exec)
          oldHandling = 'stubbed'
        } catch (err) {
          throw new Error(`写跳转占位失败 ${oldRel}：${errorLabel(err)}。重命名本身已完成（新文件 ${newRel} 已创建、引用已更新），仅旧文件内容未变。`)
        }
      }
      return { old_path: oldRel, new_path: newRel, totalLinks, updated, old_handling: oldHandling }
    },
    presentCall: (args) => {
      const a = args as { old_path: string; new_path: string }
      return { card: 'generic', title: `重命名 ${a.old_path} → ${a.new_path}` }
    },
  }))
}
