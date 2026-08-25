// 安装器单元测试：installPreset / resolveDshHome 的安装、升级同步（merge）、
// 保留用户改动、增删文件跟随、preserve / overwrite、历史遗留、自定义 id。
// 全部在系统临时目录里执行，不触碰真实的 ~/.dsh。
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { installPreset, resolveDshHome } from '../lib/install.js'

let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

const SCRATCH = await mkdtemp(path.join(tmpdir(), 'dsh-install-test-'))
const logs = []

// —— 1. resolveDshHome：$DSH_HOME 优先，~/.dsh 兜底 ——
{
  check('DSH_HOME 生效', resolveDshHome({ DSH_HOME: '/tmp/custom-home' }) === path.resolve('/tmp/custom-home'), resolveDshHome({ DSH_HOME: '/tmp/custom-home' }))
  check('空 DSH_HOME 视为未设', resolveDshHome({ DSH_HOME: '   ' }) === path.join(process.env.HOME ?? '', '.dsh'))
  check('未设 DSH_HOME 回退 ~/.dsh', resolveDshHome({}) === path.join(process.env.HOME ?? '', '.dsh'))
}

// —— 2. 源目录缺失：跳过且不报错 ——
{
  const home = path.join(SCRATCH, 'home-missing-source')
  const r = await installPreset({ home, source: path.join(SCRATCH, 'no-such-preset'), log: (l) => logs.push(l) })
  check('源缺失 → installed=false', r.installed === false)
  check('源缺失 synced=skipped', r.synced === 'skipped')
  check('源缺失不创建目标', !(await pathExists(path.join(home, '.agent-presets', 'obsidian'))))
}

// —— 3. 正常首装 + 写基线清单 ——
{
  const home = path.join(SCRATCH, 'home-install')
  const source = await makeFakeSource({ 'agent.cordis.yml': '# A\n- id: tool-obsidian-vault\n', 'preset.yml': 'name: A\n' })
  const r = await installPreset({ home, source, log: (l) => logs.push(l) })
  check('首装 → installed=true', r.installed === true)
  check('首装 synced=installed', r.synced === 'installed')
  check('落点正确', r.target === path.join(home, '.agent-presets', 'obsidian'))
  check('内容复制完整', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')).includes('tool-obsidian-vault'))
  check('已写基线清单', await pathExists(path.join(home, '.agent-presets', 'obsidian', '.dsh-preset-manifest.json')))
}

// —— 4. 升级同步：未改动文件更新到新版 + 新增文件加入（本次要修的坑）——
{
  const home = path.join(SCRATCH, 'home-merge-update')
  const sourceA = await makeFakeSource({ 'agent.cordis.yml': '# A\n', 'preset.yml': 'name: A\n' })
  await installPreset({ home, source: sourceA })
  // 用户没动，插件新版本改了内容并新增一个文件
  const sourceB = await makeFakeSource({ 'agent.cordis.yml': '# B (new)\n', 'preset.yml': 'name: B\n', 'skills/new.md': 'hello\n' })
  const r = await installPreset({ home, source: sourceB, log: (l) => logs.push(l) })
  check('merge → installed=true', r.installed === true)
  check('merge synced=merged', r.synced === 'merged')
  check('未改动文件已更新到最新版', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')) === '# B (new)\n')
  check('插件新增文件已加入', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'skills', 'new.md'), 'utf8')) === 'hello\n')
  check('updated>=1', (r.updated ?? 0) >= 1, `updated=${r.updated}`)
  check('added>=1', (r.added ?? 0) >= 1, `added=${r.added}`)
}

// —— 5. 升级同步：用户改过的文件保留 ——
{
  const home = path.join(SCRATCH, 'home-merge-preserve')
  const sourceA = await makeFakeSource({ 'agent.cordis.yml': '# A\n', 'preset.yml': 'name: A\n' })
  await installPreset({ home, source: sourceA })
  await writeFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), '# user customized\n', 'utf8')
  const sourceB = await makeFakeSource({ 'agent.cordis.yml': '# B (new)\n', 'preset.yml': 'name: B\n' })
  const r = await installPreset({ home, source: sourceB, log: (l) => logs.push(l) })
  check('用户改动保留原样', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')) === '# user customized\n')
  check('未改动文件（preset.yml）仍更新', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'preset.yml'), 'utf8')) === 'name: B\n')
  check('preserved>=1', (r.preserved ?? 0) >= 1, `preserved=${r.preserved}`)
}

// —— 6. 升级同步：用户新增的文件保留 ——
{
  const home = path.join(SCRATCH, 'home-merge-useradd')
  const sourceA = await makeFakeSource({ 'agent.cordis.yml': '# A\n', 'preset.yml': 'name: A\n' })
  await installPreset({ home, source: sourceA })
  await mkdir(path.join(home, '.agent-presets', 'obsidian', 'skills', 'mine'), { recursive: true })
  await writeFile(path.join(home, '.agent-presets', 'obsidian', 'skills', 'mine', 'SKILL.md'), 'my skill\n', 'utf8')
  const sourceB = await makeFakeSource({ 'agent.cordis.yml': '# B\n', 'preset.yml': 'name: B\n' })
  await installPreset({ home, source: sourceB, log: (l) => logs.push(l) })
  check('用户新增文件保留', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'skills', 'mine', 'SKILL.md'), 'utf8')) === 'my skill\n')
}

// —— 7. 升级同步：插件移除且用户没改过 → 跟随删除 ——
{
  const home = path.join(SCRATCH, 'home-merge-remove')
  const sourceA = await makeFakeSource({ 'agent.cordis.yml': '# A\n', 'preset.yml': 'name: A\n', 'gone.txt': 'bye\n' })
  await installPreset({ home, source: sourceA })
  check('gone.txt 首装已在', await pathExists(path.join(home, '.agent-presets', 'obsidian', 'gone.txt')))
  const sourceB = await makeFakeSource({ 'agent.cordis.yml': '# B\n', 'preset.yml': 'name: B\n' })
  const r = await installPreset({ home, source: sourceB, log: (l) => logs.push(l) })
  check('插件移除且未改动 → 删除', !(await pathExists(path.join(home, '.agent-presets', 'obsidian', 'gone.txt'))))
  check('removed>=1', (r.removed ?? 0) >= 1, `removed=${r.removed}`)
}

// —— 8. preserve 模式：永不覆盖 ——
{
  const home = path.join(SCRATCH, 'home-preserve')
  const sourceA = await makeFakeSource({ 'agent.cordis.yml': '# A\n', 'preset.yml': 'name: A\n' })
  await installPreset({ home, source: sourceA })
  await writeFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), '# user\n', 'utf8')
  const sourceB = await makeFakeSource({ 'agent.cordis.yml': '# B\n', 'preset.yml': 'name: B\n' })
  const r = await installPreset({ home, source: sourceB, mode: 'preserve', log: (l) => logs.push(l) })
  check('preserve → installed=false', r.installed === false)
  check('preserve synced=preserved', r.synced === 'preserved')
  check('preserve 不改任何文件', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')) === '# user\n'
    && (await readFile(path.join(home, '.agent-presets', 'obsidian', 'preset.yml'), 'utf8')) === 'name: A\n')
}

// —— 9. overwrite 模式：整体替换（丢弃用户改动）——
{
  const home = path.join(SCRATCH, 'home-overwrite')
  const sourceA = await makeFakeSource({ 'agent.cordis.yml': '# A\n', 'preset.yml': 'name: A\n' })
  await installPreset({ home, source: sourceA })
  await writeFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), '# user\n', 'utf8')
  const sourceB = await makeFakeSource({ 'agent.cordis.yml': '# B\n', 'preset.yml': 'name: B\n' })
  const r = await installPreset({ home, source: sourceB, mode: 'overwrite', log: (l) => logs.push(l) })
  check('overwrite → installed=true', r.installed === true)
  check('overwrite synced=overwritten', r.synced === 'overwritten')
  check('overwrite 使用新版', (await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')) === '# B\n')
}

// —— 10. 历史遗留（无清单）：保留现有文件 + 落地清单 ——
{
  const home = path.join(SCRATCH, 'home-legacy')
  const target = path.join(home, '.agent-presets', 'obsidian')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'agent.cordis.yml'), '# legacy user copy\n', 'utf8')
  const source = await makeFakeSource({ 'agent.cordis.yml': '# new\n', 'preset.yml': 'name: new\n' })
  const r = await installPreset({ home, source, log: (l) => logs.push(l) })
  check('legacy merge → installed=true', r.installed === true)
  check('legacy 保留现有文件', (await readFile(path.join(target, 'agent.cordis.yml'), 'utf8')) === '# legacy user copy\n')
  check('legacy 落地清单（下次可同步）', await pathExists(path.join(target, '.dsh-preset-manifest.json')))
}

// —— 11. 自定义 id ——
{
  const home = path.join(SCRATCH, 'home-custom-id')
  const source = await makeFakeSource({ 'agent.cordis.yml': '# A\n', 'preset.yml': 'name: A\n' })
  const r = await installPreset({ home, source, id: 'obsidian-lite' })
  check('自定义 id 生效', r.installed === true && r.synced === 'installed' && (await pathExists(path.join(home, '.agent-presets', 'obsidian-lite'))))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} install tests: ${failures} failure(s)`)

// —— 工具函数 ——
async function makeFakeSource(files) {
  const dir = path.join(SCRATCH, `src-${Math.random().toString(36).slice(2)}`)
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel)
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, content, 'utf8')
  }
  return dir
}

async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

await rm(SCRATCH, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
