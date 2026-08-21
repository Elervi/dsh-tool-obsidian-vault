// 安装器单元测试：installPreset / resolveDshHome 的幂等性、不覆盖、源缺失、
// DSH_HOME 解析。全部在系统临时目录里执行，不触碰真实的 ~/.dsh。
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
  check('源缺失不创建目标', !(await pathExists(path.join(home, '.agent-presets', 'obsidian'))))
}

// —— 3. 正常安装 ——
{
  const home = path.join(SCRATCH, 'home-install')
  const source = await makeFakePreset('preset-a')
  const r = await installPreset({ home, source, log: (l) => logs.push(l) })
  check('安装成功 → installed=true', r.installed === true)
  check('落点正确', r.target === path.join(home, '.agent-presets', 'obsidian'))
  const composed = await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')
  check('内容复制完整', composed.includes('tool-obsidian-vault'))
  const nested = await readFile(path.join(home, '.agent-presets', 'obsidian', 'vendor', 'pkg', 'lib', 'index.js'), 'utf8')
  check('嵌套目录（vendor）复制完整', nested.includes('module'))
}

// —— 4. 幂等：已存在则跳过 ——
{
  const home = path.join(SCRATCH, 'home-install')
  const source = await makeFakePreset('preset-b') // 与上次不同的源内容
  const before = await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')
  const r = await installPreset({ home, source, log: (l) => logs.push(l) })
  check('已存在 → installed=false', r.installed === false)
  const after = await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')
  check('已存在时不覆盖（内容保持首次安装）', before === after && after.includes('preset-a'))
}

// —— 5. 用户自定义不被覆盖 ——
{
  const home = path.join(SCRATCH, 'home-custom')
  const source = await makeFakePreset('preset-c')
  await installPreset({ home, source })
  await writeFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), '# user customized\n', 'utf8')
  await installPreset({ home, source })
  const now = await readFile(path.join(home, '.agent-presets', 'obsidian', 'agent.cordis.yml'), 'utf8')
  check('用户修改保持原样', now === '# user customized\n')
}

// —— 6. 并发竞争（目标目录已在拷贝间隙出现）→ 视为已安装 ——
{
  const home = path.join(SCRATCH, 'home-race')
  const source = await makeFakePreset('preset-d')
  await mkdir(path.join(home, '.agent-presets', 'obsidian'), { recursive: true })
  await writeFile(path.join(home, '.agent-presets', 'obsidian', 'pre-existing.txt'), 'x', 'utf8')
  const r = await installPreset({ home, source, log: (l) => logs.push(l) })
  check('EEXIST 竞争 → installed=false 且不报错', r.installed === false)
  const keep = await readFile(path.join(home, '.agent-presets', 'obsidian', 'pre-existing.txt'), 'utf8')
  check('竞争时已有文件保留', keep === 'x')
}

// —— 7. 自定义 id ——
{
  const home = path.join(SCRATCH, 'home-custom-id')
  const source = await makeFakePreset('preset-e')
  const r = await installPreset({ home, source, id: 'obsidian-lite' })
  check('自定义 id 生效', r.installed === true && (await pathExists(path.join(home, '.agent-presets', 'obsidian-lite'))))
}

console.log(`\n${failures === 0 ? '✅' : '❌'} install tests: ${failures} failure(s)`)

// —— 工具函数 ——
async function makeFakePreset(marker) {
  const dir = path.join(SCRATCH, `src-${marker}`)
  await mkdir(path.join(dir, 'vendor', 'pkg', 'lib'), { recursive: true })
  await writeFile(path.join(dir, 'agent.cordis.yml'), `# ${marker}\n- id: tool-obsidian-vault\n  name: './vendor/pkg/lib/index.js'\n`, 'utf8')
  await writeFile(path.join(dir, 'preset.yml'), `name: ${marker}\n`, 'utf8')
  await writeFile(path.join(dir, 'vendor', 'pkg', 'lib', 'index.js'), '// module\n', 'utf8')
  await writeFile(path.join(dir, 'vendor', 'pkg', 'package.json'), '{"name":"pkg"}\n', 'utf8')
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
