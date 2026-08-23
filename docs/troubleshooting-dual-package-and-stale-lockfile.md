# 排障：双包危害 与 profile 锁文件过期（2026-08-23 记录）

> 本文记录 v0.6.0 → v0.6.1 期间排查并修复的两个问题：preset 自包含拷贝导致的
> **双包危害**（插件与宿主各持一份 `@deepseek-ai/*` 核心），以及 DSH 升级后
> profile 的 **pnpm 锁文件过期**（rc.6/rc.8 旧解析粘性残留）。含根因、修复、
> 验证与防复发步骤。对应 commit：`e9e918e`。

---

## 一、问题一：双包危害（dual-package hazard）

### 现象

- preset 路径（`~/.dsh/.agent-presets/obsidian`，自包含拷贝）里工具报错时，
  `ToolFailure.info` 里的结构化错误码（`VAULT_*` / `FS_*`）**不出现**，只留
  message 文本。
- 插件 `VaultError extends HarnessError` 的设计契约（错误码可程序化路由）失效。

### 根因

v0.6.0 的 preset 用**相对路径**挂载插件：

```yaml
# v0.6.0（错误设计）
- id: tool-obsidian-vault
  name: './vendor/dsh-tool-obsidian-vault/lib/index.js'   # ← 相对路径
```

preset 加载器（`@deepseek-ai/dsh-agent-presets` 的 `PresetTree.import`）对
**相对路径按 preset 目录解析**、对**裸包名按宿主 node_modules 解析**。相对路径
导致插件 `import '@deepseek-ai/dsh-llm'` 命中 `vendor/.../node_modules` 里
**vendored 的 rc.6 副本**，而宿主 tools 运行时用的是 profile 里的 **rc.2 副本**。

两份副本各定义了自己的 `HarnessError` 类——同名同姓的两个类。宿主对工具抛错做
`error instanceof HarnessError`（dsh-tools `index.js:2504`）提取错误码时，对
vendored 副本抛出的错误返回 `false`，错误码被静默丢弃。即使 vendor 与宿主
**同版本**，只要路径不同就是两个模块实例，`instanceof` 照样失效。

### 修复（v0.6.1）

1. preset 挂载行改**裸包名**，让加载器按宿主解析：

   ```yaml
   # v0.6.1（正确设计）
   - id: tool-obsidian-vault
     name: 'dsh-tool-obsidian-vault'   # ← 裸包名，解析自 profile node_modules
   ```

2. 删除 `presets/obsidian/vendor/`（内置的第二套 rc.6 核心栈，295 个文件）。
3. 依赖声明对齐：运行时依赖全部为 peer（`cordis` / `dsh-tools` / `dsh-llm` /
   `schemastery`），devDependencies 升到 0.1.1-rc.2 与 peer 一致。

> 代价：preset 不再"完全自包含"，使用前必须先把 bundle 装进 profile
> （`dsh plugin add` 的一键安装路径本来就保证这一点）。

### 验证

```sh
node --input-type=module -e "
import { createRequire } from 'node:module';
const r1 = createRequire('/Users/guagor/.dsh/profiles/web/node_modules/dsh-tool-obsidian-vault/lib/index.js');
const r2 = createRequire('/Users/guagor/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js');
console.log(r1.resolve('@deepseek-ai/dsh-llm') === r2.resolve('@deepseek-ai/dsh-llm') ? '✅ 同一实例' : '❌ 双包');
"
```

修复前：`❌ 双包`（vendored rc.6 vs profile rc.2）。修复后：`✅ 同一实例`，
且 `VaultError instanceof 宿主 HarnessError` = `true`（结构化错误码恢复）。

---

## 二、问题二：profile 锁文件过期（pnpm 粘性旧解析）

### 现象

DSH 升级后（宿主 CLI 0.1.1-rc.2），`~/.dsh/profiles/web` 里跑：

```sh
pnpm update
```

输出 `Already up to date`，但随后报一堆 `unmet peer`：

```
WARN Issues with peer dependencies found
├─┬ @deepseek-ai/dsh-llm 0.1.1-rc.2
│ ├── ✕ unmet peer @deepseek-ai/dsh-brand@^0.1.1-rc.2: found 0.1.0-rc.8
│ └── ✕ unmet peer @deepseek-ai/dsh-attachment@^0.1.1-rc.2: found 0.1.0-rc.8
├─┬ @deepseek-ai/dsh-session 0.1.1-rc.2
│ ├── ✕ unmet peer @deepseek-ai/dsh-brand@^0.1.1-rc.2: found 0.1.0-rc.8
│ ...
└─┬ @deepseek-ai/dsh-subagent 0.1.1-rc.2
  ├── ✕ unmet peer @deepseek-ai/dsh-agent@^0.1.1-rc.2: found 0.1.0-rc.6
  └── ✕ unmet peer @deepseek-ai/dsh-tools@^0.1.1-rc.2: found 0.1.0-rc.6
```

### 根因

`pnpm-lock.yaml` 是跨 rc.6 → rc.2 迁移期生成的，里面**固定了旧版本的解析**
（`dsh-tools@0.1.0-rc.6`、`dsh-brand@0.1.0-rc.8`、`dsh-scope@0.1.0-rc.8` …）。
宿主 CLI 升级（`/opt/homebrew` 里的 `@deepseek-ai/dsh`）**不会**自动更新
profile 锁文件；而 pnpm 对锁内已解析的 peer 是**粘性**的——`pnpm update` 只更新
"声明范围内有更新"的包，这些旧解析既不违反声明范围（它们来自 `^0.1.0-rc.x`
声明），peer 重解又不会自动发生，所以一直"Already up to date"却带病。

### 修复（唯一有效：删锁重装）

在 **profile 副本**上实测过三种方案：

| 方案 | 结果 |
| --- | --- |
| `pnpm update` | ❌ Already up to date，10 处 unmet peer 原样 |
| `pnpm install --fix-lockfile` | ❌ 同样无效，dsh-tools 仍 0.1.0-rc.6 |
| **删 `pnpm-lock.yaml` + `node_modules` 重装** | ✅ 全部收敛 0.1.1-rc.2，0 处 unmet peer |

正确步骤（真实 profile）：

```sh
# 0. 先关掉 dsh web（避免 node_modules 被占用）
cd ~/.dsh/profiles/web

# 1. 备份旧锁（可回滚）
cp pnpm-lock.yaml ~/pnpm-lock.yaml.bak

# 2. 删锁 + node_modules，全新重装
rm -rf node_modules pnpm-lock.yaml
pnpm install

# 3. 验证：应显示 Already up to date，且不再有 unmet peer 警告
pnpm update

# 4. 再装插件（GitHub main 已含 v0.6.1 修复）
dsh plugin --profile web add -w github:Elervi/dsh-tool-obsidian-vault

# 5. 重启 dsh web → 新建会话选「Obsidian 模式」
```

修复后新锁的关键版本（已验证）：

```
@deepseek-ai/dsh-tools@0.1.1-rc.2          @deepseek-ai/dsh-llm@0.1.1-rc.2
@deepseek-ai/dsh-session@0.1.1-rc.2        @deepseek-ai/dsh-brand@0.1.1-rc.2
@deepseek-ai/dsh-scope@0.1.1-rc.2          @deepseek-ai/dsh-agent@0.1.1-rc.2
@deepseek-ai/dsh-attachment@0.1.1-rc.2     @deepseek-ai/dsh-typert-protocol@0.1.1-rc.2
@deepseek-ai/dsh-user-approval@0.1.1-rc.2  @deepseek-ai/schemastery@3.18.1
rc.6 / rc.8 残留：0
```

---

## 三、安装顺序问题（结论）

"DSH 升级后先装 vault 插件，会不会影响后来的插件安装？"——实测结论：

- **不会**。profile 是独立 pnpm 工程，每次 `dsh plugin add` 独立解析；vault
  装完后 profile 收敛到单份 `dsh-tools@0.1.1-rc.2`（与宿主核心同一份），后装
  插件要么共享该副本、要么按需嵌套一份自己的（能用，只是核心重复有漂移风险）。
- 后装插件失败通常是**它自己的依赖图问题**（如 peer 范围与当前 registry 无匹配），
  与 vault 无关（实测 a3boy 插件在没装 vault 的干净 profile 上同样失败）。
- 真正会翻车的是**发布物过期**：旧 tarball（硬依赖 dsh-tools@0.1.0-rc.6）在
  升级后的干净 profile 上直接 `ERR_PNPM_NO_MATCHING_VERSION` 安装失败；能装上
  也会拖入旧核心副本。所以发布物必须与 main 同步重建（`npm run build && npm pack`）。

---

## 四、防复发清单

1. **依赖声明**：运行时依赖一律 peer，devDependencies 版本必须满足 peer 范围
   （否则 `npm install` ERESOLVE / 编译用错类型）。
2. **preset 挂载**：只用裸包名，绝不用 `./vendor/...` 相对路径内置插件副本。
3. **发布物**：每次改 `src/` 或依赖后重建 tarball / preset zip 并同步 release 目录。
4. **DSH 升级后**：先删锁重装对齐 profile 核心，再装/升插件。
5. **验证**：装完跑上文"双包验证"脚本；`pnpm update` 不应出现 unmet peer 警告。
