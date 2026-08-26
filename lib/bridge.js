/**
 * bridge.ts —— dsh-dock Obsidian API 桥的客户端（工具侧）。
 *
 * 双通道发现桥：
 *   1. env：DSH_OBSIDIAN_BRIDGE_URL + DSH_OBSIDIAN_BRIDGE_TOKEN（dsh-dock
 *      spawn dsh web 时注入，per-vault 模式最权威）；
 *   2. 标记文件：~/.dsh/current-vault.json 的 bridgeUrl/bridgeToken（shared/
 *      custom 多窗口模式下，当前焦点窗口的桥经标记文件暴露）。
 * 命中后 GET /health 校验该桥确实服务目标 vault 根，再缓存 TTL 30s。
 *
 * 失败语义：桥不可用（未装/未开 dsh-dock、Obsidian 未运行、网络抖动）一律
 * 返回 null / 抛 BRIDGE_* 错误，调用方回退文件模式 —— 保证 CLI 直跑 dsh 不退化。
 * 桥返回的 VAULT_* / FS_* 错误码直接映射成 VaultError，与文件模式同一词表。
 */
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultError } from './errors.js';
/**
 * 校验桥 URL 必须指向本机回环（127.0.0.1 / localhost / ::1）的 http(s)，
 * 并去掉尾部斜杠。桥令牌只应发给本机 dsh-dock；若标记文件或 env 被本地
 * 其他进程污染为任意主机，Bearer 令牌会外泄（等同 SSRF），非回环一律拒绝。
 */
function loopbackBridgeUrl(url) {
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
        return null;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1'].includes(host))
        return null;
    return url.replace(/\/+$/, '');
}
/** 从环境变量读桥（dsh-dock spawn 时注入） */
export function bridgeEnv() {
    const url = process.env.DSH_OBSIDIAN_BRIDGE_URL?.trim();
    const token = process.env.DSH_OBSIDIAN_BRIDGE_TOKEN?.trim();
    if (!url || !token)
        return undefined;
    const safe = loopbackBridgeUrl(url);
    if (!safe)
        return undefined;
    return { url: safe, token };
}
/** dsh-dock 的 current-vault 标记文件（含桥地址的共享通道） */
export function bridgeMarkerPath() {
    return path.join(os.homedir(), '.dsh', 'current-vault.json');
}
/** 从标记文件读桥：只有标记文件指向的库 === root 时才采用（shared 多窗口按库匹配） */
export async function markerBridge(root) {
    try {
        const marker = bridgeMarkerPath();
        // 标记文件含桥令牌：POSIX 下拒绝 group/other 可写、属主非当前用户的文件
        // （Obsidian 写的是 644，属主即用户，可通过；666/他人所有则拒绝）。
        const st = await stat(marker);
        if (process.platform !== 'win32') {
            const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
            if ((st.mode & 0o022) !== 0 || (uid !== undefined && st.uid !== uid))
                return null;
        }
        const raw = await readFile(marker, 'utf8');
        const m = JSON.parse(raw);
        // 绝对化后再比较：root 可能是相对 cwd 的兜底路径（process.cwd()），
        // 不做 resolve 时相对/绝对永远不等，标记通道会静默失效。
        const sameRoot = typeof m.path === 'string' && path.resolve(m.path) === path.resolve(root);
        if (typeof m.bridgeUrl === 'string' && typeof m.bridgeToken === 'string' && sameRoot) {
            const safe = loopbackBridgeUrl(m.bridgeUrl);
            if (!safe)
                return null;
            return { url: safe, token: m.bridgeToken };
        }
    }
    catch {
        // 无标记文件 / 损坏 / 非回环 / 不是目标库 → null（回退）
    }
    return null;
}
// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------
/** 合并调用方 AbortSignal 与超时，返回可清理的合并 signal */
function mergeSignal(signal, timeoutMs = 30_000) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        },
    };
}
export class BridgeClient {
    base;
    token;
    constructor(base, token) {
        this.base = base;
        this.token = token;
    }
    async request(method, urlPath, opts = {}) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query ?? {})) {
            if (v !== undefined && v !== '')
                qs.set(k, String(v));
        }
        const url = `${this.base}${urlPath}${qs.size > 0 ? `?${qs.toString()}` : ''}`;
        const { signal, cleanup } = mergeSignal(opts.signal);
        try {
            const resp = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
                signal,
            });
            const text = await resp.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            }
            catch {
                // 非 JSON 响应：按文本错误处理
            }
            if (!resp.ok) {
                const e = data?.error;
                if (e && typeof e.code === 'string' && typeof e.message === 'string') {
                    throw new VaultError(e.message, e.code);
                }
                throw new VaultError(`Obsidian 桥请求失败（HTTP ${resp.status}）：${text.slice(0, 200)}`, 'BRIDGE_REQUEST_FAILED');
            }
            return data;
        }
        catch (err) {
            if (err instanceof VaultError)
                throw err;
            if (err instanceof Error && err.name === 'AbortError')
                throw err;
            throw new VaultError(`Obsidian 桥不可用：${err instanceof Error ? err.message : String(err)}（若 Obsidian 或 DSH Dock 未运行，vault 工具已自动回退文件直读模式）`, 'BRIDGE_UNAVAILABLE');
        }
        finally {
            cleanup();
        }
    }
    // ---- 只读 ----
    /** 健康检查：桥是否服务本库（bridgeFor 的解析依据） */
    async health() {
        return this.request('GET', '/health');
    }
    async current() {
        return this.request('GET', '/v1/current');
    }
    async listNotes(opts) {
        return this.request('GET', '/v1/notes', {
            query: {
                folder: opts.folder,
                all: opts.all ? '1' : undefined,
                ignore: opts.ignoreDirs.join(','),
            },
        });
    }
    async listFolders(opts) {
        return this.request('GET', '/v1/folders', {
            query: { folder: opts.folder, ignore: opts.ignoreDirs.join(',') },
        });
    }
    async readNote(rel) {
        return this.request('GET', '/v1/note', { query: { path: rel } });
    }
    async metadata(rel) {
        return this.request('GET', '/v1/metadata', { query: { path: rel } });
    }
    async backlinks(req) {
        return this.request('GET', '/v1/backlinks', {
            query: { path: req.path, title: req.title, format: req.format },
        });
    }
    async search(opts) {
        return this.request('GET', '/v1/search', {
            query: {
                q: opts.q,
                folder: opts.folder,
                limit: opts.limit,
                regex: opts.regex ? '1' : undefined,
                case_sensitive: opts.case_sensitive ? '1' : undefined,
                match_all: opts.match_all ? '1' : undefined,
                ignore: opts.ignoreDirs.join(','),
            },
        });
    }
    async searchTags(opts) {
        return this.request('GET', '/v1/tags', {
            query: { tag: opts.tag, folder: opts.folder, limit: opts.limit, ignore: opts.ignoreDirs.join(',') },
        });
    }
    async frontmatter(rel) {
        return this.request('GET', '/v1/frontmatter', { query: { path: rel } });
    }
    // ---- 写入 ----
    async writeNote(req) {
        return this.request('POST', '/v1/write', { body: { ...req, op: 'write' } });
    }
    async appendNote(rel, content) {
        return this.request('POST', '/v1/write', { body: { path: rel, content, op: 'append' } });
    }
    async editNote(req) {
        return this.request('POST', '/v1/edit', { body: req });
    }
    async updateFrontmatter(req) {
        return this.request('POST', '/v1/frontmatter', { body: req });
    }
    async rename(req) {
        return this.request('POST', '/v1/rename', { body: req });
    }
    /** 回收站删除（可恢复） */
    async trashNote(rel) {
        return this.request('POST', '/v1/trash', { body: { path: rel } });
    }
    /** 在 Obsidian 中打开/聚焦笔记 */
    async openNote(rel) {
        return this.request('POST', '/v1/open', { body: { path: rel } });
    }
    /** 全库标签聚合（含计数） */
    async allTags(opts) {
        return this.request('GET', '/v1/all-tags', {
            query: { folder: opts.folder, ignore: opts.ignoreDirs.join(',') },
        });
    }
    /** 生成指向笔记的标准链接文本 */
    async noteLink(rel, source) {
        return this.request('POST', '/v1/link', { body: { path: rel, source } });
    }
}
// ---------------------------------------------------------------------------
// 解析：env → 标记文件 → null；健康校验 + TTL 缓存
// ---------------------------------------------------------------------------
const HEALTH_TTL_MS = 30_000;
let healthCache;
/**
 * 返回服务 `root` 库的桥客户端；不可用（无桥 / 桥服务的不是该库 / 网络失败）
 * 返回 null，调用方回退 ctx.fs 文件模式。结果缓存 TTL 30s（桥的启停不会高频
 * 变化；Obsidian 刚启动时桥未就绪，一次失败不缓存，下次调用重试）。
 */
export async function bridgeFor(root, signal) {
    const env = bridgeEnv() ?? (await markerBridge(root));
    if (!env)
        return null;
    const now = Date.now();
    const hit = healthCache;
    if (hit && hit.root === root && now - hit.at < HEALTH_TTL_MS)
        return hit.bridge;
    let bridge = null;
    try {
        const client = new BridgeClient(env.url, env.token);
        const health = await client.health();
        const norm = (p) => (p ?? '').replace(/[\\/]+$/, '');
        if (health?.ok && norm(health.vault?.path) === norm(root))
            bridge = client;
    }
    catch {
        bridge = null;
    }
    healthCache = { root, bridge, at: now };
    return bridge;
}
/** 清理 bridgeFor 的健康缓存（测试用） */
export function resetBridgeCache() {
    healthCache = undefined;
}
