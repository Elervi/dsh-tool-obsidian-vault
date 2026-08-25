# Obsidian 模式（agent preset）

标准模式的全部能力 + Obsidian vault 专用工具（列表/搜索/读取/创建/编辑笔记、
反向链接、frontmatter 等 20 个 `vault_*` 工具）与 Obsidian 写作约定技能。

工具来自 profile bundle **`dsh-tool-obsidian-vault`**：本 preset 用**裸包名**挂载它，
加载器按宿主的 node_modules 解析（与宿主核心共用同一份 `@deepseek-ai/*` 模块实例，
不存在双包副本，`ToolFailure.info` 的结构化错误码可用）。因此**使用本 preset 前
必须先把该 bundle 装进 profile**。

## 安装

**推荐（一条命令，v0.6.0+）**：包以 profile bundle 装入，重启后本目录会自动
装进 `~/.dsh/.agent-presets/obsidian/`（幂等，已存在则跳过）：

```bash
dsh plugin --profile web add -w github:Elervi/dsh-tool-obsidian-vault
```

（`-w`：profile 目录带 `pnpm-workspace.yaml`，pnpm 要求显式声明添加到 workspace 根；
若你的 pnpm 已配置 `ignore-workspace-root-check`，可省略。）

**或手动三步**（适用于任何 DSH 版本 / 非 web profile）：

前置：已安装 DSH（`npm i -g @deepseek-ai/dsh`）并至少启动过一次界面（初始化默认 profile）；
且已把 `dsh-tool-obsidian-vault` 装进该 profile 的 node_modules（`dsh plugin --profile <name> add ...`，
或 `npm/pnpm install dsh-tool-obsidian-vault@>=0.6.1`）。

1. 把本目录复制为预设（目录名即预设 id，可用任意小写字母/数字/连字符）：

   ```bash
   mkdir -p ~/.dsh/.agent-presets
   cp -R <本目录> ~/.dsh/.agent-presets/obsidian
   ```

2. 重启 DSH（或刷新界面）。

3. 新建会话，在预设选择器里选「Obsidian 模式」。

验证：会话工具列表里出现 `vault_list_vaults` / `vault_current` / `vault_search` 等
`vault_*` 工具即成功；未出现时先确认 bundle 已装入 profile（`dsh plugin --profile web ls`），
再检查 `~/.dsh/.agent-presets/obsidian/` 目录完整性。

## 自定义

- **预设 id**：重命名目录即可（如 `obsidian-lite`），无需改文件。
- **工具行为**：编辑 `agent.cordis.yml` 里 `tool-obsidian-vault` 行的 `config`——
  `maxResults`（搜索上限）、`ignoreDirs`（忽略目录）、`vaultRoot`/`vaultRoots`
  （固定库）、`allowArbitraryRoots`（是否放行未注册的绝对路径）等。
- **人设**：编辑 `persona` 行的 `config.text`。
- **技能**：`skills/` 目录随预设走，可增删。
- **升级插件**：`dsh plugin --profile web update dsh-tool-obsidian-vault`（bundle 更新后重启生效）。

## 升级

bundle 与 preset 分开升级：

- **bundle**：`dsh plugin --profile web update dsh-tool-obsidian-vault`，重启后新会话生效。
- **preset 目录**：`v0.6.2+` 起由插件在下次启动时**自动同步**（`installPreset` 的
  `mode: 'merge'` 默认）：你改过的文件保留，没动过的更新到新版，插件新增/移除的
  文件跟随；首装会写基线清单（`.dsh-preset-manifest.json`）。旧版/手工放下的目录
  无基线，会先按“保留”落地清单——想让这类目录彻底跟上新版，删除
  `~/.dsh/.agent-presets/obsidian/` 后重启一次即可。

## 说明

- 本 preset 只把工具挂到「这个模式的会话」上（agent 平面），host 平面不挂载，
  标准模式等其它预设不受影响。
- vault 工具的「当前库」解析只认 dsh-dock per-vault 注入（`DSH_OBSIDIAN_VAULT_PATH`）
  或最近活跃的已打开库；未绑定的会话不会把工作目录冒充为库。
- 本 preset 不再自带插件副本（v0.6.1 起移除 `vendor/`）：插件按裸包名从 profile
  解析，与宿主核心共用同一份模块实例——这是结构化错误码（`ToolFailure.info`）
  生效的前提，也是消除双包危害的根因。
