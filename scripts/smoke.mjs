// 冒烟测试：用一个 node:fs 实现的迷你 FileSystem shim 直接调用编译后的工具，
// 若设置了 SMOKE_VAULT，则对真实 vault 验证 list/search/read/backlinks；
// create/rename 等写工具始终在系统临时目录中执行。
import { readFile, writeFile, mkdir, readdir, stat, rm, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { registerTools } from '../lib/tools.js'
import { Config } from '../lib/config.js'
import { extractLinks, parseFrontmatter } from '../lib/vault.js'

const VAULT = process.env.SMOKE_VAULT
const SCRATCH = await mkdtemp(path.join(tmpdir(), 'dsh-smoke-'))

class ShimFs {
  async resolve(p, opts = {}) {
    const abs = path.isAbsolute(p) ? p : path.resolve(opts.cwd ?? process.cwd(), p)
    return { targetKey: abs, displayPath: abs }
  }
  contains(parent, child) {
    const p = parent.targetKey.endsWith('/') ? parent.targetKey : parent.targetKey + '/'
    return child.targetKey === parent.targetKey || child.targetKey.startsWith(p)
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
  async editText(target, edit, expected) {
    let current
    try {
      current = await stat(target.targetKey)
    } catch {
      const e = new Error('missing')
      e.code = 'FS_STALE_VERSION'
      throw e
    }
    const version = `${current.mtimeMs}-${current.size}`
    if (expected?.version && expected.version !== version) {
      const e = new Error('stale')
      e.code = 'FS_STALE_VERSION'
      throw e
    }
    const text = await readFile(target.targetKey, 'utf8')
    const count = text.split(edit.oldString).length - 1
    if (count === 0) {
      const e = new Error('not found')
      e.code = 'FS_EDIT_NOT_FOUND'
      throw e
    }
    if (!edit.replaceAll && count > 1) {
      const e = new Error('ambiguous')
      e.code = 'FS_AMBIGUOUS_EDIT'
      throw e
    }
    const after = edit.replaceAll ? text.split(edit.oldString).join(edit.newString) : text.replace(edit.oldString, edit.newString)
    await writeFile(target.targetKey, after, 'utf8')
    return { version: 'v', before: text, after }
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
    emit() {},
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

// —— 只读工具：若配置了 SMOKE_VAULT，则对真实 vault 验证只读工具 ——
let tools
if (VAULT) {
  const cfg = Config({ vaultRoot: VAULT, maxResults: 20, ignoreDirs: ['.obsidian', '.git', '.claudian', '.trash'] })
  const ctx = makeCtx(cfg)
  tools = ctx.tools
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

  // —— 新工具：frontmatter / 出链（真实 vault，只读） ——
  const fm = await call(tools, 'vault_frontmatter', { path: '讲义/第1章第1节 细胞是生命活动的基本单位' })
  console.log('\n[vault_frontmatter]\n' + fm)

  const links = await call(tools, 'vault_note_links', { path: '教案/必修1_分子与细胞/第1章第2节 细胞的多样性和统一性' })
  console.log('\n[vault_note_links]\n' + links)
} else {
  console.warn('\n[smoke] 未设置 SMOKE_VAULT，跳过真实 vault 只读测试；设置 SMOKE_VAULT=/path/to/vault 可启用')
}

// —— 写工具，作用于临时目录 ——
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

// —— 新工具：vault_rename_note（临时目录，验证链接重写与同名笔记路径隔离） ——
await call(tools2, 'vault_create_note', { path: 'old', content: '# old note\n见 [[old#self]]。\n' })
await call(tools2, 'vault_create_note', { path: 'sub/old', content: '# 另一篇 old（不应被改名影响）\n' })
await call(tools2, 'vault_create_note', { path: 'sub/b', content: '参考 [旧文](../old.md)。\n' })
await call(tools2, 'vault_create_note', { path: 'a', content: '见 [[old]] 与 [[old|别名]]，嵌入 ![[old]]，带路径 [[sub/old#锚点]]，markdown 链接 [参考](old.md)，无关 [[other]]。\n' })
const renamed = await call(tools2, 'vault_rename_note', { old_path: 'old', new_path: 'renamed/newname' })
console.log('\n[vault_rename_note]\n' + renamed)
const aAfter = await readFile(path.join(SCRATCH, 'a.md'), 'utf8')
console.log('  a.md 改写后: ' + JSON.stringify(aAfter))
const bAfter = await readFile(path.join(SCRATCH, 'sub', 'b.md'), 'utf8')
console.log('  sub/b.md 改写后: ' + JSON.stringify(bAfter))
const newNote = await readFile(path.join(SCRATCH, 'renamed', 'newname.md'), 'utf8')
console.log('  新笔记内容: ' + JSON.stringify(newNote))
const renameOk =
  aAfter.includes('[[newname]]') && aAfter.includes('[[newname|别名]]') && aAfter.includes('![[newname]]') &&
  aAfter.includes('[[sub/old#锚点]]') && !aAfter.includes('[[renamed/newname#锚点]]') && aAfter.includes('[[other]]') &&
  aAfter.includes('[参考](renamed/newname)') &&
  bAfter.includes('[旧文](../renamed/newname)') &&
  newNote.includes('[[newname#self]]')
console.log('  ✓ 链接重写正确（同名笔记路径隔离 + 自引用改写 + markdown 链接相对化）: ' + renameOk)
if (!renameOk) process.exitCode = 1

// —— 新功能：keep_old: 'stub' 把旧文件替换为跳转占位 ——
await call(tools2, 'vault_create_note', { path: 'stubme', content: '# 将被移动\n' })
await call(tools2, 'vault_create_note', { path: 'linker', content: '看 [[stubme]]。\n' })
const stubRename = await call(tools2, 'vault_rename_note', { old_path: 'stubme', new_path: 'moved/target', keep_old: 'stub' })
const stubOld = await readFile(path.join(SCRATCH, 'stubme.md'), 'utf8')
const stubOk = stubOld.includes('moved: true') && stubOld.includes('[[moved/target]]') && stubRename.includes('已替换为跳转占位')
console.log(`[vault_rename_note keep_old=stub] 旧文件变跳转占位: ${stubOk}`)
if (!stubOk) process.exitCode = 1
try {
  await call(tools2, 'vault_rename_note', { old_path: 'linker', new_path: 'x', keep_old: 'delete' })
  console.log('  ✗ keep_old=delete 未被拒绝')
  process.exitCode = 1
} catch (e) {
  console.log('  ✓ keep_old=delete 被拒绝并说明原因: ' + e.message.slice(0, 40) + '…')
}

// —— 回归：vault_backlinks 按精确路径匹配（同名笔记只命中真正指向它的链接） ——
const bl = await tools2.find((t) => t.name === 'vault_backlinks').execute(
  { title: 'old', path: 'sub/old' },
  { agent: undefined, signal: undefined, name: 'vault_backlinks', arguments: {} },
)
const blPaths = bl.backlinks.map((b) => b.path)
const blOk = blPaths.length === 1 && blPaths[0] === 'a.md' && bl.target === 'sub/old'
console.log(`\n[回归 vault_backlinks path 精确匹配] 命中 ${blPaths.join(', ')}（应只有 a.md）: ${blOk}`)
if (!blOk) process.exitCode = 1

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

// —— 回归：extractLinks 按解析身份去重，不按 stem 折叠不同链接 ——
const dedupLinks = extractLinks('见 [[dir/a#x]] 和 [[other/a#y]] 与 [[dir/a#z]] 与 [[dir/a#x]]')
console.log(`\n[回归 extractLinks] ${dedupLinks.length} 条（应 3 条）: ` + dedupLinks.map((l) => l.target).join(' | '))

// —— 回归：parseFrontmatter 识别嵌套 YAML 并置 valid=false ——
const nestedFm = parseFrontmatter('---\ntitle: hello\ntags:\n  - a\n  - b\nnested:\n  k: v\n---\nbody')
console.log(`[回归 parseFrontmatter] valid=${nestedFm.valid}（应 false）, issues=${nestedFm.issues.length} 条`)

// —— 回归：vault_read_note 支持 offset/limit 切片 ——
await call(tools2, 'vault_create_note', { path: 'slice-test', content: 'line1\nline2\nline3\nline4\nline5\n' })
const readFull = await tools2.find((t) => t.name === 'vault_read_note').execute({ path: 'slice-test' }, { agent: undefined, signal: undefined, name: 'vault_read_note', arguments: { path: 'slice-test' } })
const readSlice = await tools2.find((t) => t.name === 'vault_read_note').execute({ path: 'slice-test', offset: 2, limit: 3 }, { agent: undefined, signal: undefined, name: 'vault_read_note', arguments: {} })
console.log(`[回归 vault_read_note] 全文 ${readFull.totalLines} 行；切片 ${readSlice.from}–${readSlice.to} 行，truncated=${readSlice.truncated}（应 true）`)

// —— 回归：vault_read_note 越界 offset 保持 from/to 一致、返回空窗口 ——
const readPastEnd = await tools2.find((t) => t.name === 'vault_read_note').execute({ path: 'slice-test', offset: 99 }, { agent: undefined, signal: undefined, name: 'vault_read_note', arguments: {} })
const pastEndOk = readPastEnd.from === readPastEnd.to && readPastEnd.content === ''
console.log(`[回归 vault_read_note 越界] from=${readPastEnd.from} to=${readPastEnd.to} content="${readPastEnd.content}"（应 from=to 且为空）: ${pastEndOk}`)
if (!pastEndOk) process.exitCode = 1

// —— 回归：Windows 盘符路径在任何平台都被拒绝 ——
try {
  await call(tools2, 'vault_read_note', { path: 'C:\\windows\\evil' })
  console.log('  ✗ 盘符路径未被拦截')
  process.exitCode = 1
} catch (e) {
  console.log('  ✓ 盘符路径被拦截: ' + e.message)
}

// —— 回归：绝对路径/前导斜杠被拒绝为笔记路径 ——
try {
  await call(tools2, 'vault_create_note', { path: '/etc/evil', content: '# x\n' })
  console.log('  ✗ 前导斜杠未被拦截')
  process.exitCode = 1
} catch (e) {
  console.log('  ✓ 前导斜杠被拦截: ' + e.message)
}

// ========== 新工具回归（v0.3） ==========

// —— vault_edit_note：单次替换 / 歧义报错 / replace_all ——
await call(tools2, 'vault_create_note', { path: 'editme', content: 'alpha beta\nalpha gamma\nalpha\n' })
const edit1 = await tools2.find((t) => t.name === 'vault_edit_note').execute(
  { path: 'editme', old_string: 'alpha beta', new_string: 'ALPHA BETA' },
  { agent: undefined, signal: undefined, name: 'vault_edit_note', arguments: {} },
)
const edit1Ok = edit1.matches === 1 && edit1.after.includes('ALPHA BETA') && edit1.after.includes('alpha gamma')
console.log(`[vault_edit_note 单次替换] matches=${edit1.matches}（应 1）: ${edit1Ok}`)
if (!edit1Ok) process.exitCode = 1
try {
  await tools2.find((t) => t.name === 'vault_edit_note').execute(
    { path: 'editme', old_string: 'alpha', new_string: 'x' },
    { agent: undefined, signal: undefined, name: 'vault_edit_note', arguments: {} },
  )
  console.log('  ✗ 歧义编辑未被拦截')
  process.exitCode = 1
} catch (e) {
  console.log('  ✓ 歧义编辑被拦截（提示 replace_all）: ' + e.message.slice(0, 30) + '…')
}
const editAll = await tools2.find((t) => t.name === 'vault_edit_note').execute(
  { path: 'editme', old_string: 'alpha', new_string: 'ALPHA', replace_all: true },
  { agent: undefined, signal: undefined, name: 'vault_edit_note', arguments: {} },
)
const editAllOk = editAll.matches === 2 && !editAll.after.includes('alpha')
console.log(`[vault_edit_note replace_all] matches=${editAll.matches}（应 2）: ${editAllOk}`)
if (!editAllOk) process.exitCode = 1

// —— vault_append_note：自动补换行 + 版本守卫 ——
await call(tools2, 'vault_create_note', { path: 'appendme', content: 'line1' }) // 无尾随换行
const app = await call(tools2, 'vault_append_note', { path: 'appendme', content: 'line2' })
const appended = await readFile(path.join(SCRATCH, 'appendme.md'), 'utf8')
const appendOk = appended === 'line1\nline2' && app.includes('追加 5 字符')
console.log(`[vault_append_note] 磁盘内容=${JSON.stringify(appended)}（应 "line1\\nline2"）: ${appendOk}`)
if (!appendOk) process.exitCode = 1
try {
  await call(tools2, 'vault_append_note', { path: 'not-exist', content: 'x' })
  console.log('  ✗ 对不存在的笔记追加未被拒绝')
  process.exitCode = 1
} catch (e) {
  console.log('  ✓ 对不存在的笔记追加被拒绝: ' + e.message.slice(0, 30) + '…')
}

// —— vault_update_frontmatter：set / delete / 自动创建 ——
await call(tools2, 'vault_create_note', { path: 'fm', content: '---\ntitle: 旧标题\ntags:\n  - a\n  - b\nstatus: draft\n---\n# 正文\n' })
const fmUpdate = await tools2.find((t) => t.name === 'vault_update_frontmatter').execute(
  { path: 'fm', set: { title: '新标题', tags: '[a, c]', rating: '5' }, delete: ['status'] },
  { agent: undefined, signal: undefined, name: 'vault_update_frontmatter', arguments: {} },
)
const fmText = await readFile(path.join(SCRATCH, 'fm.md'), 'utf8')
const fmOk =
  fmText.includes('title: 新标题') && fmText.includes('tags: [a, c]') && fmText.includes('rating: 5') &&
  !fmText.includes('status') && fmText.includes('a\n  - b') === false && fmText.includes('# 正文') && !fmUpdate.created
console.log(`[vault_update_frontmatter set+delete]\n${fmText}→ 保留正文/删除块列表/追加新键: ${fmOk}`)
if (!fmOk) process.exitCode = 1
const fmCreate = await call(tools2, 'vault_update_frontmatter', { path: 'appendme', set: { source: 'smoke' } })
const fmCreated = await readFile(path.join(SCRATCH, 'appendme.md'), 'utf8')
const fmCreateOk = fmCreated.startsWith('---\nsource: smoke\n---\n') && fmCreated.includes('line1')
console.log(`[vault_update_frontmatter 自动创建] created=true 且正文保留: ${fmCreateOk}`)
if (!fmCreateOk) process.exitCode = 1

// —— vault_search：regex / match_all / case_sensitive ——
await call(tools2, 'vault_create_note', { path: 'srch', content: '项目 Alpha 完成\nBeta 进行中\n' })
await call(tools2, 'vault_create_note', { path: 'srch2', content: '无关内容\n' })
const reHit = await call(tools2, 'vault_search', { query: 'Alpha|Beta', regex: true })
const maHit = await call(tools2, 'vault_search', { query: '项目 完成', match_all: true })
const csHit = await call(tools2, 'vault_search', { query: 'alpha', case_sensitive: true })
const reOk = reHit.includes('srch.md') && !reHit.includes('srch2.md')
const maOk = maHit.includes('srch.md')
const csOk = !csHit.includes('srch.md') // 大小写敏感时小写 alpha 不命中大写 Alpha
console.log(`[vault_search regex/match_all/case_sensitive] regex=${reOk}, match_all=${maOk}, case_sensitive=${csOk}`)
if (!reOk || !maOk || !csOk) process.exitCode = 1

// —— vault_search_tags：内联 + frontmatter 标签、子标签匹配 ——
await call(tools2, 'vault_create_note', { path: 'tag1', content: '# 笔记\n\n这里有个 #project/active 和 #读书 标签。\n' })
await call(tools2, 'vault_create_note', { path: 'tag2', content: '---\ntags: [工作, 待办]\n---\n# 正文\n' })
const tagHit = await tools2.find((t) => t.name === 'vault_search_tags').execute(
  { tag: 'project' },
  { agent: undefined, signal: undefined, name: 'vault_search_tags', arguments: {} },
)
const tagHit2 = await tools2.find((t) => t.name === 'vault_search_tags').execute(
  { tag: '工作' },
  { agent: undefined, signal: undefined, name: 'vault_search_tags', arguments: {} },
)
const tagOk =
  tagHit.total === 1 && tagHit.hits[0].path === 'tag1.md' && tagHit.hits[0].tags.includes('project/active') &&
  tagHit2.total === 1 && tagHit2.hits[0].path === 'tag2.md'
console.log(`[vault_search_tags] #project 命中子标签 tag1.md: ${tagHit.total === 1 && tagHit.hits?.[0]?.path === 'tag1.md'}; frontmatter tags 命中: ${tagHit2.total === 1 && tagHit2.hits?.[0]?.path === 'tag2.md'}（${tagOk ? '✓' : '✗'}）`)
if (!tagOk) process.exitCode = 1

// —— vault_note_info：标签/别名/出链/反链 ——
await call(tools2, 'vault_create_note', { path: 'info-target', content: '# 目标\n' })
await call(tools2, 'vault_create_note', { path: 'info-src', content: '---\naliases: [别名A]\n---\n看 [[info-target]]，嵌入 ![[info-target]]，markdown [链](info-target.md)，#标签x。\n' })
const info = await tools2.find((t) => t.name === 'vault_note_info').execute(
  { path: 'info-src' },
  { agent: undefined, signal: undefined, name: 'vault_note_info', arguments: {} },
)
const infoOk =
  info.tags.includes('标签x') && info.aliases.includes('别名A') &&
  info.links.wikilinks === 1 && info.links.embeds === 1 && info.links.markdown === 1 &&
  info.backlinks.total === 0 && info.frontmatter.fields.includes('aliases')
console.log(`[vault_note_info] tags=${info.tags.join(',')} aliases=${info.aliases.join(',')} links=${JSON.stringify(info.links)} backlinks=${info.backlinks.total}: ${infoOk ? '✓' : '✗'}`)
if (!infoOk) process.exitCode = 1

// —— vault_list_folders：含空文件夹、计数 ——
await mkdir(path.join(SCRATCH, 'empty'), { recursive: true })
const folders = await tools2.find((t) => t.name === 'vault_list_folders').execute(
  { folder: 'renamed' },
  { agent: undefined, signal: undefined, name: 'vault_list_folders', arguments: {} },
)
const foldersOk = folders.folders.some((f) => f.path === 'renamed' && f.notes >= 1)
const emptyOk = (await tools2.find((t) => t.name === 'vault_list_folders').execute(
  {},
  { agent: undefined, signal: undefined, name: 'vault_list_folders', arguments: {} },
)).folders.some((f) => f.path === 'empty' && f.notes === 0)
console.log(`[vault_list_folders] 子目录过滤+计数: ${foldersOk}; 空文件夹也在列: ${emptyOk}`)
if (!foldersOk || !emptyOk) process.exitCode = 1

// —— vault_create_note unique：自动唯一名 ——
await call(tools2, 'vault_create_note', { path: 'uniq', content: '# 一\n' })
const uniq2 = await call(tools2, 'vault_create_note', { path: 'uniq', content: '# 二\n', unique: true })
const uniq3 = await call(tools2, 'vault_create_note', { path: 'uniq', content: '# 三\n', unique: true })
const uniqOk = uniq2.includes('uniq 1.md') && uniq3.includes('uniq 2.md')
console.log(`[vault_create_note unique] ${uniq2.split('\n')[0]} / ${uniq3.split('\n')[0]}: ${uniqOk}`)
if (!uniqOk) process.exitCode = 1

// —— vault_backlinks format=all：markdown 链接也算反链 ——
await call(tools2, 'vault_create_note', { path: 'mdlink-src', content: '见 [目标](info-target.md)。\n' })
const blAll = await tools2.find((t) => t.name === 'vault_backlinks').execute(
  { title: 'info-target', format: 'all' },
  { agent: undefined, signal: undefined, name: 'vault_backlinks', arguments: {} },
)
const blAllOk = blAll.backlinks.some((b) => b.path === 'mdlink-src.md')
const blWl = await tools2.find((t) => t.name === 'vault_backlinks').execute(
  { title: 'info-target' },
  { agent: undefined, signal: undefined, name: 'vault_backlinks', arguments: {} },
)
const blWlOk = !blWl.backlinks.some((b) => b.path === 'mdlink-src.md') // 默认 wikilink 不含 markdown 链接
console.log(`[vault_backlinks format] all 命中 markdown 链接: ${blAllOk}; 默认 wikilink 不误报: ${blWlOk}`)
if (!blAllOk || !blWlOk) process.exitCode = 1

// —— vault_list_notes all：列出附件并带扩展名 ——
await mkdir(path.join(SCRATCH, 'assets'), { recursive: true })
await writeFile(path.join(SCRATCH, 'assets', 'pic.png'), Buffer.from([1, 2, 3]))
const listAll = await tools2.find((t) => t.name === 'vault_list_notes').execute(
  { folder: 'assets', all: true },
  { agent: undefined, signal: undefined, name: 'vault_list_notes', arguments: {} },
)
const listAllOk = listAll.notes.some((n) => n.path === 'assets/pic.png' && n.extension === 'png')
console.log(`[vault_list_notes all] 附件带扩展名: ${listAllOk}`)
if (!listAllOk) process.exitCode = 1

await rm(SCRATCH, { recursive: true, force: true })
console.log('\n冒烟测试完成')
