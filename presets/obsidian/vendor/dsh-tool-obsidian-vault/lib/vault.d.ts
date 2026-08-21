import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
/**
 * A note (markdown, or any file when walking with `includeAll`) found while
 * walking the vault.
 */
export interface VaultNote {
    /** Vault-relative path, '/'-joined, without a leading slash. */
    path: string;
    /** Resolved target for a direct `fs.readText` without re-resolving. */
    target: FsTarget;
    /** Byte size when the backend reported it. */
    size?: number;
    /** Freshness token reported by `listDir` when available (skips a `stat`). */
    version?: string;
    /**
     * Lowercased file extension without the dot (`md`, `png`, …) for
     * non-markdown files collected by an `includeAll` walk; `md` for notes.
     * `''` for files without an extension. Absent for `.md`-only walks.
     */
    extension?: string;
}
/** A search / backlink hit with a short excerpt. */
export interface NoteHit {
    path: string;
    snippet: string;
}
/** One Obsidian vault discovered from the global registry. */
export interface DiscoveredVault {
    /** The vault's display name (its folder's basename). */
    name: string;
    /** Absolute path to the vault root. */
    path: string;
    /** Whether this vault is the one currently open in Obsidian. */
    open?: boolean;
    /**
     * Epoch-ms mtime of `<vault>/.obsidian/workspace.json` — the last time that
     * vault window saved its workspace layout (`Workspace.requestSaveLayout`,
     * debounced on focus / layout change). Used to rank open vaults by how
     * recently their window was active. Absent when the file does not exist.
     */
    activeAt?: number;
}
/** Platform-specific location of Obsidian's global vault registry. */
export declare function obsidianConfigPath(): string | undefined;
/**
 * The vault dsh-dock binds this service to: `DSH_OBSIDIAN_VAULT_NAME` /
 * `DSH_OBSIDIAN_VAULT_PATH` (see dsh-dock src/main.ts). In per-vault mode
 * each vault gets its own dsh service, so this env IS the vault this service
 * serves — the authoritative binding, stronger than any "recently active"
 * guess. Shared mode has no env; callers fall back to activity ranking.
 */
export declare function injectedVaultPath(): string | undefined;
/** The injected vault's display name (its folder's basename), when bound. */
export declare function injectedVaultName(): string | undefined;
/**
 * Discover every Obsidian vault registered in the global config
 * (`obsidian.json`), which the desktop app writes on launch. Missing or
 * unreadable registry yields an empty list — callers then fall back to the
 * session workspace, so discovery failures are never fatal. Results are
 * cached for {@link DISCOVER_TTL_MS} (a failed discovery is not cached);
 * workspace-activity changes propagate within the TTL.
 */
export declare function discoverVaults(): Promise<DiscoveredVault[]>;
/**
 * Pick the vault a tool call without an explicit `vault` argument should
 * operate on, among currently open vaults: the one whose window was most
 * recently active (newest `.obsidian/workspace.json`), ties broken by name.
 * Returns `undefined` when no open vault qualifies, so callers fall through to
 * the session workspace.
 */
export declare function selectCurrentVault(vaults: readonly DiscoveredVault[]): DiscoveredVault | undefined;
/** Skip dot-directories and any name the user listed in `ignoreDirs`. */
export declare function isIgnoredDir(name: string, ignoreDirs: readonly string[]): boolean;
/** Join a vault-relative directory and a child name with '/'. */
export declare function joinRel(dir: string, name: string): string;
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
export declare function walkNotes(fs: FileSystem, root: FsTarget, ignoreDirs: readonly string[], signal?: AbortSignal, containRoot?: boolean, includeAll?: boolean, concurrency?: number): Promise<VaultNote[]>;
/**
 * A per-session cache of note bodies, keyed by the target's opaque key and
 * validated against the `fs.stat` version token. Re-reading a note is skipped
 * entirely when the version is unchanged, so repeated searches / backlink
 * queries over the same vault read changed files only. Keying by target key
 * (an absolute path with the local backend) keeps caches isolated across
 * different vaults even when relative paths collide.
 */
export interface NoteBodyCache {
    entries: Map<string, {
        version: string;
        text: string;
    }>;
}
/** Create an empty note-body cache. */
export declare function createBodyCache(): NoteBodyCache;
/** Run `fn` over `items` with at most `limit` promises in flight. */
export declare function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
/** Options for {@link searchNotes}, mirroring Obsidian's search syntax subset. */
export interface SearchOptions {
    /** Treat `query` as a regular expression instead of literal text. */
    regex?: boolean;
    /** Case-sensitive matching. Default: case-insensitive (like Obsidian). */
    caseSensitive?: boolean;
    /**
     * When set (literal mode), split `query` on whitespace and require EVERY
     * token to match (AND semantics, like Obsidian's default multi-term search).
     * Default: the whole `query` is one literal substring, so `"a b"` matches
     * only the exact adjacent text `a b`.
     */
    matchAll?: boolean;
}
/**
 * Case-insensitive keyword search across note file names and bodies.
 * Reads run with bounded concurrency and reuse `cache` (validated by version)
 * to skip unchanged files on repeat queries. Matching happens inside the read
 * workers and stops early once `limit` hits are found, so a sparse hit set
 * does not force a full-vault body read.
 */
export declare function searchNotes(fs: FileSystem, notes: VaultNote[], query: string, limit: number, signal?: AbortSignal, cache?: NoteBodyCache, concurrency?: number, opts?: SearchOptions): Promise<NoteHit[]>;
/** Basename stem of a vault-relative note path (no directories, no `.md`). */
export declare function stemOf(relPath: string): string;
/** One `[[wikilink]]` body (without brackets) split into its parts. */
export interface ParsedLink {
    /** The raw body between the brackets. */
    raw: string;
    /** Target path part (no anchor, no alias, no `.md`), e.g. `dir/name`. */
    pathPart: string;
    /** Basename stem of the target. */
    stem: string;
    /** Anchor including the leading `#`, when present. */
    anchor?: string;
    /** Alias including the leading `|`, when present. */
    alias?: string;
    /** Whether the link is an embed (`![[...]]`). */
    embedded: boolean;
}
/**
 * Split one wikilink body. Obsidian syntax: `path/to/note.md#锚点|别名`;
 * the first `|` starts the alias and the first `#` (before any `|`) starts the
 * anchor.
 */
export declare function parseLinkBody(inner: string, embedded: boolean): ParsedLink;
/**
 * Index over every known note path for resolving links the way Obsidian does:
 * a path-qualified link matches one exact vault-relative path; a bare-stem
 * link matches the shortest unique path (ties break lexicographically).
 * Frontmatter aliases populate `byAlias` lazily via {@link indexAliases}
 * (bodies are not read here — callers with bodies in hand add them).
 */
export interface LinkResolver {
    /** Lowercased stem → candidate rel paths, sorted shortest-first. */
    byStem: Map<string, string[]>;
    /** Lowercased rel path (no `.md`) → original rel path. */
    byPath: Map<string, string>;
    /**
     * Lowercased frontmatter alias → rel path (no `.md`). Obsidian resolves
     * `[[alias]]` before the same-named file, so {@link resolveLinkTarget}
     * consults this before the byStem fallback.
     */
    byAlias: Map<string, string>;
}
/** Build a link resolver from the notes of one vault walk. */
export declare function buildLinkResolver(notes: readonly VaultNote[]): LinkResolver;
/**
 * Index frontmatter `aliases` from note bodies into `resolver.byAlias`, so
 * links written as `[[alias]]` resolve like Obsidian's alias handling. Bodies
 * are consumed only when already in hand (rename pre-scan, backlink scan) —
 * this never triggers reads of its own. For a duplicate alias the winning
 * note is the shortest path (ties lexicographic), matching the resolver's
 * bare-stem disambiguation.
 */
export declare function indexAliases(resolver: LinkResolver, entries: Iterable<{
    path: string;
    body: string;
}>): void;
/**
 * Resolve one link target part against known notes, or `undefined` when the
 * link points at no existing note. Matching is case-insensitive, mirroring
 * Obsidian's link resolution; a bare target consults frontmatter aliases
 * before file stems.
 */
export declare function resolveLinkTarget(resolver: LinkResolver, pathPart: string, stem: string): string | undefined;
/** Which note a backlink query targets. */
export interface BacklinkTarget {
    /** Exact vault-relative note path (no `.md`); links resolve to this path only. */
    path?: string;
    /** Fallback: match links whose target stem equals this title (any path). */
    title?: string;
}
/** Which link syntaxes a backlink query should consider. */
export type BacklinkFormat = 'wikilink' | 'markdown' | 'all';
/** Vault-relative directory of a note path (`''` for the vault root). */
export declare function dirOf(rel: string): string;
/**
 * Find notes that link to a note matched by `target` — via `[[wikilink]]`
 * and/or markdown `[text](path)` links, mirroring Obsidian's backlinks pane
 * which reports both syntaxes. Markdown targets resolve relative to each
 * referencing note's folder (or vault-root-relative with a leading `/`).
 */
export declare function findBacklinks(fs: FileSystem, notes: VaultNote[], target: BacklinkTarget, signal?: AbortSignal, cache?: NoteBodyCache, concurrency?: number, format?: BacklinkFormat): Promise<NoteHit[]>;
/** One key/value pair parsed out of a note's frontmatter. */
export interface FrontmatterField {
    key: string;
    value: string;
}
/** Structured view of a note's frontmatter (the YAML between `---` fences). */
export interface ParsedFrontmatter {
    /** Whether the note begins with a `---` fence at all. */
    present: boolean;
    /** Raw text between the two fences (excluding the fence lines). */
    raw: string;
    /** Keys parsed with a best-effort line-level YAML subset. */
    fields: FrontmatterField[];
    /** True when the fences are well-formed (opened and closed). */
    valid: boolean;
    /** Human-readable problems found while parsing. */
    issues: string[];
}
/**
 * Best-effort parser for Obsidian frontmatter. Handles the common flat
 * `key: value` subset plus block lists (`- item`) and inline arrays
 * (`[a, b]`); anything fancier (nested mappings, quoted colons) is reported
 * in `issues` rather than mis-parsed. No YAML dependency is required.
 */
export declare function parseFrontmatter(content: string): ParsedFrontmatter;
/** Split a comma/array-ish property value (`[a, b]`, `a, b`) into trimmed items. */
export declare function splitListValue(value: string): string[];
/**
 * Extract every tag from a note body: inline Obsidian tags (`#tag`,
 * `#nested/tag` — not markdown headings, not `##x`) plus `tags`/`tag`
 * frontmatter properties (inline arrays and block lists, which
 * {@link parseFrontmatter} already merges). Best-effort: tags inside code
 * fences are still reported. Order is first-seen; results are deduplicated.
 */
export declare function extractTags(content: string): string[];
/** One tag-search hit. */
export interface TagHit {
    path: string;
    /** The note's tags that matched the query (exact or a subtag under it). */
    tags: string[];
}
/**
 * Find notes carrying a tag, matching Obsidian's `#tag` search semantics: the
 * query matches the exact tag or any nested subtag under it (`tag/sub`).
 * Scans inline tags and frontmatter `tags`/`tag` properties. Matching happens
 * inside the read workers and stops once `limit` hits are found.
 */
export declare function findNotesByTag(fs: FileSystem, notes: VaultNote[], query: string, limit: number, signal?: AbortSignal, cache?: NoteBodyCache, concurrency?: number): Promise<TagHit[]>;
/**
 * Recursively enumerate every folder of the vault with the number of
 * markdown notes directly inside it (like the "File Explorer Note Count"
 * plugin / Obsidian's own sidebar counts). Empty folders are included.
 */
export interface FolderStat {
    /** Vault-relative folder path, '/'-joined; `''` is the vault root. */
    path: string;
    /** Number of `.md` notes directly in this folder (not its subfolders). */
    notes: number;
}
export declare function listFolders(fs: FileSystem, root: FsTarget, ignoreDirs: readonly string[], signal?: AbortSignal, containRoot?: boolean, concurrency?: number): Promise<FolderStat[]>;
/** One outgoing `[[wikilink]]` (or `![[embed]]`) found in a note body. */
export interface OutLink {
    /** The link body without brackets, e.g. `dir/name`, `name#锚点`, `name|别名`. */
    target: string;
    /** Basename stem (no path, no `.md`) the link resolves to. */
    stem: string;
    /** Optional anchor after `#`. */
    anchor?: string;
    /** Optional alias after `|`. */
    alias?: string;
    /** Whether the link is an embed (`![[...]]`). */
    embedded: boolean;
}
/** Extract every wikilink target (deduplicated) from a note body. */
export declare function extractLinks(body: string): OutLink[];
/** Result of rewriting wikilinks that pointed at the old stem. */
export interface LinkRewriteResult {
    /** The full rewritten body. */
    text: string;
    /** How many link occurrences were rewritten. */
    count: number;
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
export declare function rewriteWikilinks(body: string, newStem: string, newRelPath: string, resolver: LinkResolver, oldRelNoExt: string): LinkRewriteResult;
/** One markdown `[text](target)` link occurrence. */
export interface MarkdownLinkHit {
    /** The raw target including any `#anchor` (angle brackets stripped). */
    target: string;
    /** Link text between the brackets. */
    text: string;
    /** Absolute match index in the body. */
    index: number;
}
/**
 * Extract every markdown link `[text](target)` (not image embeds
 * `![…](…)`). Targets keep their `#anchor`; angle-bracket forms
 * (`[x](<path>)`) are normalized to their inner path.
 */
export declare function extractMarkdownLinks(body: string): MarkdownLinkHit[];
/**
 * Resolve a markdown link target (`dir/note`, `../note.md`, `/root/note`,
 * `note#heading`, `<path with spaces>`) against known notes, relative to the
 * note's own folder. Returns the vault-relative path without `.md`, or
 * `undefined` for external URLs (`http:`, `mailto:`, …), heading-only links,
 * links that escape above the vault root, and unresolvable paths.
 */
export declare function resolveMarkdownTarget(rawTarget: string, noteDir: string, resolver: LinkResolver): string | undefined;
/**
 * Vault-relative path from `fromDir` (a note's folder, `''` = vault root) to
 * `toRelNoExt`, using `../` segments so a markdown link stays correct after a
 * cross-directory move. `''` when the path is inside the same folder.
 */
export declare function relativePath(fromDir: string, toRelNoExt: string): string;
/** Result of rewriting markdown links that pointed at the renamed note. */
export interface MarkdownRewriteResult {
    /** The full rewritten body. */
    text: string;
    /** How many link occurrences were rewritten. */
    count: number;
}
/**
 * Rewrite every markdown link `[text](target)` that resolves to the renamed
 * note so it points at the new location — the markdown counterpart of
 * {@link rewriteWikilinks}, mirroring Obsidian's "Automatically update
 * internal links" setting which covers both syntaxes. Targets are re-derived
 * relative to each referencing note's folder, so links survive cross-directory
 * moves; external URLs and links to other notes are left untouched.
 */
export declare function rewriteMarkdownLinks(body: string, newRelPath: string, resolver: LinkResolver, oldRelNoExt: string, noteDir: string): MarkdownRewriteResult;
/** One applied frontmatter change. */
export interface FrontmatterChange {
    op: 'set' | 'delete';
    key: string;
    /** New value for `set` changes. */
    value?: string;
}
/** Result of applying a frontmatter update. */
export interface FrontmatterUpdateResult {
    /** Full rewritten note body. */
    text: string;
    /** Whether a frontmatter block had to be created (the note had none). */
    created: boolean;
    /** The applied changes, in execution order. */
    changes: FrontmatterChange[];
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
export declare function applyFrontmatterUpdate(content: string, set: Record<string, string>, del: readonly string[]): FrontmatterUpdateResult;
