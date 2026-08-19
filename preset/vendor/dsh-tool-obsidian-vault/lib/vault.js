import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultError, VaultCode } from './errors.js';
/** Platform-specific location of Obsidian's global vault registry. */
export function obsidianConfigPath() {
    const home = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
    }
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA;
        return appData ? path.join(appData, 'obsidian', 'obsidian.json') : undefined;
    }
    return path.join(home, '.config', 'obsidian', 'obsidian.json');
}
/**
 * The vault dsh-dock binds this service to: `DSH_OBSIDIAN_VAULT_NAME` /
 * `DSH_OBSIDIAN_VAULT_PATH` (see dsh-dock src/main.ts). In per-vault mode
 * each vault gets its own dsh service, so this env IS the vault this service
 * serves — the authoritative binding, stronger than any "recently active"
 * guess. Shared mode has no env; callers fall back to activity ranking.
 */
export function injectedVaultPath() {
    const p = process.env.DSH_OBSIDIAN_VAULT_PATH;
    return typeof p === 'string' && p.trim().length > 0 ? p.trim() : undefined;
}
/** The injected vault's display name (its folder's basename), when bound. */
export function injectedVaultName() {
    const p = injectedVaultPath();
    return p ? path.basename(p) : undefined;
}
/**
 * TTL for the vault-discovery cache: short enough for activity ranking, long
 * enough to avoid re-reading the registry on every call.
 */
const DISCOVER_TTL_MS = 5_000;
let discoverCache;
/**
 * Discover every Obsidian vault registered in the global config
 * (`obsidian.json`), which the desktop app writes on launch. Missing or
 * unreadable registry yields an empty list — callers then fall back to the
 * session workspace, so discovery failures are never fatal. Results are
 * cached for {@link DISCOVER_TTL_MS} (a failed discovery is not cached);
 * workspace-activity changes propagate within the TTL.
 */
export function discoverVaults() {
    const now = Date.now();
    const hit = discoverCache;
    if (hit && now - hit.at < DISCOVER_TTL_MS)
        return hit.promise;
    const promise = discoverVaultsUncached();
    discoverCache = { at: now, promise };
    promise.catch(() => {
        // A failed discovery is not worth caching: the next call retries.
        if (discoverCache?.promise === promise)
            discoverCache = undefined;
    });
    return promise;
}
async function discoverVaultsUncached() {
    const configPath = obsidianConfigPath();
    if (!configPath)
        return [];
    let raw;
    try {
        raw = await readFile(configPath, 'utf8');
    }
    catch {
        return [];
    }
    try {
        const data = JSON.parse(raw);
        const vaults = Object.values(data.vaults ?? {})
            .map((v) => ({ path: (v.path ?? '').trim(), open: Boolean(v.open) }))
            .filter((v) => v.path.length > 0)
            .map((v) => ({ name: path.basename(v.path), path: v.path, open: v.open }));
        vaults.sort((a, b) => a.name.localeCompare(b.name));
        // Rank by last activity: the mtime of the vault's saved workspace layout
        // mirrors how recently that window was focused (Obsidian writes it on
        // focus / layout change). Failures (missing file, unwritable dir) leave
        // `activeAt` unset instead of aborting discovery.
        await Promise.all(vaults.map(async (v) => {
            try {
                const ws = await stat(path.join(v.path, '.obsidian', 'workspace.json'));
                v.activeAt = ws.mtimeMs;
            }
            catch {
                v.activeAt = undefined;
            }
        }));
        return vaults;
    }
    catch {
        return [];
    }
}
/**
 * Pick the vault a tool call without an explicit `vault` argument should
 * operate on, among currently open vaults: the one whose window was most
 * recently active (newest `.obsidian/workspace.json`), ties broken by name.
 * Returns `undefined` when no open vault qualifies, so callers fall through to
 * the session workspace.
 */
export function selectCurrentVault(vaults) {
    return [...vaults]
        .filter((v) => v.open)
        .sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0) || a.name.localeCompare(b.name))[0];
}
/** Skip dot-directories and any name the user listed in `ignoreDirs`. */
export function isIgnoredDir(name, ignoreDirs) {
    return name.startsWith('.') || ignoreDirs.includes(name);
}
/** Join a vault-relative directory and a child name with '/'. */
export function joinRel(dir, name) {
    return dir === '' ? name : `${dir}/${name}`;
}
/**
 * Recursively walk the vault through the `fs` service, collecting `.md` notes
 * (or every file when `includeAll` is set, mirroring Obsidian's
 * `vault.getFiles()` vs `vault.getMarkdownFiles()`). Uses `ctx.fs.listDir`,
 * so it inherits the mounted backend (sandbox, symlink resolution, stable
 * ordering) instead of reaching for `node:fs`. Directory listing is
 * breadth-first with bounded concurrency per level (a barrier keeps the
 * traversal correct without worker-queue races); results are sorted
 * deterministically before returning.
 */
export async function walkNotes(fs, root, ignoreDirs, signal, containRoot = false, includeAll = false, concurrency = 8) {
    const notes = [];
    // Breadth-first by level: every directory of the current level is listed in
    // parallel, children are collected into the next level, then the barrier
    // advances. A worker-pool over a shared queue would drop directories when
    // idle workers exit before later levels are enqueued.
    let level = [{ dir: root, rel: '' }];
    while (level.length > 0) {
        const nextLevel = [];
        await mapLimit(level, concurrency, async ({ dir, rel }) => {
            const entries = await fs.listDir(dir, signal);
            for (const entry of entries) {
                // A symlinked entry can resolve outside the vault; `fs.contains` compares
                // canonical identities, so a resolved target outside the root is skipped
                // rather than read as vault content.
                if (containRoot && !fs.contains(root, entry.target))
                    continue;
                if (entry.type === 'directory') {
                    if (!isIgnoredDir(entry.name, ignoreDirs)) {
                        nextLevel.push({ dir: entry.target, rel: joinRel(rel, entry.name) });
                    }
                }
                else if (entry.type === 'file') {
                    if (includeAll) {
                        const dot = entry.name.lastIndexOf('.');
                        notes.push({
                            path: joinRel(rel, entry.name),
                            target: entry.target,
                            size: entry.size,
                            version: entry.version,
                            extension: entry.name.endsWith('.md') ? 'md' : dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '',
                        });
                    }
                    else if (entry.name.endsWith('.md')) {
                        notes.push({ path: joinRel(rel, entry.name), target: entry.target, size: entry.size, version: entry.version, extension: 'md' });
                    }
                }
            }
        });
        level = nextLevel;
    }
    notes.sort((a, b) => a.path.localeCompare(b.path));
    return notes;
}
function excerptAround(text, index, queryLen, radius = 80) {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + queryLen + radius);
    const before = start > 0 ? '…' : '';
    const after = end < text.length ? '…' : '';
    return `${before}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${after}`;
}
/** Create an empty note-body cache. */
export function createBodyCache() {
    return { entries: new Map() };
}
/** Read a note body, reusing the cache when the version is unchanged. */
async function readBodyCached(fs, note, cache, signal) {
    const key = note.target.targetKey;
    const hit = cache?.entries.get(key);
    // When listDir already gave us a version token, a cache hit skips the stat.
    if (hit && note.version !== undefined && hit.version === note.version)
        return { text: hit.text };
    try {
        const info = await fs.stat(note.target, signal);
        if (!info || info.type !== 'file')
            return null;
        if (hit && hit.version === info.version)
            return { text: hit.text };
        const text = await fs.readText(note.target, signal);
        if (cache)
            cache.entries.set(key, { version: info.version, text });
        return { text };
    }
    catch {
        return null;
    }
}
/** Run `fn` over `items` with at most `limit` promises in flight. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}
/**
 * Case-insensitive keyword search across note file names and bodies.
 * Reads run with bounded concurrency and reuse `cache` (validated by version)
 * to skip unchanged files on repeat queries. Matching happens inside the read
 * workers and stops early once `limit` hits are found, so a sparse hit set
 * does not force a full-vault body read.
 */
export async function searchNotes(fs, notes, query, limit, signal, cache, concurrency = 8, opts) {
    const q = query;
    const regex = opts?.regex ?? false;
    const caseSensitive = opts?.caseSensitive ?? false;
    const matchAll = opts?.matchAll ?? false;
    let re;
    if (regex) {
        try {
            re = new RegExp(q, caseSensitive ? '' : 'i');
        }
        catch (err) {
            throw new VaultError(`正则无效：${q}（${err instanceof Error ? err.message : String(err)}）`, VaultCode.REGEX_INVALID);
        }
    }
    const tokens = !regex && matchAll ? q.split(/\s+/).filter((t) => t.length > 0) : undefined;
    const found = [];
    let filled = false;
    await mapLimit(notes, concurrency, async (note, index) => {
        if (filled)
            return;
        const body = await readBodyCached(fs, note, cache, signal);
        const text = body?.text ?? '';
        const haystack = caseSensitive ? `${note.path}\n${text}` : `${note.path}\n${text}`.toLowerCase();
        let nameMatch = false;
        let bodyIndex = -1;
        let matchLen = 0;
        if (regex && re) {
            const m = re.exec(text);
            if (m) {
                bodyIndex = m.index;
                matchLen = m[0].length;
            }
            nameMatch = re.test(note.path);
        }
        else if (tokens) {
            // AND semantics: every token must appear somewhere (name or body).
            const needle = caseSensitive ? q : q.toLowerCase();
            nameMatch = tokens.every((t) => haystack.includes(caseSensitive ? t : t.toLowerCase()));
            if (nameMatch) {
                // snippet anchor: first token's first occurrence in the body.
                for (const t of tokens) {
                    const idx = (caseSensitive ? text : text.toLowerCase()).indexOf(caseSensitive ? t : t.toLowerCase());
                    if (idx >= 0) {
                        bodyIndex = idx;
                        matchLen = t.length;
                        break;
                    }
                }
            }
        }
        else {
            const needle = caseSensitive ? q : q.toLowerCase();
            nameMatch = note.path.includes(needle) || (caseSensitive ? haystack.includes(q) : haystack.includes(needle));
            bodyIndex = (caseSensitive ? text : text.toLowerCase()).indexOf(needle);
            matchLen = q.length;
        }
        if ((nameMatch || bodyIndex >= 0) && found.length < limit) {
            const snippet = bodyIndex >= 0 ? excerptAround(text, bodyIndex, Math.max(matchLen, 1)) : '文件名命中（正文无匹配）';
            found.push({ index, hit: { path: note.path, snippet } });
            if (found.length >= limit)
                filled = true;
        }
    });
    found.sort((a, b) => a.index - b.index);
    return found.map((f) => f.hit);
}
/** Basename stem of a vault-relative note path (no directories, no `.md`). */
export function stemOf(relPath) {
    return (relPath.replace(/\.md$/, '').split('/').pop() ?? '') || relPath;
}
/**
 * One markdown link `[text](target)` — both the plain form and Obsidian's
 * angle-bracket form `[text](<path with spaces>)`. The two alternatives let
 * the bracket form carry spaces (and even `)`) while the plain form keeps the
 * historical no-space, no-`)` restriction; image embeds `![…](…)` are
 * excluded via the negative lookbehind. Groups: 1 = link text, 2 = angle-bracket
 * target (when present), 3 = plain target (when present).
 */
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]*)\]\((?:<([^>]*)>|([^)\s]+))\)/g;
/** Extract the raw target of a matched markdown link (groups 2 or 3). */
function markdownLinkTarget(m) {
    return (m[2] ?? m[3]).trim();
}
/**
 * Split one wikilink body. Obsidian syntax: `path/to/note.md#锚点|别名`;
 * the first `|` starts the alias and the first `#` (before any `|`) starts the
 * anchor.
 */
export function parseLinkBody(inner, embedded) {
    let targetPart = inner.trim();
    let alias;
    const pipeIdx = targetPart.indexOf('|');
    if (pipeIdx >= 0) {
        alias = targetPart.slice(pipeIdx) || undefined;
        targetPart = targetPart.slice(0, pipeIdx);
    }
    let anchor;
    const hashIdx = targetPart.indexOf('#');
    if (hashIdx >= 0) {
        anchor = targetPart.slice(hashIdx) || undefined;
        targetPart = targetPart.slice(0, hashIdx);
    }
    const pathPart = targetPart.trim().replace(/\.md$/, '');
    return {
        raw: inner,
        pathPart,
        stem: (pathPart.split('/').pop() ?? '') || pathPart,
        anchor,
        alias,
        embedded,
    };
}
/** Build a link resolver from the notes of one vault walk. */
export function buildLinkResolver(notes) {
    const byStem = new Map();
    const byPath = new Map();
    for (const note of notes) {
        const rel = note.path.replace(/\.md$/, '');
        byPath.set(rel.toLowerCase(), rel);
        const key = stemOf(rel).toLowerCase();
        const list = byStem.get(key);
        if (list)
            list.push(rel);
        else
            byStem.set(key, [rel]);
    }
    for (const list of byStem.values()) {
        list.sort((a, b) => a.length - b.length || a.localeCompare(b));
    }
    return { byStem, byPath, byAlias: new Map() };
}
/**
 * Index frontmatter `aliases` from note bodies into `resolver.byAlias`, so
 * links written as `[[alias]]` resolve like Obsidian's alias handling. Bodies
 * are consumed only when already in hand (rename pre-scan, backlink scan) —
 * this never triggers reads of its own. For a duplicate alias the winning
 * note is the shortest path (ties lexicographic), matching the resolver's
 * bare-stem disambiguation.
 */
export function indexAliases(resolver, entries) {
    const seen = new Set();
    for (const { path, body } of entries) {
        const fm = parseFrontmatter(body);
        if (!fm.present || fm.issues.length > 0)
            continue;
        const rel = path.replace(/\.md$/, '');
        for (const field of fm.fields) {
            if (field.key.toLowerCase() !== 'aliases')
                continue;
            for (const alias of splitListValue(field.value)) {
                const key = alias.toLowerCase();
                if (key === '' || seen.has(key))
                    continue;
                seen.add(key);
                const existing = resolver.byAlias.get(key);
                if (!existing || rel.length < existing.length || (rel.length === existing.length && rel.localeCompare(existing) < 0)) {
                    resolver.byAlias.set(key, rel);
                }
            }
        }
    }
}
/**
 * Resolve one link target part against known notes, or `undefined` when the
 * link points at no existing note. Matching is case-insensitive, mirroring
 * Obsidian's link resolution; a bare target consults frontmatter aliases
 * before file stems.
 */
export function resolveLinkTarget(resolver, pathPart, stem) {
    const norm = pathPart.trim().replace(/\.md$/, '');
    if (norm.includes('/')) {
        return resolver.byPath.get(norm.toLowerCase());
    }
    const alias = resolver.byAlias.get(norm.toLowerCase());
    if (alias)
        return alias;
    const candidates = resolver.byStem.get(stem.toLowerCase());
    if (!candidates || candidates.length === 0)
        return undefined;
    // Obsidian resolves a bare link to the shortest unique path; sorted order
    // (shortest, then lexicographic) makes ties deterministic.
    return candidates[0];
}
/** Vault-relative directory of a note path (`''` for the vault root). */
export function dirOf(rel) {
    const i = rel.lastIndexOf('/');
    return i < 0 ? '' : rel.slice(0, i);
}
/** True when a wikilink hit matches the queried target. */
function isWikilinkHit(resolved, parsed, targetRel, targetStem) {
    if (targetRel !== undefined) {
        return resolved !== undefined && resolved.toLowerCase() === targetRel.toLowerCase();
    }
    // Title mode: the bare stem matches, or the link resolved through an alias
    // (or a path-qualified target) to a note whose stem matches the query title.
    return targetStem !== undefined && (parsed.stem.toLowerCase() === targetStem.toLowerCase()
        || (resolved !== undefined && stemOf(resolved).toLowerCase() === targetStem.toLowerCase()));
}
/**
 * Find notes that link to a note matched by `target` — via `[[wikilink]]`
 * and/or markdown `[text](path)` links, mirroring Obsidian's backlinks pane
 * which reports both syntaxes. Markdown targets resolve relative to each
 * referencing note's folder (or vault-root-relative with a leading `/`).
 */
export async function findBacklinks(fs, notes, target, signal, cache, concurrency = 8, format = 'wikilink') {
    const targetRel = target.path?.replace(/\.md$/, '');
    const targetStem = target.title?.replace(/\.md$/, '');
    const resolver = buildLinkResolver(notes);
    const bodies = await mapLimit(notes, concurrency, async (note) => ({
        note,
        body: await readBodyCached(fs, note, cache, signal),
    }));
    // Index frontmatter aliases from the bodies we already read, so `[[alias]]`
    // links resolve to the aliased note (and match backlink queries by title).
    indexAliases(resolver, bodies.flatMap((b) => b.body ? [{ path: b.note.path, body: b.body.text }] : []));
    const checkWikilink = format === 'wikilink' || format === 'all';
    const checkMarkdown = format === 'markdown' || format === 'all';
    const hits = [];
    for (const { note, body } of bodies) {
        const text = body?.text ?? '';
        const noteDir = dirOf(note.path);
        let hit;
        if (checkWikilink) {
            const linkRe = /!?\[\[([^\[\]]+)\]\]/g;
            let m;
            while ((m = linkRe.exec(text)) !== null) {
                const parsed = parseLinkBody(m[1], m[0].startsWith('!'));
                if (!parsed.stem)
                    continue;
                const resolved = resolveLinkTarget(resolver, parsed.pathPart, parsed.stem);
                if (isWikilinkHit(resolved, parsed, targetRel, targetStem)) {
                    hit = { path: note.path, snippet: excerptAround(text, m.index, m[0].length) };
                    break;
                }
            }
        }
        if (!hit && checkMarkdown) {
            let m;
            while ((m = MARKDOWN_LINK_RE.exec(text)) !== null) {
                const resolved = resolveMarkdownTarget(markdownLinkTarget(m), noteDir, resolver);
                if (!resolved)
                    continue;
                const isHit = targetRel !== undefined
                    ? resolved.toLowerCase() === targetRel.toLowerCase()
                    : targetStem !== undefined && stemOf(resolved).toLowerCase() === targetStem.toLowerCase();
                if (isHit) {
                    hit = { path: note.path, snippet: excerptAround(text, m.index, m[0].length) };
                    break;
                }
            }
        }
        if (hit)
            hits.push(hit);
    }
    return hits;
}
/**
 * Best-effort parser for Obsidian frontmatter. Handles the common flat
 * `key: value` subset plus block lists (`- item`) and inline arrays
 * (`[a, b]`); anything fancier (nested mappings, quoted colons) is reported
 * in `issues` rather than mis-parsed. No YAML dependency is required.
 */
export function parseFrontmatter(content) {
    const result = { present: false, raw: '', fields: [], valid: false, issues: [] };
    if (!content.startsWith('---')) {
        result.issues.push('正文不以 --- 开头，没有 frontmatter');
        return result;
    }
    const lines = content.split('\n');
    const fence = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (fence < 0) {
        result.issues.push('frontmatter 起始围栏 --- 未闭合');
        return result;
    }
    result.present = true;
    result.raw = lines.slice(1, fence).join('\n');
    result.valid = true;
    const block = lines.slice(1, fence);
    let lastKey = null;
    let lastIndent = -1;
    for (const rawLine of block) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#'))
            continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        const listMatch = /^-\s+(.*)$/.exec(trimmed);
        if (listMatch) {
            if (lastKey) {
                const field = result.fields.find((f) => f.key === lastKey);
                if (field)
                    field.value = field.value ? `${field.value}, ${listMatch[1]}` : listMatch[1];
            }
            else {
                result.issues.push(`列表项出现在键之前：${trimmed}`);
            }
            continue;
        }
        const kv = /^([^:#][^:]*):\s*(.*)$/.exec(trimmed);
        if (!kv) {
            result.issues.push(`无法解析的行（疑似嵌套或复杂 YAML）：${trimmed}`);
            continue;
        }
        // A key indented deeper than the previous key is a nested mapping (or an
        // indented block), not a top-level property. Rather than silently flatten
        // it into a top-level field, flag it so `valid` turns false.
        if (lastKey && indent > lastIndent) {
            result.issues.push(`疑似嵌套 YAML（未按顶层字段解析）：${trimmed}`);
            continue;
        }
        const key = kv[1].trim();
        let value = kv[2].trim();
        // Strip one matching pair of surrounding quotes.
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        result.fields.push({ key, value });
        lastKey = key;
        lastIndent = indent;
    }
    // A line-level parse problem makes the frontmatter not fully valid, even
    // though the fences themselves are well-formed.
    if (result.issues.length > 0)
        result.valid = false;
    return result;
}
/** Split a comma/array-ish property value (`[a, b]`, `a, b`) into trimmed items. */
export function splitListValue(value) {
    return value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/**
 * Extract every tag from a note body: inline Obsidian tags (`#tag`,
 * `#nested/tag` — not markdown headings, not `##x`) plus `tags`/`tag`
 * frontmatter properties (inline arrays and block lists, which
 * {@link parseFrontmatter} already merges). Best-effort: tags inside code
 * fences are still reported. Order is first-seen; results are deduplicated.
 */
export function extractTags(content) {
    const tags = new Set();
    // Inline tags: a `#` not preceded by a tag character, `#`, or `/` (so
    // `##x` / `C#tag` / `a#tag` are not tags), followed by tag characters
    // (letter/number/underscore/hyphen/slash). `# Heading` is not a tag; a
    // trailing `.`/`,`/`。` is not part of the tag. Chinese punctuation before
    // the `#` is a valid boundary (`，#tag` matches).
    const inlineRe = /(?<![\p{L}\p{N}_/#-])#([\p{L}\p{N}_/-]+)/gu;
    let m;
    while ((m = inlineRe.exec(content)) !== null) {
        tags.add(m[1]);
    }
    const fm = parseFrontmatter(content);
    for (const field of fm.fields) {
        const key = field.key.toLowerCase();
        if (key === 'tags' || key === 'tag') {
            for (const t of splitListValue(field.value))
                tags.add(t);
        }
    }
    return [...tags];
}
/**
 * Find notes carrying a tag, matching Obsidian's `#tag` search semantics: the
 * query matches the exact tag or any nested subtag under it (`tag/sub`).
 * Scans inline tags and frontmatter `tags`/`tag` properties. Matching happens
 * inside the read workers and stops once `limit` hits are found.
 */
export async function findNotesByTag(fs, notes, query, limit, signal, cache, concurrency = 8) {
    const q = query.trim().toLowerCase();
    const found = [];
    let filled = false;
    await mapLimit(notes, concurrency, async (note, index) => {
        if (filled)
            return;
        const body = await readBodyCached(fs, note, cache, signal);
        const all = extractTags(body?.text ?? '');
        const matched = all
            .filter((t) => {
            const l = t.toLowerCase();
            return l === q || l.startsWith(q + '/');
        })
            .sort();
        if (matched.length > 0 && found.length < limit) {
            found.push({ index, hit: { path: note.path, tags: matched } });
            if (found.length >= limit)
                filled = true;
        }
    });
    found.sort((a, b) => a.index - b.index);
    return found.map((f) => f.hit);
}
export async function listFolders(fs, root, ignoreDirs, signal, containRoot = false, concurrency = 8) {
    const counts = new Map();
    counts.set('', 0);
    let level = [{ dir: root, rel: '' }];
    while (level.length > 0) {
        const nextLevel = [];
        await mapLimit(level, concurrency, async ({ dir, rel }) => {
            const entries = await fs.listDir(dir, signal);
            for (const entry of entries) {
                if (containRoot && !fs.contains(root, entry.target))
                    continue;
                if (entry.type === 'directory') {
                    if (!isIgnoredDir(entry.name, ignoreDirs)) {
                        const relDir = joinRel(rel, entry.name);
                        counts.set(relDir, 0);
                        nextLevel.push({ dir: entry.target, rel: relDir });
                    }
                }
                else if (entry.type === 'file' && entry.name.endsWith('.md')) {
                    counts.set(rel, (counts.get(rel) ?? 0) + 1);
                }
            }
        });
        level = nextLevel;
    }
    return [...counts.entries()]
        .map(([path, notes]) => ({ path, notes }))
        .sort((a, b) => a.path.localeCompare(b.path));
}
/** Extract every wikilink target (deduplicated) from a note body. */
export function extractLinks(body) {
    const seen = new Set();
    const links = [];
    const linkRe = /!?\[\[([^\[\]]+)\]\]/g;
    let m;
    while ((m = linkRe.exec(body)) !== null) {
        const inner = m[1].trim();
        if (inner === '')
            continue;
        const parsed = parseLinkBody(inner, m[0].startsWith('!'));
        if (!parsed.stem)
            continue;
        // Deduplicate by the resolved link identity (path + anchor + embed flag),
        // NOT by `stem`: links whose basenames collide — e.g. `dir/a` vs `other/a`,
        // or `a#x` vs `a#y` — are different links and must all be kept.
        const identity = `${parsed.embedded ? '!' : ''}${parsed.pathPart}${parsed.anchor ?? ''}`;
        if (seen.has(identity))
            continue;
        seen.add(identity);
        links.push({
            target: inner,
            stem: parsed.stem,
            anchor: parsed.anchor?.slice(1),
            alias: parsed.alias?.slice(1),
            embedded: parsed.embedded,
        });
    }
    return links;
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
export function rewriteWikilinks(body, newStem, newRelPath, resolver, oldRelNoExt) {
    const newRel = newRelPath.replace(/\.md$/, '');
    const oldKey = oldRelNoExt.toLowerCase();
    const linkRe = /!?\[\[([^\[\]]+)\]\]/g;
    let count = 0;
    const text = body.replace(linkRe, (whole, inner) => {
        const parsed = parseLinkBody(inner, whole.startsWith('!'));
        if (!parsed.stem)
            return whole;
        const resolved = resolveLinkTarget(resolver, parsed.pathPart, parsed.stem);
        // Only rewrite when this link actually points at the note being renamed.
        if (!resolved || resolved.toLowerCase() !== oldKey)
            return whole;
        count++;
        const hasDir = parsed.pathPart.includes('/');
        const newTarget = hasDir ? newRel : newStem;
        return `${parsed.embedded ? '!' : ''}[[${newTarget}${parsed.anchor ?? ''}${parsed.alias ?? ''}]]`;
    });
    return { text, count };
}
/** Strip a trailing `.md` (case-insensitive) from a link target. */
function stripMd(p) {
    return p.replace(/\.md$/i, '');
}
/**
 * Extract every markdown link `[text](target)` (not image embeds
 * `![…](…)`). Targets keep their `#anchor`; angle-bracket forms
 * (`[x](<path>)`) are normalized to their inner path.
 */
export function extractMarkdownLinks(body) {
    const links = [];
    let m;
    while ((m = MARKDOWN_LINK_RE.exec(body)) !== null) {
        let target = markdownLinkTarget(m);
        if (target.startsWith('<') && target.endsWith('>'))
            target = target.slice(1, -1);
        links.push({ target, text: m[1], index: m.index });
    }
    return links;
}
/**
 * Resolve a markdown link target (`dir/note`, `../note.md`, `/root/note`,
 * `note#heading`, `<path with spaces>`) against known notes, relative to the
 * note's own folder. Returns the vault-relative path without `.md`, or
 * `undefined` for external URLs (`http:`, `mailto:`, …), heading-only links,
 * links that escape above the vault root, and unresolvable paths.
 */
export function resolveMarkdownTarget(rawTarget, noteDir, resolver) {
    let target = rawTarget.trim();
    if (target.startsWith('<') && target.endsWith('>'))
        target = target.slice(1, -1);
    const hashIdx = target.indexOf('#');
    let pathPart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
    if (pathPart === '')
        return undefined; // heading-only link
    // External URL, but keep a Windows drive letter (`C:\…`) as a path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart) && !/^[a-z]:[\\/]/i.test(pathPart))
        return undefined;
    pathPart = pathPart.replace(/\\/g, '/');
    if (pathPart.startsWith('/')) {
        pathPart = pathPart.slice(1); // vault-root-relative
    }
    else if (noteDir !== '') {
        pathPart = path.posix.normalize(`${noteDir}/${pathPart}`);
        if (pathPart.startsWith('../'))
            return undefined; // escaped above the vault
    }
    return resolver.byPath.get(stripMd(pathPart).toLowerCase());
}
/**
 * Vault-relative path from `fromDir` (a note's folder, `''` = vault root) to
 * `toRelNoExt`, using `../` segments so a markdown link stays correct after a
 * cross-directory move. `''` when the path is inside the same folder.
 */
export function relativePath(fromDir, toRelNoExt) {
    const from = fromDir === '' ? [] : fromDir.split('/');
    const to = toRelNoExt.split('/');
    let i = 0;
    while (i < from.length && i < to.length && from[i] === to[i])
        i++;
    const up = from.length - i;
    const parts = [...Array.from({ length: up }, () => '..'), ...to.slice(i)];
    return parts.join('/');
}
/**
 * Rewrite every markdown link `[text](target)` that resolves to the renamed
 * note so it points at the new location — the markdown counterpart of
 * {@link rewriteWikilinks}, mirroring Obsidian's "Automatically update
 * internal links" setting which covers both syntaxes. Targets are re-derived
 * relative to each referencing note's folder, so links survive cross-directory
 * moves; external URLs and links to other notes are left untouched.
 */
export function rewriteMarkdownLinks(body, newRelPath, resolver, oldRelNoExt, noteDir) {
    const newRel = newRelPath.replace(/\.md$/, '');
    const oldKey = oldRelNoExt.toLowerCase();
    let count = 0;
    const text = body.replace(MARKDOWN_LINK_RE, (whole, ...args) => {
        const linkText = args[0];
        // 正则的两个备选分支保证其一匹配；空串兜底仅用于满足类型收窄。
        const rawTarget = ((args[1] ?? args[2]) ?? '').trim();
        const resolved = resolveMarkdownTarget(rawTarget, noteDir, resolver);
        if (!resolved || resolved.toLowerCase() !== oldKey)
            return whole;
        count++;
        const wasAngle = args[1] !== undefined;
        const hashIdx = rawTarget.indexOf('#');
        const anchor = hashIdx >= 0 ? rawTarget.slice(hashIdx) : '';
        const newTarget = relativePath(noteDir, newRel);
        const rendered = wasAngle ? `<${newTarget}${anchor}>` : `${newTarget}${anchor}`;
        return `[${linkText}](${rendered})`;
    });
    return { text, count };
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
export function applyFrontmatterUpdate(content, set, del) {
    const setEntries = Object.entries(set);
    for (const [k, v] of setEntries) {
        if (/\n/.test(v))
            throw new VaultError(`frontmatter 值必须单行（字段 ${k} 的取值含换行）；列表请用内联数组 [a, b]`, VaultCode.FRONTMATTER_MULTILINE);
    }
    const changes = [
        ...setEntries.map(([key, value]) => ({ op: 'set', key, value })),
        ...del.map((key) => ({ op: 'delete', key })),
    ];
    const parsed = parseFrontmatter(content);
    if (!parsed.present) {
        if (content.startsWith('---')) {
            throw new VaultError('frontmatter 起始围栏未闭合，无法安全修改；请先修复笔记格式', VaultCode.FRONTMATTER_UNCLOSED);
        }
        if (setEntries.length === 0) {
            throw new VaultError('笔记没有 frontmatter，无法删除字段；如需新建请同时传 set', VaultCode.FRONTMATTER_NO_FIELDS);
        }
        const block = setEntries.map(([k, v]) => `${k}: ${v}`).join('\n');
        const fm = `---\n${block}\n---`;
        const body = content.replace(/^\uFEFF/, '');
        return { text: body.trim() === '' ? fm : `${fm}\n${body}`, created: true, changes };
    }
    const lines = content.split('\n');
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    const block = lines.slice(1, close);
    const rest = lines.slice(close + 1);
    const remaining = new Set(del);
    const setMap = new Map(setEntries);
    const out = [];
    // Dropping the old value block of a deleted or replaced key: skip every
    // following line until the next top-level key line.
    let dropping = false;
    for (const rawLine of block) {
        const trimmed = rawLine.trim();
        const indent = rawLine.length - rawLine.trimStart().length;
        const kv = indent === 0 ? /^([^:#][^:]*):\s*(.*)$/.exec(trimmed) : null;
        if (dropping) {
            if (kv)
                dropping = false;
            else
                continue;
        }
        if (kv) {
            const key = kv[1].trim();
            if (remaining.has(key)) {
                remaining.delete(key);
                dropping = true;
                continue;
            }
            if (setMap.has(key)) {
                const value = setMap.get(key);
                setMap.delete(key);
                out.push(`${key}: ${value}`);
                dropping = true;
                continue;
            }
            out.push(rawLine);
            continue;
        }
        out.push(rawLine);
    }
    for (const [key, value] of setMap)
        out.push(`${key}: ${value}`);
    const newBlock = out.join('\n');
    const text = `---\n${newBlock}\n---` + (rest.length > 0 ? `\n${rest.join('\n')}` : '');
    return { text, created: false, changes };
}
