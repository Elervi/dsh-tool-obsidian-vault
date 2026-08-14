import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

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
}

/** A search / backlink hit with a short excerpt. */
export interface NoteHit {
  path: string
  snippet: string
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
        notes.push({ path: joinRel(rel, entry.name), target: entry.target, size: entry.size })
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

/** Case-insensitive keyword search across note file names and bodies. */
export async function searchNotes(
  fs: FileSystem,
  notes: VaultNote[],
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<NoteHit[]> {
  const q = query.toLowerCase()
  const hits: NoteHit[] = []
  for (const note of notes) {
    if (hits.length >= limit) break
    const nameMatch = note.path.toLowerCase().includes(q)
    let body = ''
    try {
      body = await fs.readText(note.target, signal)
    } catch {
      // Skip unreadable notes rather than failing the whole search.
    }
    const idx = body.toLowerCase().indexOf(q)
    if (nameMatch || idx >= 0) {
      const snippet = idx >= 0 ? excerptAround(body, idx, q.length) : '文件名命中（正文无匹配）'
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
): Promise<NoteHit[]> {
  const hits: NoteHit[] = []
  const target = title.replace(/\.md$/, '')
  for (const note of notes) {
    let body = ''
    try {
      body = await fs.readText(note.target, signal)
    } catch {
      continue
    }
    const linkRe = /\[\[([^\]|#]+)/g
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(body)) !== null) {
      const stem = (m[1].trim().split('/').pop() ?? '').replace(/\.md$/, '')
      if (stem === target) {
        hits.push({ path: note.path, snippet: excerptAround(body, m.index, m[0].length) })
        break
      }
    }
  }
  return hits
}
