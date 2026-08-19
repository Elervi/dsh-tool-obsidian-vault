# Obsidian 模式（自包含 preset）

一个**开箱即用**的 DSH agent preset：标准模式的全部能力 + Obsidian vault 专用工具
（列表/搜索/读取/创建/编辑笔记、反向链接、frontmatter 等 16 个 `vault_*` 工具）
与 Obsidian 写作约定技能。整个目录自带插件副本（`vendor/`），不需要 npm、不需要
改任何路径。

## 安装（三步）

前置：已安装 DSH（`npm i -g @deepseek-ai/dsh`）并至少启动过一次界面（初始化默认 profile）。

1. 把本目录复制为预设（目录名即预设 id，可用任意小写字母/数字/连字符）：

   ```bash
   mkdir -p ~/.dsh/.agent-presets
   cp -R <本目录> ~/.dsh/.agent-presets/obsidian
   ```

2. 重启 DSH（或刷新界面）。

3. 新建会话，在预设选择器里选「Obsidian 模式」。

验证：会话工具列表里出现 `vault_list_vaults` / `vault_current` / `vault_search` 等
`vault_*` 工具即成功；未出现时检查 `~/.dsh/.agent-presets/obsidian/` 目录完整性
（`vendor/dsh-tool-obsidian-vault/lib/index.js` 必须存在）。

## 自定义

- **预设 id**：重命名目录即可（如 `obsidian-lite`），无需改文件。
- **工具行为**：编辑 `agent.cordis.yml` 里 `tool-obsidian-vault` 行的 `config`——
  `maxResults`（搜索上限）、`ignoreDirs`（忽略目录）、`vaultRoot`/`vaultRoots`
  （固定库）、`allowArbitraryRoots`（是否放行未注册的绝对路径）等。
- **人设**：编辑 `persona` 行的 `config.text`。
- **技能**：`skills/` 目录随预设走，可增删。
- **升级插件**：见 `vendor/dsh-tool-obsidian-vault/VENDOR.md`。

## 升级

`preset/` 是完整快照：升级 = 用新版本覆盖旧文件。**升级后重启 DSH**，新会话生效
（运行中的会话沿用旧组成，直到重启）。

版本号：`vendor/dsh-tool-obsidian-vault/package.json` 的 `version` 字段。

**方式 A：未自定义过（或接受恢复默认）——整体替换：**

```bash
cp -R dsh-tool-obsidian-vault/preset/. ~/.dsh/.agent-presets/obsidian/
```

（把 `dsh-tool-obsidian-vault` 换成你 clone 的路径；`preset/.` 连隐藏文件一起覆盖）

**方式 B：自定义过 `agent.cordis.yml` / `preset.yml` / `skills/`——只换插件快照，配置手动合并：**

```bash
rm -rf ~/.dsh/.agent-presets/obsidian/vendor
cp -R dsh-tool-obsidian-vault/preset/vendor ~/.dsh/.agent-presets/obsidian/
diff ~/.dsh/.agent-presets/obsidian/agent.cordis.yml dsh-tool-obsidian-vault/preset/agent.cordis.yml   # 有差异则手动合并
diff ~/.dsh/.agent-presets/obsidian/preset.yml  dsh-tool-obsidian-vault/preset/preset.yml
```

## 说明

- 本 preset 只把工具挂到「这个模式的会话」上（agent 平面），host 平面不挂载，
  标准模式等其它预设不受影响。
- vault 工具的「当前库」解析只认 dsh-dock per-vault 注入（`DSH_OBSIDIAN_VAULT_PATH`）
  或最近活跃的已打开库；未绑定的会话不会把工作目录冒充为库。
- 插件副本（`vendor/`）是自包含快照，请保持目录完整。
