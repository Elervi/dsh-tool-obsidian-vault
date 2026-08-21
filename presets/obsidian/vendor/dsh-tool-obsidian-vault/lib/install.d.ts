/**
 * 一条命令安装 agent preset：把本包内置的 `presets/obsidian/` 自安装到
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
 * 幂等且绝不覆盖：目标目录已存在（含用户自定义过）时直接跳过；并发竞争
 * （EEXIST）同样视为已安装。
 */
/** 预设 id：目标目录名，须匹配 dsh-agent-presets 的 `PRESET_ID`（小写字母/数字/连字符）。 */
export declare const PRESET_ID = "obsidian";
/**
 * 解析 DSH home：`$DSH_HOME`（非空白）优先，否则 `~/.dsh` —— 与宿主
 * `@deepseek-ai/dsh-home-paths` 的解析顺序一致，不引入新依赖。
 */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
export interface InstallPresetOptions {
    /** 预设源目录（包内 `presets/obsidian/`）。默认按本模块位置解析。 */
    source?: string;
    /** DSH home；默认 {@link resolveDshHome}。测试时可用临时目录注入。 */
    home?: string;
    /** 目标预设 id（目录名）；默认 {@link PRESET_ID}。 */
    id?: string;
    /** 日志回调；默认静默。插件侧接 `ctx.logger.info`。 */
    log?: (line: string) => void;
}
export interface InstallPresetResult {
    /** 本次是否真正执行了安装（false = 已存在 / 源缺失 / 失败）。 */
    installed: boolean;
    /** 目标预设目录的绝对路径。 */
    target: string;
}
export declare function installPreset(options?: InstallPresetOptions): Promise<InstallPresetResult>;
