import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A note (markdown, or any file when walking with `includeAll`) found while
 * walking the vault.
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
  /**
   * Lowercased file extension without the dot (`md`, `png`, …) for
   * non-markdown files collected by an `includeAll` walk; `md` for notes.
   * `''` for files without an extension. Absent for `.md`-only walks.
   */
  extension?: string
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
  /**
   * Epoch-ms mtime of `<vault>/.obsidian/workspace.json` — the last time that
   * vault window saved its workspace layout (`Workspace.requestSaveLayout`,
   * debounced on focus / layout change). Used to rank open vaults by how
   * recently their window was active. Absent when the file does not exist.
   */
  activeAt?: number
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
    const vaults: DiscoveredVault[] = Object.values(data.vaults ?? {})
      .map((v) => ({ path: (v.path ?? '').trim(), open: Boolean(v.open) }))
      .filter((v) => v.path.length > 0)
      .map((v) => ({ name: path.basename(v.path), path: v.path, open: v.open }))
    vaults.sort((a, b) => a.name.localeCompare(b.name))
    // Rank by last activity: the mtime of the vault's saved workspace layout
    // mirrors how recently that window was focused (Obsidian writes it on
    // focus / layout change). Failures (missing file, unwritable dir) leave
    // `activeAt` unset instead of aborting discovery.
    await Promise.all(vaults.map(async (v) => {
      try {
        const ws = await stat(path.join(v.path, '.obsidian', 'workspace.json'))
        v.activeAt = ws.mtimeMs
      } catch {
        v.activeAt = undefined
      }
    }))
    return vaults
  } catch {
    return []
  }
}

/**
 * Pick the vault a tool call without an explicit `vault` argument should
 * operate on: among currently open vaults, the one whose window was most
 * recently active (newest `.obsidian/workspace.json`), breaking ties by name.
 * Returns `undefined` when no vault is open, so callers fall through to the
 * session workspace.
 */
export function selectCurrentVault(vaults: readonly DiscoveredVault[]): DiscoveredVault | undefined {
  return [...vaults]
    .filter((v) => v.open)
    .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0) || a.name.localeCompare(b.name))[0]
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
 * Recursively walk the vault through the `fs` service, collecting `.md` notes
 * (or every file when `includeAll` is set, mirroring Obsidian's
 * `vault.getFiles()` vs `vault.getMarkdownFiles()`). Uses `ctx.fs.listDir`,
 * so it inherits the mounted backend (sandbox, symlink resolution, stable
 * ordering) instead of reaching for `node:fs`.
 */
export async function walkNotes(
  fs: FileSystem,
  root: FsTarget,
  ignoreDirs: readonly string[],
  signal?: AbortSignal,
  containRoot = false,
  includeAll = false,
): Promise<VaultNote[]> {
  const notes: VaultNote[] = []
  const stack: Array<{ dir: FsTarget; rel: string }> = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!
    const entries = await fs.listDir(dir, signal)
    for (const entry of entries) {
      // A symlinked entry can resolve outside the vault; `fs.contains` compares
      // canonical identities, so a resolved target outside the root is skipped
      // rather than read as vault content.
      if (containRoot && !fs.contains(root, entry.target)) continue
      if (entry.type === 'directory') {
        if (!isIgnoredDir(entry.name, ignoreDirs)) {
          stack.push({ dir: entry.target, rel: joinRel(rel, entry.name) })
        }
      } else if (entry.type === 'file') {
        if (includeAll) {
          const dot = entry.name.lastIndexOf('.')
          notes.push({
            path: joinRel(rel, entry.name),
            target: entry.target,
            size: entry.size,
            version: entry.version,
            extension: entry.name.endsWith('.md') ? 'md' : dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '',
          })
        } else if (entry.name.endsWith('.md')) {
          notes.push({ path: joinRel(rel, entry.name), target: entry.target, size: entry.size, version: entry.version, extension: 'md' })
        }
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

/** Options for {@link searchNotes}, mirroring Obsidian's search syntax subset. */
export interface SearchOptions {
  /** Treat `query` as a regular expression instead of literal text. */
  regex?: boolean
  /** Case-sensitive matching. Default: case-insensitive (like Obsidian). */
  caseSensitive?: boolean
  /**
   * When set (literal mode), split `query` on whitespace and require EVERY
   * token to match (AND semantics, like Obsidian's default multi-term search).
   * Default: the whole `query` is one literal substring, so `"a b"` matches
   * only the exact adjacent text `a b`.
   */
  matchAll?: boolean
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
  opts?: SearchOptions,
): Promise<NoteHit[]> {
  const q = query
  const regex = opts?.regex ?? false
  const caseSensitive = opts?.caseSensitive ?? false
  const matchAll = opts?.matchAll ?? false
  let re: RegExp | undefined
  if (regex) {
    try {
      re = new RegExp(q, caseSensitive ? '' : 'i')
    } catch (err) {
      throw new Error(`正则无效：${q}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  const tokens = !regex && matchAll ? q.split(/\s+/).filter((t) => t.length > 0) : undefined
  const bodies = await mapLimit(notes, concurrency, async (note) => {
    const body = await readBodyCached(fs, note, cache, signal)
    return { note, body }
  })
  const hits: NoteHit[] = []
  for (const { note, body } of bodies) {
    if (hits.length >= limit) break
    const text = body?.text ?? ''
    const haystack = caseSensitive ? `${note.path}\n${text}` : `${note.path}\n${text}`.toLowerCase()
    let nameMatch = false
    let bodyIndex = -1
    let matchLen = 0
    if (regex && re) {
      const m = re.exec(text)
      if (m) {
        bodyIndex = m.index
        matchLen = m[0].length
      }
      nameMatch = re.test(note.path)
    } else if (tokens) {
      // AND semantics: every token must appear somewhere (name or body).
      const needle = caseSensitive ? q : q.toLowerCase()
      nameMatch = tokens.every((t) => haystack.includes(caseSensitive ? t : t.toLowerCase()))
      if (nameMatch) {
        // snippet anchor: first token's first occurrence in the body.
        for (const t of tokens) {
          const idx = (caseSensitive ? text : text.toLowerCase()).indexOf(caseSensitive ? t : t.toLowerCase())
          if (idx >= 0) {
            bodyIndex = idx
            matchLen = t.length
            break
          }
        }
      }
    } else {
      const needle = caseSensitive ? q : q.toLowerCase()
      nameMatch = note.path.includes(needle) || (caseSensitive ? haystack.includes(q) : haystack.includes(needle))
      bodyIndex = (caseSensitive ? text : text.toLowerCase()).indexOf(needle)
      matchLen = q.length
    }
    if (nameMatch || bodyIndex >= 0) {
      const snippet = bodyIndex >= 0 ? excerptAround(text, bodyIndex, Math.max(matchLen, 1)) : '文件名命中（正文无匹配）'
      hits.push({ path: note.path, snippet })
    }
  }
  return hits
}

/** Basename stem of a vault-relative note path (no directories, no `.md`). */
export function stemOf(relPath: string): string {
  return (relPath.replace(/\.md$/, '').split('/').pop() ?? '') || relPath
}

/** One `[[wikilink]]` body (without brackets) split into its parts. */
export interface ParsedLink {
  /** The raw body between the brackets. */
  raw: string
  /** Target path part (no anchor, no alias, no `.md`), e.g. `dir/name`. */
  pathPart: string
  /** Basename stem of the target. */
  stem: string
  /** Anchor including the leading `#`, when present. */
  anchor?: string
  /** Alias including the leading `|`, when present. */
  alias?: string
  /** Whether the link is an embed (`![[...]]`). */
  embedded: boolean
}

/**
 * Split one wikilink body. Obsidian syntax: `path/to/note.md#锚点|别名`;
 * the first `|` starts the alias and the first `#` (before any `|`) starts the
 * anchor.
 */
export function parseLinkBody(inner: string, embedded: boolean): ParsedLink {
  let targetPart = inner.trim()
  let alias: string | undefined
  const pipeIdx = targetPart.indexOf('|')
  if (pipeIdx >= 0) {
    alias = targetPart.slice(pipeIdx) || undefined
    targetPart = targetPart.slice(0, pipeIdx)
  }
  let anchor: string | undefined
  const hashIdx = targetPart.indexOf('#')
  if (hashIdx >= 0) {
    anchor = targetPart.slice(hashIdx) || undefined
    targetPart = targetPart.slice(0, hashIdx)
  }
  const pathPart = targetPart.trim().replace(/\.md$/, '')
  return {
    raw: inner,
    pathPart,
    stem: (pathPart.split('/').pop() ?? '') || pathPart,
    anchor,
    alias,
    embedded,
  }
}

/**
 * Index over every known note path for resolving links the way Obsidian does:
 * a path-qualified link matches one exact vault-relative path; a bare-stem
 * link matches the shortest unique path (ties break lexicographically).
 */
export interface LinkResolver {
  /** Lowercased stem → candidate rel paths, sorted shortest-first. */
  byStem: Map<string, string[]>
  /** Lowercased rel path (no `.md`) → original rel path. */
  byPath: Map<string, string>
}

/** Build a link resolver from the notes of one vault walk. */
export function buildLinkResolver(notes: readonly VaultNote[]): LinkResolver {
  const byStem = new Map<string, string[]>()
  const byPath = new Map<string, string>()
  for (const note of notes) {
    const rel = note.path.replace(/\.md$/, '')
    byPath.set(rel.toLowerCase(), rel)
    const key = stemOf(rel).toLowerCase()
    const list = byStem.get(key)
    if (list) list.push(rel)
    else byStem.set(key, [rel])
  }
  for (const list of byStem.values()) {
    list.sort((a, b) => a.length - b.length || a.localeCompare(b))
  }
  return { byStem, byPath }
}

/**
 * Resolve one link target part against known notes, or `undefined` when the
 * link points at no existing note. Matching is case-insensitive, mirroring
 * Obsidian's link resolution.
 */
export function resolveLinkTarget(resolver: LinkResolver, pathPart: string, stem: string): string | undefined {
  const norm = pathPart.trim().replace(/\.md$/, '')
  if (norm.includes('/')) {
    return resolver.byPath.get(norm.toLowerCase())
  }
  const candidates = resolver.byStem.get(stem.toLowerCase())
  if (!candidates || candidates.length === 0) return undefined
  // Obsidian resolves a bare link to the shortest unique path; sorted order
  // (shortest, then lexicographic) makes ties deterministic.
  return candidates[0]
}

/** Which note a backlink query targets. */
export interface BacklinkTarget {
  /** Exact vault-relative note path (no `.md`); links resolve to this path only. */
  path?: string
  /** Fallback: match links whose target stem equals this title (any path). */
  title?: string
}

/** Which link syntaxes a backlink query should consider. */
export type BacklinkFormat = 'wikilink' | 'markdown' | 'all'

/** Vault-relative directory of a note path (`''` for the vault root). */
export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/** True when a wikilink hit matches the queried target. */
function isWikilinkHit(
  resolved: string | undefined,
  parsed: ParsedLink,
  targetRel: string | undefined,
  targetStem: string | undefined,
): boolean {
  if (targetRel !== undefined) {
    return resolved !== undefined && resolved.toLowerCase() === targetRel.toLowerCase()
  }
  return targetStem !== undefined && parsed.stem.toLowerCase() === targetStem.toLowerCase()
}

/**
 * Find notes that link to a note matched by `target` — via `[[wikilink]]`
 * and/or markdown `[text](path)` links, mirroring Obsidian's backlinks pane
 * which reports both syntaxes. Markdown targets resolve relative to each
 * referencing note's folder (or vault-root-relative with a leading `/`).
 */
export async function findBacklinks(
  fs: FileSystem,
  notes: VaultNote[],
  target: BacklinkTarget,
  signal?: AbortSignal,
  cache?: NoteBodyCache,
  concurrency = 8,
  format: BacklinkFormat = 'wikilink',
): Promise<NoteHit[]> {
  const targetRel = target.path?.replace(/\.md$/, '')
  const targetStem = target.title?.replace(/\.md$/, '')
  const resolver = buildLinkResolver(notes)
  const bodies = await mapLimit(notes, concurrency, async (note) => ({
    note,
    body: await readBodyCached(fs, note, cache, signal),
  }))
  const checkWikilink = format === 'wikilink' || format === 'all'
  const checkMarkdown = format === 'markdown' || format === 'all'
  const hits: NoteHit[] = []
  for (const { note, body } of bodies) {
    const text = body?.text ?? ''
    const noteDir = dirOf(note.path)
    let hit: NoteHit | undefined
    if (checkWikilink) {
      const linkRe = /!?\[\[([^\[\]]+)\]\]/g
      let m: RegExpExecArray | null
      while ((m = linkRe.exec(text)) !== null) {
        const parsed = parseLinkBody(m[1], m[0].startsWith('!'))
        if (!parsed.stem) continue
        const resolved = resolveLinkTarget(resolver, parsed.pathPart, parsed.stem)
        if (isWikilinkHit(resolved, parsed, targetRel, targetStem)) {
          hit = { path: note.path, snippet: excerptAround(text, m.index, m[0].length) }
          break
        }
      }
    }
    if (!hit && checkMarkdown) {
      const mdRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g
      let m: RegExpExecArray | null
      while ((m = mdRe.exec(text)) !== null) {
        const resolved = resolveMarkdownTarget(m[2], noteDir, resolver)
        if (!resolved) continue
        const isHit = targetRel !== undefined
          ? resolved.toLowerCase() === targetRel.toLowerCase()
          : targetStem !== undefined && stemOf(resolved).toLowerCase() === targetStem.toLowerCase()
        if (isHit) {
          hit = { path: note.path, snippet: excerptAround(text, m.index, m[0].length) }
          break
        }
      }
    }
    if (hit) hits.push(hit)
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

/** Split a comma/array-ish property value (`[a, b]`, `a, b`) into trimmed items. */
export function splitListValue(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Extract every tag from a note body: inline Obsidian tags (`#tag`,
 * `#nested/tag` — not markdown headings, not `##x`) plus `tags`/`tag`
 * frontmatter properties (inline arrays and block lists, which
 * {@link parseFrontmatter} already merges). Best-effort: tags inside code
 * fences are still reported. Order is first-seen; results are deduplicated.
 */
export function extractTags(content: string): string[] {
  const tags = new Set<string>()
  // Inline tags: a `#` not preceded by a tag character, `#`, or `/` (so
  // `##x` / `C#tag` / `a#tag` are not tags), followed by tag characters
  // (letter/number/underscore/hyphen/slash). `# Heading` is not a tag; a
  // trailing `.`/`,`/`。` is not part of the tag. Chinese punctuation before
  // the `#` is a valid boundary (`，#tag` matches).
  const inlineRe = /(?<![\p{L}\p{N}_/#-])#([\p{L}\p{N}_/-]+)/gu
  let m: RegExpExecArray | null
  while ((m = inlineRe.exec(content)) !== null) {
    tags.add(m[1])
  }
  const fm = parseFrontmatter(content)
  for (const field of fm.fields) {
    const key = field.key.toLowerCase()
    if (key === 'tags' || key === 'tag') {
      for (const t of splitListValue(field.value)) tags.add(t)
    }
  }
  return [...tags]
}

/** One tag-search hit. */
export interface TagHit {
  path: string
  /** The note's tags that matched the query (exact or a subtag under it). */
  tags: string[]
}

/**
 * Find notes carrying a tag, matching Obsidian's `#tag` search semantics: the
 * query matches the exact tag or any nested subtag under it (`tag/sub`).
 * Scans inline tags and frontmatter `tags`/`tag` properties.
 */
export async function findNotesByTag(
  fs: FileSystem,
  notes: VaultNote[],
  query: string,
  limit: number,
  signal?: AbortSignal,
  cache?: NoteBodyCache,
  concurrency = 8,
): Promise<TagHit[]> {
  const q = query.trim().toLowerCase()
  const hits: TagHit[] = []
  const bodies = await mapLimit(notes, concurrency, async (note) => ({
    note,
    body: await readBodyCached(fs, note, cache, signal),
  }))
  for (const { note, body } of bodies) {
    if (hits.length >= limit) break
    const all = extractTags(body?.text ?? '')
    const matched = all
      .filter((t) => {
        const l = t.toLowerCase()
        return l === q || l.startsWith(q + '/')
      })
      .sort()
    if (matched.length > 0) hits.push({ path: note.path, tags: matched })
  }
  return hits
}

/**
 * Recursively enumerate every folder of the vault with the number of
 * markdown notes directly inside it (like the "File Explorer Note Count"
 * plugin / Obsidian's own sidebar counts). Empty folders are included.
 */
export interface FolderStat {
  /** Vault-relative folder path, '/'-joined; `''` is the vault root. */
  path: string
  /** Number of `.md` notes directly in this folder (not its subfolders). */
  notes: number
}

export async function listFolders(
  fs: FileSystem,
  root: FsTarget,
  ignoreDirs: readonly string[],
  signal?: AbortSignal,
  containRoot = false,
): Promise<FolderStat[]> {
  const counts = new Map<string, number>()
  counts.set('', 0)
  const stack: Array<{ dir: FsTarget; rel: string }> = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!
    const entries = await fs.listDir(dir, signal)
    for (const entry of entries) {
      if (containRoot && !fs.contains(root, entry.target)) continue
      if (entry.type === 'directory') {
        if (!isIgnoredDir(entry.name, ignoreDirs)) {
          const relDir = joinRel(rel, entry.name)
          counts.set(relDir, 0)
          stack.push({ dir: entry.target, rel: relDir })
        }
      } else if (entry.type === 'file' && entry.name.endsWith('.md')) {
        counts.set(rel, (counts.get(rel) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .map(([path, notes]) => ({ path, notes }))
    .sort((a, b) => a.path.localeCompare(b.path))
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
    const parsed = parseLinkBody(inner, m[0].startsWith('!'))
    if (!parsed.stem) continue
    // Deduplicate by the resolved link identity (path + anchor + embed flag),
    // NOT by `stem`: links whose basenames collide — e.g. `dir/a` vs `other/a`,
    // or `a#x` vs `a#y` — are different links and must all be kept.
    const identity = `${parsed.embedded ? '!' : ''}${parsed.pathPart}${parsed.anchor ?? ''}`
    if (seen.has(identity)) continue
    seen.add(identity)
    links.push({
      target: inner,
      stem: parsed.stem,
      anchor: parsed.anchor?.slice(1),
      alias: parsed.alias?.slice(1),
      embedded: parsed.embedded,
    })
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
 * Rewrite every link that resolves to the renamed note (identified by its
 * exact vault-relative path `oldRelNoExt`, not just by stem) so it points at
 * the new location. Short-form links (`[[old]]`) become `[[newStem]]`;
 * path-qualified links (`[[dir/old]]`) become the new vault-relative path so
 * they stay resolvable after a move. Anchors, aliases and embeds are
 * preserved. Links to OTHER notes that merely share the old basename are left
 * untouched. Returns the rewritten body plus the rewrite count.
 */
export function rewriteWikilinks(
  body: string,
  newStem: string,
  newRelPath: string,
  resolver: LinkResolver,
  oldRelNoExt: string,
): LinkRewriteResult {
  const newRel = newRelPath.replace(/\.md$/, '')
  const oldKey = oldRelNoExt.toLowerCase()
  const linkRe = /!?\[\[([^\[\]]+)\]\]/g
  let count = 0
  const text = body.replace(linkRe, (whole, inner: string) => {
    const parsed = parseLinkBody(inner, whole.startsWith('!'))
    if (!parsed.stem) return whole
    const resolved = resolveLinkTarget(resolver, parsed.pathPart, parsed.stem)
    // Only rewrite when this link actually points at the note being renamed.
    if (!resolved || resolved.toLowerCase() !== oldKey) return whole
    count++
    const hasDir = parsed.pathPart.includes('/')
    const newTarget = hasDir ? newRel : newStem
    return `${parsed.embedded ? '!' : ''}[[${newTarget}${parsed.anchor ?? ''}${parsed.alias ?? ''}]]`
  })
  return { text, count }
}

/** Strip a trailing `.md` (case-insensitive) from a link target. */
function stripMd(p: string): string {
  return p.replace(/\.md$/i, '')
}

/** One markdown `[text](target)` link occurrence. */
export interface MarkdownLinkHit {
  /** The raw target including any `#anchor` (angle brackets stripped). */
  target: string
  /** Link text between the brackets. */
  text: string
  /** Absolute match index in the body. */
  index: number
}

/**
 * Extract every markdown link `[text](target)` (not image embeds
 * `![…](…)`). Targets keep their `#anchor`; angle-bracket forms
 * (`[x](<path>)`) are normalized to their inner path.
 */
export function extractMarkdownLinks(body: string): MarkdownLinkHit[] {
  const links: MarkdownLinkHit[] = []
  const re = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    let target = m[2].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    links.push({ target, text: m[1], index: m.index })
  }
  return links
}

/**
 * Resolve a markdown link target (`dir/note`, `../note.md`, `/root/note`,
 * `note#heading`, `<path with spaces>`) against known notes, relative to the
 * note's own folder. Returns the vault-relative path without `.md`, or
 * `undefined` for external URLs (`http:`, `mailto:`, …), heading-only links,
 * links that escape above the vault root, and unresolvable paths.
 */
export function resolveMarkdownTarget(rawTarget: string, noteDir: string, resolver: LinkResolver): string | undefined {
  let target = rawTarget.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  const hashIdx = target.indexOf('#')
  let pathPart = hashIdx >= 0 ? target.slice(0, hashIdx) : target
  if (pathPart === '') return undefined // heading-only link
  // External URL, but keep a Windows drive letter (`C:\…`) as a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart) && !/^[a-z]:[\\/]/i.test(pathPart)) return undefined
  pathPart = pathPart.replace(/\\/g, '/')
  if (pathPart.startsWith('/')) {
    pathPart = pathPart.slice(1) // vault-root-relative
  } else if (noteDir !== '') {
    pathPart = path.posix.normalize(`${noteDir}/${pathPart}`)
    if (pathPart.startsWith('../')) return undefined // escaped above the vault
  }
  return resolver.byPath.get(stripMd(pathPart).toLowerCase())
}

/**
 * Vault-relative path from `fromDir` (a note's folder, `''` = vault root) to
 * `toRelNoExt`, using `../` segments so a markdown link stays correct after a
 * cross-directory move. `''` when the path is inside the same folder.
 */
export function relativePath(fromDir: string, toRelNoExt: string): string {
  const from = fromDir === '' ? [] : fromDir.split('/')
  const to = toRelNoExt.split('/')
  let i = 0
  while (i < from.length && i < to.length && from[i] === to[i]) i++
  const up = from.length - i
  const parts = [...Array.from({ length: up }, () => '..'), ...to.slice(i)]
  return parts.join('/')
}

/** Result of rewriting markdown links that pointed at the renamed note. */
export interface MarkdownRewriteResult {
  /** The full rewritten body. */
  text: string
  /** How many link occurrences were rewritten. */
  count: number
}

/**
 * Rewrite every markdown link `[text](target)` that resolves to the renamed
 * note so it points at the new location — the markdown counterpart of
 * {@link rewriteWikilinks}, mirroring Obsidian's "Automatically update
 * internal links" setting which covers both syntaxes. Targets are re-derived
 * relative to each referencing note's folder, so links survive cross-directory
 * moves; external URLs and links to other notes are left untouched.
 */
export function rewriteMarkdownLinks(
  body: string,
  newRelPath: string,
  resolver: LinkResolver,
  oldRelNoExt: string,
  noteDir: string,
): MarkdownRewriteResult {
  const newRel = newRelPath.replace(/\.md$/, '')
  const oldKey = oldRelNoExt.toLowerCase()
  const linkRe = /(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g
  let count = 0
  const text = body.replace(linkRe, (whole, text: string, rawTarget: string) => {
    const resolved = resolveMarkdownTarget(rawTarget, noteDir, resolver)
    if (!resolved || resolved.toLowerCase() !== oldKey) return whole
    count++
    const raw = rawTarget.trim()
    const wasAngle = raw.startsWith('<') && raw.endsWith('>')
    const hashIdx = raw.indexOf('#')
    const anchor = hashIdx >= 0 ? raw.slice(hashIdx) : ''
    const newTarget = relativePath(noteDir, newRel)
    const rendered = wasAngle ? `<${newTarget}${anchor}>` : `${newTarget}${anchor}`
    return `[${text}](${rendered})`
  })
  return { text, count }
}

/** One applied frontmatter change. */
export interface FrontmatterChange {
  op: 'set' | 'delete'
  key: string
  /** New value for `set` changes. */
  value?: string
}

/** Result of applying a frontmatter update. */
export interface FrontmatterUpdateResult {
  /** Full rewritten note body. */
  text: string
  /** Whether a frontmatter block had to be created (the note had none). */
  created: boolean
  /** The applied changes, in execution order. */
  changes: FrontmatterChange[]
}

/**
 * Apply a set/delete of top-level frontmatter properties, preserving the rest
 * of the block (key order, comments, unrelated keys) and the body. New keys
 * are appended after the last top-level key, like Obsidian's Properties UI;
 * replacing a key drops the old value's block-list lines. When the note has no
 * frontmatter and `set` is non-empty, one is created; deleting from an absent
 * or unclosed frontmatter is an error. Values must be single-line YAML scalars
 * (use inline arrays like `[a, b]` for lists).
 */
export function applyFrontmatterUpdate(
  content: string,
  set: Record<string, string>,
  del: readonly string[],
): FrontmatterUpdateResult {
  const setEntries = Object.entries(set)
  for (const [k, v] of setEntries) {
    if (/\n/.test(v)) throw new Error(`frontmatter 值必须单行（字段 ${k} 的取值含换行）；列表请用内联数组 [a, b]`)
  }
  const changes: FrontmatterChange[] = [
    ...setEntries.map(([key, value]) => ({ op: 'set' as const, key, value })),
    ...del.map((key) => ({ op: 'delete' as const, key })),
  ]
  const parsed = parseFrontmatter(content)
  if (!parsed.present) {
    if (content.startsWith('---')) {
      throw new Error('frontmatter 起始围栏未闭合，无法安全修改；请先修复笔记格式')
    }
    if (setEntries.length === 0) {
      throw new Error('笔记没有 frontmatter，无法删除字段；如需新建请同时传 set')
    }
    const block = setEntries.map(([k, v]) => `${k}: ${v}`).join('\n')
    const fm = `---\n${block}\n---`
    const body = content.replace(/^\uFEFF/, '')
    return { text: body.trim() === '' ? fm : `${fm}\n${body}`, created: true, changes }
  }

  const lines = content.split('\n')
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  const block = lines.slice(1, close)
  const rest = lines.slice(close + 1)
  const remaining = new Set(del)
  const setMap = new Map(setEntries)
  const out: string[] = []
  // Dropping the old value block of a deleted or replaced key: skip every
  // following line until the next top-level key line.
  let dropping = false
  for (const rawLine of block) {
    const trimmed = rawLine.trim()
    const indent = rawLine.length - rawLine.trimStart().length
    const kv = indent === 0 ? /^([^:#][^:]*):\s*(.*)$/.exec(trimmed) : null
    if (dropping) {
      if (kv) dropping = false
      else continue
    }
    if (kv) {
      const key = kv[1].trim()
      if (remaining.has(key)) {
        remaining.delete(key)
        dropping = true
        continue
      }
      if (setMap.has(key)) {
        const value = setMap.get(key)!
        setMap.delete(key)
        out.push(`${key}: ${value}`)
        dropping = true
        continue
      }
      out.push(rawLine)
      continue
    }
    out.push(rawLine)
  }
  for (const [key, value] of setMap) out.push(`${key}: ${value}`)
  const newBlock = out.join('\n')
  const text = `---\n${newBlock}\n---` + (rest.length > 0 ? `\n${rest.join('\n')}` : '')
  return { text, created: false, changes }
}
