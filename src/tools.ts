import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { VaultConfig } from './config.js'
import { walkNotes, searchNotes, findBacklinks, joinRel } from './vault.js'

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

/** The vault root for one call: config wins, then the session workspace. */
function vaultRootOf(config: VaultConfig, exec: CwdExec): string {
  const configured = config.vaultRoot
  if (configured && configured.length > 0) return configured.replace(/\/+$/, '')
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd.replace(/\/+$/, '')
  return process.cwd()
}

/** Normalize a user-supplied note path to a vault-relative `dir/name.md`. */
function noteRelPath(input: string): string {
  return input.replace(/^\/+/, '').replace(/\.md$/, '') + '.md'
}

export function registerTools(ctx: Context, config: VaultConfig): void {
  const fs = ctx.fs

  ctx.tools.register(defineTool({
    name: 'vault_list_notes',
    description: '递归列出 Obsidian vault 里的全部 .md 笔记，返回 vault 根目录的相对路径（/ 分隔）与字节大小。',
    parameters: {
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
      const root = vaultRootOf(config, exec as CwdExec)
      const rootTarget = await fs.resolve(root, { cwd: root })
      let notes = await walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal)
      if (a.folder) {
        const prefix = a.folder.replace(/^\/+/, '')
        notes = notes.filter((n) => n.path.startsWith(prefix))
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
      const root = vaultRootOf(config, exec as CwdExec)
      const rootTarget = await fs.resolve(root, { cwd: root })
      let notes = await walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal)
      if (a.folder) {
        const prefix = a.folder.replace(/^\/+/, '')
        notes = notes.filter((n) => n.path.startsWith(prefix))
      }
      const limit = Math.max(1, Math.min(a.limit ?? config.maxResults, 200))
      const hits = await searchNotes(fs, notes, q, limit, exec.signal)
      return { total: hits.length, hits }
    },
    presentCall: (args) => ({ card: 'generic', title: `在 vault 搜索“${(args as { query: string }).query}”` }),
  }))

  ctx.tools.register(defineTool({
    name: 'vault_read_note',
    description: '读取 Obsidian vault 里一篇 Markdown 笔记的完整内容。',
    parameters: {
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
      const root = vaultRootOf(config, exec as CwdExec)
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
      const root = vaultRootOf(config, exec as CwdExec)
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
      const root = vaultRootOf(config, exec as CwdExec)
      const rootTarget = await fs.resolve(root, { cwd: root })
      const notes = await walkNotes(fs, rootTarget, config.ignoreDirs, exec.signal)
      const backlinks = await findBacklinks(fs, notes, title, exec.signal)
      return { total: backlinks.length, backlinks }
    },
    presentCall: (args) => ({ card: 'generic', title: `查找 [[${(args as { title: string }).title}]] 的反向链接` }),
  }))
}
