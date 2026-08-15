import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A markdown note found while walking the vault.
 */
export interface VaultNote {
  /** Vault-relative path, '/'-joined, without a leading slash. */
  path: string
  /** Resolved target for a direct `fs.readText` without re-resolving. */
  target: FsTarget
  /** Byte size when the backend reported it. */
  size?: number
  /** Freshness token reported by `listDir` when available (skips a `stat`). */
  version?: string
}

/** A search / backlink hit with a short excerpt. */
export interface NoteHit {
  path: string
  snippet: string
}

/** One Obsidian vault discovered from the global registry. */
export interface DiscoveredVault {
  /** The vault's display name (its folder's basename). */
  name: string
  /** Absolute path to the vault root. */
  path: string
  /** Whether this vault is the one currently open in Obsidian. */
  open?: boolean
}

/** Platform-specific location of Obsidian's global vault registry. */
export function obsidianConfigPath(): string | undefined {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData ? path.join(appData, 'obsidian', 'obsidian.json') : undefined
  }
  return path.join(home, '.config', 'obsidian', 'obsidian.json')
}

/**
 * Discover every Obsidian vault registered in the global config
 * (`obsidian.json`), which the desktop app writes on launch. Missing or
 * unreadable registry yields an empty list — callers then fall back to the
 * session workspace, so discovery failures are never fatal.
 */
export async function discoverVaults(): Promise<DiscoveredVault[]> {
  const configPath = obsidianConfigPath()
  if (!configPath) return []
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    return []
  }
  try {
    const data = JSON.parse(raw) as { vaults?: Record<string, { path?: string; open?: boolean }> }
    const vaults = Object.values(data.vaults ?? {})
      .map((v) => ({ path: (v.path ?? '').trim(), open: Boolean(v.open) }))
      .filter((v) => v.path.length > 0)
      .map((v) => ({ name: path.basename(v.path), path: v.path, open: v.open }))
    vaults.sort((a, b) => a.name.localeCompare(b.name))
    return vaults
  } catch {
    return []
  }
}

/** Skip dot-directories and any name the user listed in `ignoreDirs`. */
export function isIgnoredDir(name: string, ignoreDirs: readonly string[]): boolean {
  return name.startsWith('.') || ignoreDirs.includes(name)
}

/** Join a vault-relative directory and a child name with '/'. */
export function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/**
 * Recursively walk the vault through the `fs` service, collecting `.md` notes.
 * Uses `ctx.fs.listDir`, so it inherits the mounted backend (sandbox, symlink
 * resolution, stable ordering) instead of reaching for `node:fs`.
 */
export async function walkNotes(
  fs: FileSystem,
  root: FsTarget,
  ignoreDirs: readonly string[],
  signal?: AbortSignal,
): Promise<VaultNote[]> {
  const notes: VaultNote[] = []
  const stack: Array<{ dir: FsTarget; rel: string }> = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!
    const entries = await fs.listDir(dir, signal)
    for (const entry of entries) {
      if (entry.type === 'directory') {
        if (!isIgnoredDir(entry.name, ignoreDirs)) {
          stack.push({ dir: entry.target, rel: joinRel(rel, entry.name) })
        }
      } else if (entry.type === 'file' && entry.name.endsWith('.md')) {
        notes.push({ path: joinRel(rel, entry.name), target: entry.target, size: entry.size, version: entry.version })
      }
    }
  }
  notes.sort((a, b) => a.path.localeCompare(b.path))
  return notes
}

function excerptAround(text: string, index: number, queryLen: number, radius = 80): string {
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + queryLen + radius)
  const before = start > 0 ? '…' : ''
  const after = end < text.length ? '…' : ''
  return `${before}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${after}`
}

/**
 * A per-session cache of note bodies, keyed by the target's opaque key and
 * validated against the `fs.stat` version token. Re-reading a note is skipped
 * entirely when the version is unchanged, so repeated searches / backlink
 * queries over the same vault read changed files only. Keying by target key
 * (an absolute path with the local backend) keeps caches isolated across
 * different vaults even when relative paths collide.
 */
export interface NoteBodyCache {
  entries: Map<string, { version: string; text: string }>
}

/** Create an empty note-body cache. */
export function createBodyCache(): NoteBodyCache {
  return { entries: new Map() }
}

/** Read a note body, reusing the cache when the version is unchanged. */
async function readBodyCached(
  fs: FileSystem,
  note: VaultNote,
  cache: NoteBodyCache | undefined,
  signal?: AbortSignal,
): Promise<{ text: string } | null> {
  const key = note.target.targetKey
  const hit = cache?.entries.get(key)
  // When listDir already gave us a version token, a cache hit skips the stat.
  if (hit && note.version !== undefined && hit.version === note.version) return { text: hit.text }
  try {
    const info = await fs.stat(note.target, signal)
    if (!info || info.type !== 'file') return null
    if (hit && hit.version === info.version) return { text: hit.text }
    const text = await fs.readText(note.target, signal)
    if (cache) cache.entries.set(key, { version: info.version, text })
    return { text }
  } catch {
    return null
  }
}

/** Run `fn` over `items` with at most `limit` promises in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

/**
 * Case-insensitive keyword search across note file names and bodies.
 * Reads run with bounded concurrency and reuse `cache` (validated by version)
 * to skip unchanged files on repeat queries.
 */
export async function searchNotes(
  fs: FileSystem,
  notes: VaultNote[],
  query: string,
  limit: number,
  signal?: AbortSignal,
  cache?: NoteBodyCache,
  concurrency = 8,
): Promise<NoteHit[]> {
  const q = query.toLowerCase()
  const bodies = await mapLimit(notes, concurrency, async (note) => {
    const nameMatch = note.path.toLowerCase().includes(q)
    const body = await readBodyCached(fs, note, cache, signal)
    return { note, nameMatch, body }
  })
  const hits: NoteHit[] = []
  for (const { note, nameMatch, body } of bodies) {
    if (hits.length >= limit) break
    const text = body?.text ?? ''
    const idx = text.toLowerCase().indexOf(q)
    if (nameMatch || idx >= 0) {
      const snippet = idx >= 0 ? excerptAround(text, idx, q.length) : '文件名命中（正文无匹配）'
      hits.push({ path: note.path, snippet })
    }
  }
  return hits
}

/** Find notes whose `[[wikilink]]` targets a note whose stem equals `title`. */
export async function findBacklinks(
  fs: FileSystem,
  notes: VaultNote[],
  title: string,
  signal?: AbortSignal,
  cache?: NoteBodyCache,
  concurrency = 8,
): Promise<NoteHit[]> {
  const target = title.replace(/\.md$/, '')
  const bodies = await mapLimit(notes, concurrency, async (note) => ({
    note,
    body: await readBodyCached(fs, note, cache, signal),
  }))
  const hits: NoteHit[] = []
  for (const { note, body } of bodies) {
    const text = body?.text ?? ''
    const linkRe = /\[\[([^\]|#]+)/g
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(text)) !== null) {
      const stem = (m[1].trim().split('/').pop() ?? '').replace(/\.md$/, '')
      if (stem === target) {
        hits.push({ path: note.path, snippet: excerptAround(text, m.index, m[0].length) })
        break
      }
    }
  }
  return hits
}

/** One key/value pair parsed out of a note's frontmatter. */
export interface FrontmatterField {
  key: string
  value: string
}

/** Structured view of a note's frontmatter (the YAML between `---` fences). */
export interface ParsedFrontmatter {
  /** Whether the note begins with a `---` fence at all. */
  present: boolean
  /** Raw text between the two fences (excluding the fence lines). */
  raw: string
  /** Keys parsed with a best-effort line-level YAML subset. */
  fields: FrontmatterField[]
  /** True when the fences are well-formed (opened and closed). */
  valid: boolean
  /** Human-readable problems found while parsing. */
  issues: string[]
}

/**
 * Best-effort parser for Obsidian frontmatter. Handles the common flat
 * `key: value` subset plus block lists (`- item`) and inline arrays
 * (`[a, b]`); anything fancier (nested mappings, quoted colons) is reported
 * in `issues` rather than mis-parsed. No YAML dependency is required.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = { present: false, raw: '', fields: [], valid: false, issues: [] }
  if (!content.startsWith('---')) {
    result.issues.push('正文不以 --- 开头，没有 frontmatter')
    return result
  }
  const lines = content.split('\n')
  const fence = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (fence < 0) {
    result.issues.push('frontmatter 起始围栏 --- 未闭合')
    return result
  }
  result.present = true
  result.raw = lines.slice(1, fence).join('\n')
  result.valid = true

  const block = lines.slice(1, fence)
  let lastKey: string | null = null
  let lastIndent = -1
  for (const rawLine of block) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const listMatch = /^-\s+(.*)$/.exec(trimmed)
    if (listMatch) {
      if (lastKey) {
        const field = result.fields.find((f) => f.key === lastKey)
        if (field) field.value = field.value ? `${field.value}, ${listMatch[1]}` : listMatch[1]
      } else {
        result.issues.push(`列表项出现在键之前：${trimmed}`)
      }
      continue
    }
    const kv = /^([^:#][^:]*):\s*(.*)$/.exec(trimmed)
    if (!kv) {
      result.issues.push(`无法解析的行（疑似嵌套或复杂 YAML）：${trimmed}`)
      continue
    }
    // A key indented deeper than the previous key is a nested mapping (or an
    // indented block), not a top-level property. Rather than silently flatten
    // it into a top-level field, flag it so `valid` turns false.
    if (lastKey && indent > lastIndent) {
      result.issues.push(`疑似嵌套 YAML（未按顶层字段解析）：${trimmed}`)
      continue
    }
    const key = kv[1].trim()
    let value = kv[2].trim()
    // Strip one matching pair of surrounding quotes.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    result.fields.push({ key, value })
    lastKey = key
    lastIndent = indent
  }
  // A line-level parse problem makes the frontmatter not fully valid, even
  // though the fences themselves are well-formed.
  if (result.issues.length > 0) result.valid = false
  return result
}

/** One outgoing `[[wikilink]]` (or `![[embed]]`) found in a note body. */
export interface OutLink {
  /** The link body without brackets, e.g. `dir/name`, `name#锚点`, `name|别名`. */
  target: string
  /** Basename stem (no path, no `.md`) the link resolves to. */
  stem: string
  /** Optional anchor after `#`. */
  anchor?: string
  /** Optional alias after `|`. */
  alias?: string
  /** Whether the link is an embed (`![[...]]`). */
  embedded: boolean
}

/** Extract every wikilink target (deduplicated) from a note body. */
export function extractLinks(body: string): OutLink[] {
  const seen = new Set<string>()
  const links: OutLink[] = []
  const linkRe = /!?\[\[([^\[\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(body)) !== null) {
    const inner = m[1].trim()
    if (inner === '') continue
    let targetPart = inner
    let alias: string | undefined
    const pipeIdx = inner.indexOf('|')
    if (pipeIdx >= 0) {
      targetPart = inner.slice(0, pipeIdx)
      alias = inner.slice(pipeIdx + 1).trim() || undefined
    }
    let anchor: string | undefined
    const hashIdx = targetPart.indexOf('#')
    if (hashIdx >= 0) {
      anchor = targetPart.slice(hashIdx + 1) || undefined
      targetPart = targetPart.slice(0, hashIdx)
    }
    const stem = (targetPart.trim().split('/').pop() ?? '').replace(/\.md$/, '')
    if (!stem) continue
    // Deduplicate by the resolved link identity (path + anchor + embed flag),
    // NOT by `stem`: links whose basenames collide — e.g. `dir/a` vs `other/a`,
    // or `a#x` vs `a#y` — are different links and must all be kept.
    const identity = `${m[0].startsWith('!') ? '!' : ''}${targetPart.trim().replace(/\.md$/, '')}${anchor ? `#${anchor}` : ''}`
    if (seen.has(identity)) continue
    seen.add(identity)
    links.push({ target: inner, stem, anchor, alias, embedded: m[0].startsWith('!') })
  }
  return links
}

/** Result of rewriting wikilinks that pointed at the old stem. */
export interface LinkRewriteResult {
  /** The full rewritten body. */
  text: string
  /** How many link occurrences were rewritten. */
  count: number
}

/**
 * Rewrite every `[[oldStem]]` (and `![[oldStem]]`) occurrence in `body` so it
 * points at the renamed note. Short-form links (`[[old]]`) become
 * `[[newStem]]`; path-qualified links (`[[dir/old]]`) become the new
 * vault-relative path so they stay resolvable after a move. Anchors and
 * aliases are preserved. Returns the rewritten body plus the rewrite count.
 */
export function rewriteWikilinks(body: string, oldStem: string, newStem: string, newRelPath: string): LinkRewriteResult {
  const newRel = newRelPath.replace(/\.md$/, '')
  const linkRe = /!?\[\[([^\[\]]+)\]\]/g
  let count = 0
  const text = body.replace(linkRe, (whole, inner: string) => {
    const pipeIdx = inner.indexOf('|')
    const alias = pipeIdx >= 0 ? inner.slice(pipeIdx) : ''
    const targetPart = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner
    const hashIdx = targetPart.indexOf('#')
    const anchor = hashIdx >= 0 ? targetPart.slice(hashIdx) : ''
    const pathPart = hashIdx >= 0 ? targetPart.slice(0, hashIdx) : targetPart
    const hasDir = pathPart.includes('/')
    const stem = (pathPart.trim().split('/').pop() ?? '').replace(/\.md$/, '')
    if (stem !== oldStem) return whole
    count++
    const prefix = whole.startsWith('!') ? '!' : ''
    const newTarget = hasDir ? newRel : newRel.split('/').pop() ?? newStem
    return `${prefix}[[${newTarget}${anchor}${alias}]]`
  })
  return { text, count }
}
