import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import path from 'node:path'
import type { VaultConfig } from './config.js'
import {
  walkNotes, searchNotes, findBacklinks, extractLinks, parseFrontmatter,
  rewriteWikilinks, joinRel, createBodyCache, discoverVaults,
} from './vault.js'

/** Read the stable `code` off a thrown `FsError` (or fall back to the message). */
function errorLabel(err: unknown): string {
  const e = err as { code?: string; message?: string } | null
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    return `[${e.code}] ${e.message ?? ''}`
  }
  return err instanceof Error ? err.message : String(err)
}

/** Loose view of `ToolRunContext` for reading the calling session's cwd. */
interface CwdExec {
  agent?: { session?: { header?: { cwd?: string } } }
}

/**
 * Resolve which vault root one call operates on. Order: the call's `vault`
 * argument (matched by name or path) → a pinned `config.vaultRoot` → the
 * session workspace when it is a discovered vault → the vault currently open
 * in Obsidian → the session workspace → `process.cwd()`.
 */
async function resolveVaultRoot(
  config: VaultConfig,
  exec: CwdExec,
  vaultArg?: string,
): Promise<string> {
  const discovered = config.discoverVaults ? await discoverVaults() : []
  const roots = [...(config.vaultRoots ?? []), ...discovered.map((v) => v.path)]
  const norm = (p: string) => p.replace(/\/+$/, '')
  if (vaultArg && vaultArg.trim().length > 0) {
    const target = vaultArg.trim()
    const byPath = roots.find((r) => norm(r) === norm(target))
    if (byPath) return norm(byPath)
    const byName = discovered.find((v) => v.name === target)
    if (byName) return norm(byName.path)
    const looksAbsolute = target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
    if (!looksAbsolute) throw new Error(`未知的 Obsidian 库：${target}（可用 vault_list_vaults 查看，或传绝对路径）`)
    return norm(target)
  }
  if (config.vaultRoot && config.vaultRoot.length > 0) return norm(config.vaultRoot)
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const hit = discovered.find((v) => norm(v.path) === norm(cwd))
    if (hit) return norm(hit.path)
  }
  const openVault = discovered.find((v) => v.open)
  if (openVault) return norm(openVault.path)
  if (typeof cwd === 'string' && cwd.length > 0) return norm(cwd)
  return norm(process.cwd())
}

/**
 * Normalize a user-supplied note path to a vault-relative `dir/name.md`.
 * Rejects empty input and `..` segments so a path can never escape the vault.
 */
function noteRelPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('笔记路径不能为空')
  const noLeading = trimmed.replace(/^\/+/, '')
  if (noLeading.split('/').includes('..')) {
    throw new Error(`笔记路径不能包含 .. 段：${trimmed}`)
  }
  return noLeading.replace(/\.md$/, '') + '.md'
}

/** Filter notes to those inside exactly `folder` (not a prefix lookalike). */
function inFolder(path: string, folder: string): boolean {
  const prefix = folder.replace(/^\/+/, '').replace(/\/+$/, '')
  if (prefix === '') return true
  return path === prefix || path.startsWith(prefix + '/')
}

export function registerTools(ctx: Context, config: VaultConfig): void {
  const fs = ctx.fs
  // Shared per-session body cache: validated by fs.stat version, so repeated
  // search / backlink queries re-read only files that actually changed.
  const bodyCache = createBodyCache()

  ctx.tools.register(defineTool({
    name: 'vault_list_vaults',
    description: '列出本机所有已注册的 Obsidian 库（读 Obsidian 全局配置自动发现），返回库名、路径与当前打开状态。',
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
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; vaults: Array<{ name: string; path: string; open?: boolean }> }
        const lines = v.vaults.map((x) => `- ${x.name}  ${x.open ? '（当前打开）' : ''}\n    ${x.path}`)
        return [{ type: 'text', text: `发现 ${v.total} 个 Obsidian 库：\n${lines.length ? lines.join('\n') : '(未发现，将回退到会话工作目录)'}` }]
      },
    },
    async execute() {
      const vaults = await discoverVaults()
      return {
        total: vaults.length,
        vaults: vaults.map((v) => (v.open ? { name: v.name, path: v.path, open: true } : { name: v.name, path: v.path })),
      }
    },
    presentCall: () => ({ card: 'generic', title: '列出本机全部 Obsidian 库' }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_list_notes',
    description: '递归列出 Obsidian vault 里的全部 .md 笔记，返回 vault 根目录的相对路径（/ 分隔）与字节大小。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      folder: { type: 'string', description: '可选：只列该子目录下的笔记（vault 相对路径，/ 分隔）。' },
      limit: { type: 'number', description: '最多返回条数，默认 100。' },
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
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; notes: Array<{ path: string; size?: number }> }
        const lines = v.notes.map((n) => `- ${n.path}${n.size !== undefined ? `  (${n.size} B)` : ''}`)
        return [{ type: 'text', text: `共 ${v.total} 篇笔记：\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { folder?: string; limit?: number }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rootTarget = await fs.resolve(root, { cwd: root })
      let notes = await walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal)
      const folder = a.folder
      if (folder) {
        notes = notes.filter((n) => inFolder(n.path, folder))
      }
      const limit = Math.max(1, Math.min(a.limit ?? 100, 1000))
      const sliced = notes.slice(0, limit)
      return {
        total: notes.length,
        notes: sliced.map((n) => (n.size !== undefined ? { path: n.path, size: n.size } : { path: n.path })),
      }
    },
    presentCall: (args) => {
      const a = args as { folder?: string }
      return { card: 'generic', title: a?.folder ? `列出 vault/${a.folder}` : '列出 vault 全部笔记' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vault_search',
    description: '在 Obsidian vault 里做大小写不敏感的关键字检索，匹配笔记文件名与正文，返回笔记路径与命中片段。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      query: { type: 'string', required: true, description: '要检索的关键字（纯文本，非正则）。' },
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
      const a = args as { query: string; folder?: string; limit?: number }
      const q = a.query.trim()
      if (!q) throw new Error('query 不能为空')
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rootTarget = await fs.resolve(root, { cwd: root })
      let notes = await walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal)
      const folder = a.folder
      if (folder) {
        notes = notes.filter((n) => inFolder(n.path, folder))
      }
      const limit = Math.max(1, Math.min(a.limit ?? config.maxResults, 200))
      const hits = await searchNotes(fs, notes, q, limit, exec.signal, bodyCache)
      return { total: hits.length, hits }
    },
    presentCall: (args) => ({ card: 'generic', title: `在 vault 搜索“${(args as { query: string }).query}”` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_read_note',
    description: '读取 Obsidian vault 里一篇 Markdown 笔记的完整内容。',
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
          content: { type: 'string', required: true },
          bytes: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as { path: string; content: string }
        return [{ type: 'text', text: `<note path="${v.path}">\n${v.content}\n</note>` }]
      },
    },
    async execute(args, exec) {
      const a = args as { path: string }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await fs.resolve(joinRel(root, rel), { cwd: root })
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const content = await fs.readText(target, exec.signal)
        const result: { path: string; content: string; bytes?: number } = { path: rel, content }
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
    description: '在 Obsidian vault 里新建或覆盖一篇 Markdown 笔记，用 ctx.fs 的版本守卫做并发安全写入。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      path: { type: 'string', required: true, description: '笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
      content: { type: 'string', required: true, description: '完整的 Markdown 正文。' },
      overwrite: { type: 'boolean', description: '为 true 时覆盖已存在的笔记；默认 false（已存在则报错）。' },
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
      const a = args as { path: string; content: string; overwrite?: boolean }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rel = noteRelPath(a.path)
      const target = await fs.resolve(joinRel(root, rel), { cwd: root })
      const info = await fs.stat(target, exec.signal)
      if (info && info.type !== 'file') throw new Error(`路径已存在但不是文件：${rel}`)
      if (info && !a.overwrite) throw new Error(`笔记已存在：${rel}（如需覆盖请传 overwrite: true）`)
      try {
        const intent = info
          ? { kind: 'replaceIfVersion' as const, version: info.version }
          : { kind: 'createIfAbsent' as const }
        const outcome = await fs.writeText(target, a.content, intent, exec.signal)
        return { path: rel, operation: outcome.operation }
      } catch (err) {
        throw new Error(`写入失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `写入笔记 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_backlinks',
    description: '找出 vault 里所有通过 [[wikilink]] 链接到指定笔记（按文件名，不含 .md 后缀）的笔记，即反向链接。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      title: { type: 'string', required: true, description: '目标笔记的文件名（不含 .md 后缀，也不含路径）。' },
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
        },
      },
      render: (_args, value) => {
        const v = value as { total: number; backlinks: Array<{ path: string; snippet: string }> }
        const lines = v.backlinks.map((b) => `- ${b.path}\n    ${b.snippet}`)
        return [{ type: 'text', text: `找到 ${v.total} 个反向链接：\n${lines.length ? lines.join('\n') : '(无)'}` }]
      },
    },
    async execute(args, exec) {
      const a = args as { title: string }
      const title = a.title.trim()
      if (!title) throw new Error('title 不能为空')
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const rootTarget = await fs.resolve(root, { cwd: root })
      const notes = await walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal)
      const backlinks = await findBacklinks(fs, notes, title, exec.signal, bodyCache)
      return { total: backlinks.length, backlinks }
    },
    presentCall: (args) => ({ card: 'generic', title: `查找 [[${(args as { title: string }).title}]] 的反向链接` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_frontmatter',
    description: '读取笔记的 YAML frontmatter（Properties），返回结构化字段与格式校验结果；无 frontmatter 时 present=false。',
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
      const target = await fs.resolve(joinRel(root, rel), { cwd: root })
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
      const target = await fs.resolve(joinRel(root, rel), { cwd: root })
      const info = await fs.stat(target, exec.signal)
      if (!info) throw new Error(`笔记不存在：${rel}`)
      if (info.type !== 'file') throw new Error(`路径不是文件：${rel}`)
      try {
        const content = await fs.readText(target, exec.signal)
        return { path: rel, total: extractLinks(content).length, links: extractLinks(content) }
      } catch (err) {
        throw new Error(`读取失败 ${rel}：${errorLabel(err)}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `列出出链 ${(args as { path: string }).path}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_rename_note',
    description: '重命名或移动一篇笔记，并自动更新全库指向它的 [[wikilink]]（含嵌入与带路径的链接）。新文件用 createIfAbsent 守卫创建，引用更新用版本守卫写入。旧文件保留在原路径（fs 服务无删除原语），如需删除请用 bash 清理。',
    parameters: {
      vault: { type: 'string', description: '可选：操作的目标 Obsidian 库（库名或绝对路径）；默认自动解析当前库。' },
      old_path: { type: 'string', required: true, description: '当前笔记的 vault 相对路径，/ 分隔，可省略 .md 后缀。' },
      new_path: { type: 'string', required: true, description: '目标笔记的 vault 相对路径，可跨目录移动，可省略 .md 后缀。' },
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
        },
      },
      render: (_args, value) => {
        const v = value as { old_path: string; new_path: string; totalLinks: number; updated: Array<{ path: string; count: number }> }
        const lines = v.updated.map((u) => `- ${u.path}（改写 ${u.count} 处）`)
        return [{
          type: 'text',
          text: `已将 ${v.old_path} 重命名为 ${v.new_path}，共改写 ${v.totalLinks} 处引用：\n${lines.length ? lines.join('\n') : '(无引用需更新)'}\n提示：旧文件仍保留在原路径，如需删除请用 bash 清理。`,
        }]
      },
    },
    async execute(args, exec) {
      const a = args as { old_path: string; new_path: string }
      const root = await resolveVaultRoot(config, exec as CwdExec, (args as { vault?: string }).vault)
      const oldRel = noteRelPath(a.old_path)
      const newRel = noteRelPath(a.new_path)
      if (oldRel === newRel) throw new Error('新旧路径相同，无需重命名')
      const oldTarget = await fs.resolve(joinRel(root, oldRel), { cwd: root })
      const newTarget = await fs.resolve(joinRel(root, newRel), { cwd: root })
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
      // 1) Create the new note (guarded create).
      try {
        await fs.writeText(newTarget, content, { kind: 'createIfAbsent' }, exec.signal)
      } catch (err) {
        throw new Error(`创建 ${newRel} 失败：${errorLabel(err)}`)
      }
      // 2) Rewrite every reference across the vault (guarded replace).
      const oldStem = oldRel.replace(/\.md$/, '').split('/').pop() ?? oldRel
      const newStem = newRel.replace(/\.md$/, '').split('/').pop() ?? newRel
      const rootTarget = await fs.resolve(root, { cwd: root })
      const notes = await walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal)
      const updated: Array<{ path: string; count: number }> = []
      let totalLinks = 0
      for (const note of notes) {
        if (note.path === oldRel) continue
        let info: Awaited<ReturnType<typeof fs.stat>> | undefined
        let body = ''
        try {
          info = await fs.stat(note.target, exec.signal)
          body = await fs.readText(note.target, exec.signal)
        } catch {
          continue
        }
        if (!info || info.type !== 'file') continue
        const { text, count } = rewriteWikilinks(body, oldStem, newStem, newRel)
        if (count === 0) continue
        try {
          await fs.writeText(note.target, text, { kind: 'replaceIfVersion', version: info.version }, exec.signal)
        } catch (err) {
          throw new Error(
            `更新引用失败 ${note.path}（并发修改？）：${errorLabel(err)}。注意：新文件 ${newRel} 已创建，本次操作可能只完成了一部分，请检查后重试。`,
          )
        }
        updated.push({ path: note.path, count })
        totalLinks += count
      }
      return { old_path: oldRel, new_path: newRel, totalLinks, updated }
    },
    presentCall: (args) => {
      const a = args as { old_path: string; new_path: string }
      return { card: 'generic', title: `重命名 ${a.old_path} → ${a.new_path}` }
    },
  }))
}
