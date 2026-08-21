import { HarnessError } from '@deepseek-ai/dsh-llm';
/**
 * 所有 vault_* 工具抛出的失败基类。宿主工具注册表会把 HarnessError 子类的
 * `{ name, code }` 放进 `ToolFailure.info`（程序可路由）；`message` 则原样
 * 出现在模型可见的 `Error: <message>` 里（含中文描述与恢复指令）。
 * code 一旦发布即为稳定契约，语义不变则码不变。
 */
export declare class VaultError extends HarnessError {
}
/**
 * 工具自身语义的稳定错误码（`VAULT_*` 前缀，对齐宿主 SCREAMING_SNAKE 词表）。
 * fs 语义失败（版本不匹配 / 未观察 / 编辑歧义 / 未找到等）复用宿主的
 * `FsErrorCode`（`FS_*`），不在此重复造码。
 */
export declare const VaultCode: {
    /** 库名在已发现列表与配置里都找不到 */
    readonly UNKNOWN_VAULT: "VAULT_UNKNOWN_VAULT";
    /** 传了未注册的绝对路径且 allowArbitraryRoots 关闭 */
    readonly ROOT_UNREGISTERED: "VAULT_ROOT_UNREGISTERED";
    /** 笔记路径非法（空 / 盘符 / .. 穿越 / 缺文件名） */
    readonly PATH_INVALID: "VAULT_PATH_INVALID";
    /** 笔记路径越出 vault（或经符号链接指向库外） */
    readonly PATH_ESCAPE: "VAULT_PATH_ESCAPE";
    /** 参数校验失败（query/tag/old_string/content/title 为空等） */
    readonly INVALID_ARGS: "VAULT_INVALID_ARGS";
    /** 笔记不存在 */
    readonly NOTE_NOT_FOUND: "VAULT_NOTE_NOT_FOUND";
    /** 路径存在但不是文件 */
    readonly NOT_FILE: "VAULT_NOT_FILE";
    /** 目标已存在（需 overwrite / unique） */
    readonly EXISTS: "VAULT_EXISTS";
    /** frontmatter 起始围栏未闭合 */
    readonly FRONTMATTER_UNCLOSED: "VAULT_FRONTMATTER_UNCLOSED";
    /** frontmatter 值含换行（必须单行标量或内联数组） */
    readonly FRONTMATTER_MULTILINE: "VAULT_FRONTMATTER_MULTILINE";
    /** 笔记没有 frontmatter 且只传了 delete */
    readonly FRONTMATTER_NO_FIELDS: "VAULT_FRONTMATTER_NO_FIELDS";
    /** 正则表达式无效 */
    readonly REGEX_INVALID: "VAULT_REGEX_INVALID";
    /** 重命名时改写全库引用失败（含回滚成功后的包装） */
    readonly RENAME_UPDATE_FAILED: "VAULT_RENAME_UPDATE_FAILED";
    /** 重命名回滚本身失败（残留，需人工检查） */
    readonly RENAME_ROLLBACK_FAILED: "VAULT_RENAME_ROLLBACK_FAILED";
    /** 写跳转占位失败（重命名主体已完成） */
    readonly RENAME_STUB_FAILED: "VAULT_RENAME_STUB_FAILED";
    /** 回收站删除需要 dsh-dock Obsidian API 桥（文件模式无删除原语） */
    readonly TRASH_UNAVAILABLE: "VAULT_TRASH_UNAVAILABLE";
    /** 打开笔记需要 Obsidian 运行与 dsh-dock 桥 */
    readonly OPEN_UNAVAILABLE: "VAULT_OPEN_UNAVAILABLE";
};
export type VaultCode = (typeof VaultCode)[keyof typeof VaultCode];
/**
 * 从抛出的值里取出稳定 code（FsError / VaultError 自带），取不到时用 fallback。
 * 用于 catch 后重抛时保留底层错误码（如 `FS_STALE_VERSION`），避免降级成通用码。
 */
export declare function errorCode(err: unknown, fallback: string): string;
