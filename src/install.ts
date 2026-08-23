import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { cp, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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
export const PRESET_ID = 'obsidian'

/**
 * 解析 DSH home：`$DSH_HOME`（非空白）优先，否则 `~/.dsh` —— 与宿主
 * `@deepseek-ai/dsh-home-paths` 的解析顺序一致，不引入新依赖。
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

export interface InstallPresetOptions {
  /** 预设源目录（包内 `presets/obsidian/`）。默认按本模块位置解析。 */
  source?: string
  /** DSH home；默认 {@link resolveDshHome}。测试时可用临时目录注入。 */
  home?: string
  /** 目标预设 id（目录名）；默认 {@link PRESET_ID}。 */
  id?: string
  /** 日志回调；默认静默。插件侧接 `ctx.logger.info`。 */
  log?: (line: string) => void
}

export interface InstallPresetResult {
  /** 本次是否真正执行了安装（false = 已存在 / 源缺失 / 失败）。 */
  installed: boolean
  /** 目标预设目录的绝对路径。 */
  target: string
}

export async function installPreset(options: InstallPresetOptions = {}): Promise<InstallPresetResult> {
  const log = options.log ?? ((_line: string) => void 0)
  const id = options.id ?? PRESET_ID
  const source = options.source ?? fileURLToPath(new URL('../presets/obsidian/', import.meta.url))
  const target = join(options.home ?? resolveDshHome(), '.agent-presets', id)

  // 源目录缺失：包不完整（本地裸检也可能没有 presets/），跳过并说明。
  try {
    const s = await stat(source)
    if (!s.isDirectory()) {
      log(`agent-preset "${id}": source ${source} is not a directory — install skipped`)
      return { installed: false, target }
    }
  } catch {
    log(`agent-preset "${id}": source ${source} not found — install skipped`)
    return { installed: false, target }
  }

  // 目标已存在：绝不覆盖 —— 用户可能自定义过 agent.cordis.yml / skills。
  try {
    await stat(target)
    log(`agent-preset "${id}" already installed at ${target} — keeping it (install never overwrites user edits)`)
    return { installed: false, target }
  } catch {
    // 目标不存在，继续安装
  }

  try {
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    })
    log(`agent-preset "${id}" installed → ${target}; restart the session picker — new sessions offer "Obsidian 模式"`)
    return { installed: true, target }
  } catch (error) {
    // EEXIST：并发安装竞争（例如多个 profile 的 bundle 层同时启动），视为已装。
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      log(`agent-preset "${id}" already installed at ${target} (concurrent install) — keeping it`)
      return { installed: false, target }
    }
    log(`agent-preset "${id}": install failed → ${target}: ${error instanceof Error ? error.message : String(error)}`)
    return { installed: false, target }
  }
}
