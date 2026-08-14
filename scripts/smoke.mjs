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
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
      target: { targetKey: path.join(target.targetKey, e.name), displayPath: path.join(target.targetKey, e.name) },
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

const first = lines.find((l) => l.startsWith('- '))?.replace(/^-\s*/, '').replace(/\s+\(\d+ B\)$/, '')
const stem = first?.split('/').pop().replace(/\.md$/, '')

if (first) {
  const read = await call(tools, 'vault_read_note', { path: first })
  console.log('\n[vault_read_note] ' + read.slice(0, 200) + (read.length > 200 ? '…' : ''))
  console.log('\n[vault_search "' + stem + '"]\n' + (await call(tools, 'vault_search', { query: stem })))
  console.log('\n[vault_backlinks "' + stem + '"]\n' + (await call(tools, 'vault_backlinks', { title: stem })))
}

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
await rm(SCRATCH, { recursive: true, force: true })
console.log('\n冒烟测试完成')
