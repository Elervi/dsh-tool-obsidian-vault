// 验证本轮修复：尖括号带空格 markdown 路径、aliases 解析、rename 失败回滚。
// 用与 smoke.mjs 相同的 shim FileSystem 直接调用 lib 里的纯函数与工具。
import { readFile, writeFile, mkdir, readdir, stat, rm, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { registerTools } from '../lib/tools.js'
import { Config } from '../lib/config.js'
import {
  extractMarkdownLinks, resolveMarkdownTarget, rewriteMarkdownLinks, buildLinkResolver,
  indexAliases, resolveLinkTarget, parseFrontmatter,
} from '../lib/vault.js'

let failures = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}

// —— 1. 尖括号带空格 markdown 路径 ——
{
  const body = 'a [正常](dir/note.md) b [带空格](<my note.md>) c [锚点](<a b.md#h>) d ![图](<img 1.png>) e [外链](https://example.com)'
  const links = extractMarkdownLinks(body)
  const targets = links.map((l) => l.target)
  check('尖括号带空格路径被完整提取', targets.includes('my note.md'), JSON.stringify(targets))
  check('尖括号锚点分离', targets.includes('a b.md#h'), JSON.stringify(targets))
  check('图片嵌入被排除', !targets.includes('img 1.png'), JSON.stringify(targets))
  check('普通路径不受影响', targets.includes('dir/note.md'))

  const resolver = buildLinkResolver([
    { path: 'my note.md', target: { targetKey: 'x', displayPath: 'x' } },
    { path: 'a b.md', target: { targetKey: 'y', displayPath: 'y' } },
  ])
  const resolved = resolveMarkdownTarget('<my note.md>', '', resolver)
  check('resolveMarkdownTarget 解析尖括号带空格路径', resolved === 'my note', String(resolved))
  const rw = rewriteMarkdownLinks('看 [旧文](<my note.md>)。', 'renamed/new name.md', resolver, 'my note', '')
  // 原链接是尖括号形式（目标含空格），改写后保留尖括号形式
  check('rewriteMarkdownLinks 改写尖括号路径', rw.text.includes('[旧文](<renamed/new name>)'), JSON.stringify(rw))
}

// —— 2. aliases 解析 ——
{
  const resolver = buildLinkResolver([
    { path: '笔记/目标笔记.md', target: { targetKey: 'a', displayPath: 'a' } },
    { path: '其他.md', target: { targetKey: 'b', displayPath: 'b' } },
  ])
  indexAliases(resolver, [
    { path: '笔记/目标笔记.md', body: '---\naliases: [目标别名, 第二别名]\n---\n# 内容' },
  ])
  check('别名解析到目标', resolveLinkTarget(resolver, '目标别名', '目标别名') === '笔记/目标笔记', String(resolveLinkTarget(resolver, '目标别名', '目标别名')))
  check('第二别名解析', resolveLinkTarget(resolver, '第二别名', '第二别名') === '笔记/目标笔记')
  check('文件名仍可解析', resolveLinkTarget(resolver, '其他', '其他') === '其他')
  check('未知目标返回 undefined', resolveLinkTarget(resolver, '不存在', '不存在') === undefined)
}

// —— 3. rename 失败回滚：改写引用阶段注入版本冲突，验证全量回滚 ——
{
  const SCRATCH = await mkdtemp(path.join(tmpdir(), 'dsh-verify-'))
  // 模拟并发修改：写 b.md 时先被外部篡改，使 replaceIfVersion 版本失配
  const SABOTAGE = 'b.md'
  class ShimFs {
    async resolve(p, opts = {}) {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts.cwd ?? process.cwd(), p)
      return { targetKey: abs, displayPath: abs }
    }
    contains(parent, child) {
      const p = parent.targetKey.endsWith('/') ? parent.targetKey : parent.targetKey + '/'
      return child.targetKey === parent.targetKey || child.targetKey.startsWith(p)
    }
    async stat(t) {
      try {
        const s = await stat(t.targetKey)
        return { version: `${s.mtimeMs}-${s.size}`, type: s.isDirectory() ? 'directory' : 'file', size: s.size }
      } catch { return undefined }
    }
    async listDir(t) {
      const entries = await readdir(t.targetKey, { withFileTypes: true })
      return await Promise.all(entries.map(async (e) => {
        let version, size
        if (e.isFile()) {
          try { const s = await stat(path.join(t.targetKey, e.name)); version = `${s.mtimeMs}-${s.size}`; size = s.size } catch {}
        }
        return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', version, size, target: { targetKey: path.join(t.targetKey, e.name), displayPath: path.join(t.targetKey, e.name) } }
      }))
    }
    async readText(t) { return await readFile(t.targetKey, 'utf8') }
    async writeText(t, content, intent) {
      let exists = false
      try { await stat(t.targetKey); exists = true } catch { exists = false }
      // 模拟并发：目标文件在写入前被外部修改（仅当是守卫替换且非新建）
      if (intent?.kind === 'replaceIfVersion' && path.basename(t.targetKey) === SABOTAGE) {
        await writeFile(t.targetKey, '并发篡改\n', 'utf8')
      }
      if (intent?.kind === 'createIfAbsent' && exists) {
        const e = new Error('already exists'); e.code = 'FS_NOT_OBSERVED'; throw e
      }
      if (intent?.kind === 'replaceIfVersion') {
        if (!exists) {
          const e = new Error('stale'); e.code = 'FS_STALE_VERSION'; throw e
        }
        // s 是 node:fs 的 Stats 对象，没有 .version；用与 shim stat 相同的格式比较
        const s = await stat(t.targetKey)
        const now = s.mtimeMs + '-' + s.size
        if (now !== intent.version) {
          const e = new Error('stale'); e.code = 'FS_STALE_VERSION'; throw e
        }
      }
      await mkdir(path.dirname(t.targetKey), { recursive: true })
      await writeFile(t.targetKey, content, 'utf8')
      const s = await stat(t.targetKey)
      return { operation: exists ? 'update' : 'create', version: s.version, before: null, after: content }
    }
    async editText(t, edit, expected) {
      const current = await stat(t.targetKey)
      const version = `${current.mtimeMs}-${current.size}`
      if (expected?.version && expected.version !== version) {
        const e = new Error('stale'); e.code = 'FS_STALE_VERSION'; throw e
      }
      const text = await readFile(t.targetKey, 'utf8')
      const count = text.split(edit.oldString).length - 1
      if (count === 0) { const e = new Error('nf'); e.code = 'FS_EDIT_NOT_FOUND'; throw e }
      if (!edit.replaceAll && count > 1) { const e = new Error('amb'); e.code = 'FS_AMBIGUOUS_EDIT'; throw e }
      const after = edit.replaceAll ? text.split(edit.oldString).join(edit.newString) : text.replace(edit.oldString, edit.newString)
      await writeFile(t.targetKey, after, 'utf8')
      return { version: 'v', before: text, after }
    }
    emit() {}
  }
  const makeCtx = (cfg) => {
    const tools = []
    const ctx = { fs: new ShimFs(), tools: { register(def) { tools.push(def) } }, systemPrompt: { section() { return () => {} } }, emit: () => {} }
    registerTools(ctx, cfg)
    ctx.tools = tools
    return ctx
  }
  const call = async (ctx, name, args) => {
    const tool = ctx.tools.find((t) => t.name === name)
    try {
      return await tool.execute(args, { agent: undefined, signal: undefined, name, arguments: args })
    } catch (e) {
      return { __error: e.message }
    }
  }
  const cfg = Config({ vaultRoot: SCRATCH, ignoreDirs: [] })
  const ctx = makeCtx(cfg)
  // 引用顺序（预检按 walk 排序）：a → b → c；b 在写入时被并发篡改 → 触发回滚
  await writeFile(path.join(SCRATCH, 'a.md'), '见 [[old]]。\n', 'utf8')
  await writeFile(path.join(SCRATCH, 'b.md'), '见 [[old]]。\n', 'utf8')
  await writeFile(path.join(SCRATCH, 'c.md'), '见 [[old]]。\n', 'utf8')
  await writeFile(path.join(SCRATCH, 'old.md'), '# old\n', 'utf8')

  const r = await call(ctx, 'vault_rename_note', { old_path: 'old', new_path: 'newname' })
  check('rename 失败返回错误', typeof r.__error === 'string', String(r.__error).slice(0, 160))
  check('错误信息含回滚提示', r.__error?.includes('回滚') ?? false, String(r.__error).slice(0, 160))
  const aAfter = await readFile(path.join(SCRATCH, 'a.md'), 'utf8')
  const cAfter = await readFile(path.join(SCRATCH, 'c.md'), 'utf8')
  const newExists = await stat(path.join(SCRATCH, 'newname.md')).then(() => true).catch(() => false)
  check('a.md 已回滚（保留 [[old]]）', aAfter.includes('[[old]]'), JSON.stringify(aAfter))
  check('c.md 已回滚（保留 [[old]]）', cAfter.includes('[[old]]'), JSON.stringify(cAfter))
  check('新文件未创建（无残留）', !newExists)
  await rm(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部验证通过' : `\n${failures} 项验证失败`)
process.exitCode = failures === 0 ? 0 : 1
