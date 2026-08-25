import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
export const PRESET_ID = 'obsidian';
/** 记录插件上次交付的每个文件的 SHA-256（基线）。放在已安装预设目录内。 */
const MANIFEST = '.dsh-preset-manifest.json';
/**
 * 解析 DSH home：`$DSH_HOME`（非空白）优先，否则 `~/.dsh` —— 与宿主
 * `@deepseek-ai/dsh-home-paths` 的解析顺序一致，不引入新依赖。
 */
export function resolveDshHome(env = process.env) {
    const fromEnv = env.DSH_HOME;
    if (fromEnv !== undefined && fromEnv.trim().length > 0)
        return resolve(fromEnv);
    return join(homedir(), '.dsh');
}
async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch {
        return false;
    }
}
/** 递归列出目录下所有文件（相对路径，`/` 分隔；跳过 `.DS_Store`）。 */
async function listFiles(dir) {
    const out = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.name === '.DS_Store')
            continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            for (const child of await listFiles(full))
                out.push(join(entry.name, child));
        }
        else {
            out.push(entry.name);
        }
    }
    return out;
}
async function hashFile(path) {
    return createHash('sha256').update(await readFile(path)).digest('hex');
}
/** 目录内所有文件的 SHA-256 映射（相对路径 → 哈希）。 */
async function hashTree(dir) {
    const map = {};
    for (const rel of await listFiles(dir))
        map[rel] = await hashFile(join(dir, rel));
    return map;
}
async function readManifest(target) {
    try {
        const raw = await readFile(join(target, MANIFEST), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
            return parsed;
    }
    catch {
        /* 无清单（首装前 / 历史遗留） */
    }
    return {};
}
async function writeManifest(target, map) {
    await writeFile(join(target, MANIFEST), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}
/** 递归拷贝一个文件或目录到目标，确保父目录存在。 */
async function copyTo(sourcePath, destPath) {
    await mkdir(dirname(destPath), { recursive: true });
    await cp(sourcePath, destPath, { recursive: true, dereference: true });
}
export async function installPreset(options = {}) {
    const log = options.log ?? ((_line) => void 0);
    const id = options.id ?? PRESET_ID;
    const source = options.source ?? fileURLToPath(new URL('../presets/obsidian/', import.meta.url));
    const mode = options.mode ?? 'merge';
    const target = join(options.home ?? resolveDshHome(), '.agent-presets', id);
    // 源目录缺失：包不完整（本地裸检也可能没有 presets/），跳过并说明。
    try {
        const s = await stat(source);
        if (!s.isDirectory()) {
            log(`agent-preset "${id}": source ${source} is not a directory — install skipped`);
            return { installed: false, target, synced: 'skipped' };
        }
    }
    catch {
        log(`agent-preset "${id}": source ${source} not found — install skipped`);
        return { installed: false, target, synced: 'skipped' };
    }
    // 目标不存在 → 首装：整目录拷贝 + 写基线清单。
    if (!(await pathExists(target))) {
        try {
            await mkdir(dirname(target), { recursive: true });
            await cp(source, target, { recursive: true, dereference: true, force: false, errorOnExist: true });
            await writeManifest(target, await hashTree(source));
            log(`agent-preset "${id}" installed → ${target}; restart the session picker — new sessions offer "Obsidian 模式"`);
            return { installed: true, target, synced: 'installed' };
        }
        catch (error) {
            // EEXIST：并发安装竞争（例如多个 profile 的 bundle 层同时启动），视为已装。
            if (error.code === 'EEXIST') {
                log(`agent-preset "${id}" already installed at ${target} (concurrent install) — keeping it`);
                return { installed: false, target, synced: 'preserved' };
            }
            log(`agent-preset "${id}": install failed → ${target}: ${error instanceof Error ? error.message : String(error)}`);
            return { installed: false, target, synced: 'skipped' };
        }
    }
    // 目标已存在 → 按 mode 处理。
    if (mode === 'preserve') {
        log(`agent-preset "${id}" already installed at ${target} — keeping it (mode=preserve, never overwrites user edits)`);
        return { installed: false, target, synced: 'preserved' };
    }
    if (mode === 'overwrite') {
        await rm(target, { recursive: true, force: true });
        await copyTo(source, target);
        await writeManifest(target, await hashTree(source));
        log(`agent-preset "${id}" overwritten at ${target} — user edits discarded (mode=overwrite)`);
        return { installed: true, target, synced: 'overwritten' };
    }
    // mode === 'merge'：以基线清单做三方合并。
    const manifest = await readManifest(target);
    const theirs = await hashTree(source); // 当前快照：相对路径 → 哈希
    const hasBase = Object.keys(manifest).length > 0;
    let updated = 0;
    let preserved = 0;
    let added = 0;
    let removed = 0;
    // 更新 / 新增：遍历当前快照的每个文件。
    for (const [rel, tHash] of Object.entries(theirs)) {
        const dst = join(target, rel);
        const oHash = (await pathExists(dst)) ? await hashFile(dst) : undefined;
        const bHash = manifest[rel];
        if (oHash === undefined) {
            // 插件新增文件 → 拷贝进来。
            await copyTo(join(source, rel), dst);
            added++;
        }
        else if (oHash === tHash) {
            // 已是当前版本，跳过。
        }
        else if (hasBase && bHash !== undefined && oHash === bHash) {
            // 用户没动过（与上次交付一致）→ 更新到最新快照。
            await copyTo(join(source, rel), dst);
            updated++;
        }
        else {
            // 用户改过 / 历史遗留无基线 → 保留用户的。
            preserved++;
            if (!hasBase) {
                log(`agent-preset "${id}": keeping ${rel} (no baseline yet) — reset ${target} once to re-baseline to the latest snapshot`);
            }
        }
    }
    // 移除：上游已删除、用户也没改过的插件自带文件，跟着删；用户改过则保留。
    for (const [rel, bHash] of Object.entries(manifest)) {
        if (theirs[rel] !== undefined)
            continue; // 上游仍在
        const dst = join(target, rel);
        if (!(await pathExists(dst)))
            continue;
        const oHash = await hashFile(dst);
        if (oHash === bHash) {
            await rm(dst);
            removed++;
        }
        else {
            preserved++;
        }
    }
    // 基线 = 当前快照哈希（被保留的用户文件也记“最新意图”），用于下次判断是否改动。
    await writeManifest(target, theirs);
    if (!hasBase) {
        log(`agent-preset "${id}": legacy install at ${target} ported to sync model (manifest seeded). Untouched old files are kept as customized until you delete ${target} once and restart.`);
    }
    else {
        log(`agent-preset "${id}" synced at ${target}: ${updated} updated, ${preserved} preserved (user-edited kept), ${added} added, ${removed} removed`);
    }
    return { installed: true, target, synced: 'merged', updated, preserved, added, removed };
}
