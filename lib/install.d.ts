/**
 * 一条命令安装 / 同步 agent preset：把本包内置的 `presets/obsidian/` 自安装到
 * `$DSH_HOME/.agent-presets/obsidian/`（目录名即预设 id，与手工
 * `cp -R preset ~/.dsh/.agent-presets/obsidian` 落点完全一致）。
 *
 * 触发方式：包以 profile bundle 装入（`dsh plugin --profile web add
 * github:Elervi/dsh-tool-obsidian-vault`），bundle 层用
 * `config: { installPreset: true, registerTools: false }` 挂本插件，
 * `apply()` 在启动时调用 {@link installPreset}，预设随即进入
 * dsh-agent-presets 的 user 根（`~/.dsh/.agent-presets/`），新建会话的
 * 预设选择器里出现「Obsidian 模式」。
 *
 * # 安装与升级的同步语义
 *
 * 首装：整目录拷贝 + 写入基线清单（每文件 SHA-256，见 {@link MANIFEST}）。
 *
 * 升级（目标已存在，`mode: 'merge'`，默认）：把预设当作「插件自带最新快照 +
 * 用户自定义」来合并，绝不破坏用户改动：
 *   - 用户没动过的文件   → 更新到新版（否则升级插件时预设停在旧快照，即本次修复的坑）；
 *   - 用户改过的文件     → 保留用户的（绝不覆盖）；
 *   - 插件新增的文件     → 拷贝进来；
 *   - 插件移除的文件     → 若用户也没改就一并移除；用户改过则保留；
 *   - 你自定义新增的文件 → 保留。
 *
 * 历史遗留（目标已存在但无清单，由旧版插件或手工放下）：按「保留」处理并把
 * 清单以新版快照为基线落地。因缺老快照基线，无法区分「未改动的旧文件」和「用户
 * 改动」——两者都会被视为自定义永久保留；想让这类目录彻底跟上新版，一次性删除
 * `~/.dsh/.agent-presets/obsidian` 后重启，让安装器重新以最新快照建基线。
 *
 * `mode`：
 *   - `'merge'`    幂等同步，保留用户改动（默认）；
 *   - `'preserve'` 历史行为：已存在则永不覆盖；
 *   - `'overwrite'`整目录替换为最新快照（会丢弃用户改动）。
 */
/** 预设 id：目标目录名，须匹配 dsh-agent-presets 的 `PRESET_ID`（小写字母/数字/连字符）。 */
export declare const PRESET_ID = "obsidian";
/**
 * 解析 DSH home：`$DSH_HOME`（非空白）优先，否则 `~/.dsh` —— 与宿主
 * `@deepseek-ai/dsh-home-paths` 的解析顺序一致，不引入新依赖。
 */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
/** 目标已存在时的升级策略。 */
export type PresetMode = 'merge' | 'preserve' | 'overwrite';
export interface InstallPresetOptions {
    /** 预设源目录（包内 `presets/obsidian/`）。默认按本模块位置解析。 */
    source?: string;
    /** DSH home；默认 {@link resolveDshHome}。测试时可用临时目录注入。 */
    home?: string;
    /** 目标预设 id（目录名）；默认 {@link PRESET_ID}。 */
    id?: string;
    /** 日志回调；默认静默。插件侧接 `ctx.logger.info`。 */
    log?: (line: string) => void;
    /** 已存在时的策略；默认 `'merge'`。 */
    mode?: PresetMode;
}
export interface InstallPresetResult {
    /** 本次是否真正改动 / 安装了（false = 已存在且保留 / 源缺失 / 失败）。 */
    installed: boolean;
    /** 目标预设目录的绝对路径。 */
    target: string;
    /** 本次执行的动作，便于日志与测试断言。 */
    synced?: 'installed' | 'merged' | 'preserved' | 'overwritten' | 'skipped';
    /** merge 下更新为最新快照的文件数。 */
    updated?: number;
    /** merge 下因用户改动 / 无基线而保留的文件数。 */
    preserved?: number;
    /** merge 下新增的文件数。 */
    added?: number;
    /** merge 下随上游移除的文件数。 */
    removed?: number;
}
export declare function installPreset(options?: InstallPresetOptions): Promise<InstallPresetResult>;
