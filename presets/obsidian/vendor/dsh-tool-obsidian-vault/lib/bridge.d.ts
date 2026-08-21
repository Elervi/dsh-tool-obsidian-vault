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
export interface BridgeEnv {
    url: string;
    token: string;
}
/** 从环境变量读桥（dsh-dock spawn 时注入） */
export declare function bridgeEnv(): BridgeEnv | undefined;
/** dsh-dock 的 current-vault 标记文件（含桥地址的共享通道） */
export declare function bridgeMarkerPath(): string;
/** 从标记文件读桥：只有标记文件指向的库 === root 时才采用（shared 多窗口按库匹配） */
export declare function markerBridge(root: string): Promise<BridgeEnv | null>;
export interface BridgeHit {
    path: string;
    snippet: string;
}
export declare class BridgeClient {
    readonly base: string;
    readonly token: string;
    constructor(base: string, token: string);
    private request;
    /** 健康检查：桥是否服务本库（bridgeFor 的解析依据） */
    health(): Promise<{
        ok: boolean;
        vault?: {
            name?: string;
            path?: string;
        };
    }>;
    current(): Promise<{
        name: string;
        path: string;
        activeFile?: string;
        updatedAt: number;
    }>;
    listNotes(opts: {
        folder?: string;
        all?: boolean;
        ignoreDirs: string[];
    }): Promise<{
        total: number;
        notes: Array<{
            path: string;
            size?: number;
            extension?: string;
        }>;
    }>;
    listFolders(opts: {
        folder?: string;
        ignoreDirs: string[];
    }): Promise<{
        total: number;
        folders: Array<{
            path: string;
            notes: number;
        }>;
    }>;
    readNote(rel: string): Promise<{
        path: string;
        content: string;
        size?: number;
        mtime?: number;
    }>;
    metadata(rel: string): Promise<{
        path: string;
        size?: number;
        mtime?: number;
        frontmatter: {
            present: boolean;
            fields: Array<{
                key: string;
                value: string;
            }>;
        };
        tags: string[];
        aliases: string[];
        wikilinks: Array<{
            body: string;
            embedded: boolean;
        }>;
        markdown: Array<{
            target: string;
            text: string;
        }>;
        unresolved: number;
    }>;
    backlinks(req: {
        path?: string;
        title?: string;
        format?: 'wikilink' | 'markdown' | 'all';
    }): Promise<{
        total: number;
        backlinks: BridgeHit[];
        target?: string;
        ambiguous?: boolean;
    }>;
    search(opts: {
        q: string;
        folder?: string;
        limit?: number;
        regex?: boolean;
        case_sensitive?: boolean;
        match_all?: boolean;
        ignoreDirs: string[];
    }): Promise<{
        total: number;
        hits: BridgeHit[];
    }>;
    searchTags(opts: {
        tag: string;
        folder?: string;
        limit?: number;
        ignoreDirs: string[];
    }): Promise<{
        total: number;
        hits: Array<{
            path: string;
            tags: string[];
        }>;
    }>;
    frontmatter(rel: string): Promise<{
        path: string;
        present: boolean;
        valid: boolean;
        fields: Array<{
            key: string;
            value: string;
        }>;
        issues: string[];
    }>;
    writeNote(req: {
        path: string;
        content: string;
        overwrite?: boolean;
        unique?: boolean;
    }): Promise<{
        path: string;
        operation: 'create' | 'update';
        bytes?: number;
    }>;
    appendNote(rel: string, content: string): Promise<{
        path: string;
        operation: 'append';
        addedChars: number;
        bytes?: number;
    }>;
    editNote(req: {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
    }): Promise<{
        path: string;
        before: string;
        after: string;
        matches: number;
    }>;
    updateFrontmatter(req: {
        path: string;
        set?: Record<string, string>;
        delete?: string[];
    }): Promise<{
        path: string;
        created: boolean;
        changes: Array<{
            op: 'set' | 'delete';
            key: string;
            value?: string;
        }>;
        before: Array<{
            key: string;
            value: string;
        }>;
        after: Array<{
            key: string;
            value: string;
        }>;
        issues: string[];
    }>;
    rename(req: {
        old_path: string;
        new_path: string;
        keep_old?: 'keep' | 'stub';
    }): Promise<{
        old_path: string;
        new_path: string;
        totalLinks: number;
        updated: Array<{
            path: string;
            count: number;
        }>;
        old_handling: 'kept' | 'stubbed';
    }>;
    /** 回收站删除（可恢复） */
    trashNote(rel: string): Promise<{
        path: string;
        trashed: true;
    }>;
    /** 在 Obsidian 中打开/聚焦笔记 */
    openNote(rel: string): Promise<{
        path: string;
        opened: true;
    }>;
    /** 全库标签聚合（含计数） */
    allTags(opts: {
        folder?: string;
        ignoreDirs: string[];
    }): Promise<{
        total: number;
        tags: Array<{
            tag: string;
            count: number;
        }>;
    }>;
    /** 生成指向笔记的标准链接文本 */
    noteLink(rel: string, source?: string): Promise<{
        path: string;
        link: string;
        format: 'wikilink' | 'markdown';
    }>;
}
/**
 * 返回服务 `root` 库的桥客户端；不可用（无桥 / 桥服务的不是该库 / 网络失败）
 * 返回 null，调用方回退 ctx.fs 文件模式。结果缓存 TTL 30s（桥的启停不会高频
 * 变化；Obsidian 刚启动时桥未就绪，一次失败不缓存，下次调用重试）。
 */
export declare function bridgeFor(root: string, signal?: AbortSignal): Promise<BridgeClient | null>;
/** 清理 bridgeFor 的健康缓存（测试用） */
export declare function resetBridgeCache(): void;
