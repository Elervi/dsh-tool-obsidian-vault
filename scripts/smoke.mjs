// 冒烟测试：用一个 node:fs 实现的迷你 FileSystem shim 直接调用编译后的工具，
// 验证 list/search/read/backlinks 对真实 vault 生效，create 对临时目录生效。
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { registerTools } from '../lib/tools.js'
import { Config } from '../lib/config.js'

const VAULT = '/Users/guagor/Documents/生物备课'
const SCRATCH = '/Users/guagor/Documents/DSH/.smoke-scratch'

class ShimFs {
  async resolve(p, opts = {}) {
    const abs = path.isAbsolute(p) ? p : path.resolve(opts.cwd ?? process.cwd(), p)
    return { targetKey: abs, displayPath: abs }
  }
  async stat(target) {
    try {
      const s = await stat(target.targetKey)
      return {
        version: `${s.mtimeMs}-${s.size}`,
        type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
        size: s.size,
      }
    } catch {
      return undefined
    }
  }
  async listDir(target) {
    const entries = await readdir(target.targetKey, { withFileTypes: true })
    return await Promise.all(entries.map(async (e) => {
      let version
      let size
      if (e.isFile()) {
        try {
          const s = await stat(path.join(target.targetKey, e.name))
          version = `${s.mtimeMs}-${s.size}`
          size = s.size
        } catch { /* race: entry vanished */ }
      }
      return {
        name: e.name,
        type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
        version,
        size,
        target: { targetKey: path.join(target.targetKey, e.name), displayPath: path.join(target.targetKey, e.name) },
      }
    }))
  }
  async readText(target) {
    return await readFile(target.targetKey, 'utf8')
  }
  async writeText(target, content, intent) {
    let exists = false
    try {
      await stat(target.targetKey)
      exists = true
    } catch {
      exists = false
    }
    if (intent?.kind === 'createIfAbsent' && exists) {
      const e = new Error('already exists')
      e.code = 'FS_NOT_OBSERVED'
      throw e
    }
    if (intent?.kind === 'replaceIfVersion' && !exists) {
      const e = new Error('missing')
      e.code = 'FS_STALE_VERSION'
      throw e
    }
    await mkdir(path.dirname(target.targetKey), { recursive: true })
    await writeFile(target.targetKey, content, 'utf8')
    return { operation: exists ? 'update' : 'create', version: 'v', before: null, after: content }
  }
}

function makeCtx(config) {
  const tools = []
  const ctx = {
    fs: new ShimFs(),
    tools: { register(def) { tools.push(def) } },
    systemPrompt: { section() { return () => {} } },
  }
  registerTools(ctx, config)
  return { tools, ctx }
}

async function call(tools, name, args) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`工具未注册: ${name}`)
  const value = await tool.execute(args, { agent: undefined, signal: undefined, name, arguments: args })
  return tool.output.render(args, value).map((b) => b.text).join('\n')
}

// —— 只读工具，作用于真实 vault ——
const cfg = Config({ vaultRoot: VAULT, maxResults: 20, ignoreDirs: ['.obsidian', '.git', '.claudian', '.trash'] })
const { tools } = makeCtx(cfg)
console.log('注册的工具:', tools.map((t) => t.name).join(', '))

const list = await call(tools, 'vault_list_notes', {})
const lines = list.split('\n')
console.log('\n[vault_list_notes] ' + lines[0])
lines.filter((l) => l.startsWith('- ')).slice(0, 8).forEach((l) => console.log('  ' + l))

// —— 多库发现（读本机 Obsidian 全局注册表） ——
const vaults = await call(tools, 'vault_list_vaults', {})
console.log('\n[vault_list_vaults]\n' + vaults)

// —— 边界：folder 精确匹配（不误匹配前缀相似目录） ——
const folderList = await call(tools, 'vault_list_notes', { folder: '讲义' })
const folderHits = folderList.split('\n').filter((l) => l.startsWith('- '))
const allInFolder = folderHits.every((l) => l.startsWith('- 讲义/'))
console.log(`\n[vault_list_notes folder=讲义] ${folderHits.length} 篇，全部在讲义/ 下: ${allInFolder}`)

// —— 边界：路径穿越被拦截 ——
try {
  await call(tools, 'vault_read_note', { path: '../../etc/passwd' })
  console.log('  ✗ 路径穿越未被拦截')
} catch (e) {
  console.log('  ✓ 路径穿越被拦截: ' + e.message)
}

const first = lines.find((l) => l.startsWith('- '))?.replace(/^-\s*/, '').replace(/\s+\(\d+ B\)$/, '')
const stem = first?.split('/').pop().replace(/\.md$/, '')

if (first) {
  const read = await call(tools, 'vault_read_note', { path: first })
  console.log('\n[vault_read_note] ' + read.slice(0, 200) + (read.length > 200 ? '…' : ''))
  console.log('\n[vault_search "' + stem + '"]\n' + (await call(tools, 'vault_search', { query: stem })))
  console.log('\n[vault_backlinks "' + stem + '"]\n' + (await call(tools, 'vault_backlinks', { title: stem })))
}

// —— 增量缓存性能对比：同一查询第二次应显著变快 ——
const t0 = performance.now()
await call(tools, 'vault_search', { query: '细胞' })
const t1 = performance.now()
await call(tools, 'vault_search', { query: '细胞' })
const t2 = performance.now()
console.log(`\n[vault_search 增量缓存] 首次 ${(t1 - t0).toFixed(1)}ms → 二次 ${(t2 - t1).toFixed(1)}ms（应显著更快）`)

// —— 写工具，作用于临时目录 ——
await rm(SCRATCH, { recursive: true, force: true })
const cfg2 = Config({ vaultRoot: SCRATCH, ignoreDirs: [] })
const { tools: tools2 } = makeCtx(cfg2)
console.log('\n[vault_create_note 新建] ' + (await call(tools2, 'vault_create_note', { path: 'demo/hello', content: '# hello\n' })))
try {
  await call(tools2, 'vault_create_note', { path: 'demo/hello', content: '# dup\n' })
  console.log('  ✗ 未拦截重复创建')
} catch (e) {
  console.log('  ✓ 重复创建被拦截: ' + e.message)
}
console.log('[vault_create_note 覆盖] ' + (await call(tools2, 'vault_create_note', { path: 'demo/hello', content: '# hello v2\n', overwrite: true })))
const after = await readFile(path.join(SCRATCH, 'demo/hello.md'), 'utf8')
console.log('  磁盘内容: ' + JSON.stringify(after))

// —— 新工具：frontmatter / 出链（真实 vault，只读） ——
const fm = await call(tools, 'vault_frontmatter', { path: '讲义/第1章第1节 细胞是生命活动的基本单位' })
console.log('\n[vault_frontmatter]\n' + fm)

const links = await call(tools, 'vault_note_links', { path: '教案/必修1_分子与细胞/第1章第2节 细胞的多样性和统一性' })
console.log('\n[vault_note_links]\n' + links)

// —— 新工具：vault_rename_note（临时目录，验证链接重写） ——
await call(tools2, 'vault_create_note', { path: 'old', content: '# old note\n' })
await call(tools2, 'vault_create_note', { path: 'a', content: '见 [[old]] 与 [[old|别名]]，嵌入 ![[old]]，带路径 [[sub/old#锚点]]，无关 [[other]]。\n' })
const renamed = await call(tools2, 'vault_rename_note', { old_path: 'old', new_path: 'renamed/newname' })
console.log('\n[vault_rename_note]\n' + renamed)
const aAfter = await readFile(path.join(SCRATCH, 'a.md'), 'utf8')
console.log('  a.md 改写后: ' + JSON.stringify(aAfter))
const newNote = await readFile(path.join(SCRATCH, 'renamed/newname.md'), 'utf8')
console.log('  新笔记内容: ' + JSON.stringify(newNote))

// —— 大库性能对比：30 篇 × 1MB，验证增量缓存与结果一致性 ——
const BIG = path.join(SCRATCH, 'big')
const filler = '# 大笔记\n\n' + '关键词甲乙丙丁戊己庚辛壬癸 '.repeat(30000) + '\n' // ≈1MB
for (let i = 0; i < 30; i++) {
  await mkdir(path.join(BIG, `dir${i % 3}`), { recursive: true })
  await writeFile(path.join(BIG, `dir${i % 3}`, `note${i}.md`), filler, 'utf8')
}
await writeFile(path.join(BIG, 'dir0', 'target.md'), '# 目标\n\n细胞膜 细胞质 细胞核\n', 'utf8')
const cfg3 = Config({ vaultRoot: BIG, ignoreDirs: [] })
const { tools: tools3 } = makeCtx(cfg3)
const q = '细胞'
const rt0 = performance.now()
const firstHit = await call(tools3, 'vault_search', { query: q })
const rt1 = performance.now()
const secondHit = await call(tools3, 'vault_search', { query: q })
const rt2 = performance.now()
console.log(`\n[vault_search 大库增量缓存] 首次 ${(rt1 - rt0).toFixed(1)}ms → 二次 ${(rt2 - rt1).toFixed(1)}ms`)
console.log('  结果一致: ' + (firstHit === secondHit) + ' | ' + firstHit.split('\n')[0])

await rm(SCRATCH, { recursive: true, force: true })
console.log('\n冒烟测试完成')
