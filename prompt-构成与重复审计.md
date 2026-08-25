---
类型: 分析笔记
主题: DSH 提示词构成 / system-reminder / token 归属 / 重复审计 / 技能精简修正
关联插件: dsh-tool-obsidian-vault
日期: 2026-08-19
状态: 已执行
---

# DSH 提示词构成与重复审计

> 结论先行：system prompt、runtime context、system-reminder 三条都是模型输入，逐 token 计费（API 端 KV cache 会降低重复前缀成本，但 token 数照算）。Trajectory 调试面板里的 `summary / preview / raw / source` 是 UI 视图，不产生额外 tokens；`source` 是会话日志里的来源元数据，不发给模型。

## 一、三部分 prompt 由谁负责

| 部分 | 负责组件 | 源码位置 | 是否算 tokens |
| --- | --- | --- | --- |
| Initial system prompt | `@deepseek-ai/dsh-system-prompt`（SystemPrompt 服务）+ 各插件注册的有序 section + persona 段 | `node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js`；组装入口在 `dsh-agent-loop` 的 `preStep()` → `step()` 里 `renderPrompt(assembly)` 作为 system 消息发出 | ✅ 每次请求作为系统消息前缀发送 |
| Current runtime context | 同 `dsh-system-prompt`（`systemPrompt.context()` 注册的动态上下文），由 `dsh-agent-loop` 的 `RuntimeContextProjection` 投影成持久 user 消息 | `joinContextSections()` 拼出 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."（dsh-system-prompt lib/index.js 第 87 行）；投影逻辑在 `dsh-agent-loop/lib/index.js`（`SOURCE = "@deepseek-ai/dsh-system-prompt"`，`form: "snapshot"`） | ✅ user 消息，进历史，压缩前每次请求都带；快照每次变化追加新消息，旧快照在压缩前仍占窗口 |
| system-reminder | 各插件自己拥有 `<system-reminder>` 框架，写入 `user/message` 的 content 原样传给模型，核心不包装 | 本会话可见两类：`@deepseek-ai/dsh-tool-skill`（技能目录 `<available_skills>`）；`@deepseek-ai/dsh-agent-instructions`（AGENTS.md 基线/更新/移除） | ✅ user 消息，进历史，每次请求重新发送直到压缩 |

## 二、summary / preview / raw / source 是 UI 标签，不算 tokens

这些是 **Trajectory（轨迹）视图的详情标签页**（`dsh-client-ui-trajectory/lib/client.js` 的 `detailTabs()`），对一条 markdown 记录提供：

- **Summary（概览）**：同一 content 的摘要呈现
- **Preview（渲染后）**：markdown 渲染视图
- **Raw（原始文本）**：同一 content 的原始文本
- **Source（来源 JSON）**：会话日志中记录的来源元数据，如 `{kind:'plugin', plugin:…, form:'catalog', entries:[…]}`，用于 UI 标注与插件对账（digest）

它们都是**同一条已记录消息的不同展示方式**，模型实际只收到那一段 content 文本。唯一例外：技能目录里的 `<name>: <description>` 是模型可见文本（"This catalog contains summaries only"），这些描述确实计费，`catalogDescriptionMaxLength`（默认 500）就是限制它的。

## 三、重复审计

### 1. `tools:obsidian-vault` 提示词段 ↔ obsidian-conventions 技能（重复最严重）

系统提示词常驻 BASE 段（`dsh-tool-obsidian-vault/lib/prompt.js` 第 14 行）已覆盖：wikilink、frontmatter YAML、先定位→读取→写入工作流、vault_rename_note 自动更新链接、相对路径规则。而 obsidian-conventions 的 SKILL.md（`~/.dsh/.agent-presets/obsidian/skills/obsidian-conventions/SKILL.md`）约一半内容重复：

| SKILL.md 条目 | 系统提示词已有 |
| --- | --- |
| 路径一律库相对路径 | "所有路径都用 vault 根目录的相对路径" |
| Properties 用 `---` YAML、保留字段 | "frontmatter（Properties）用 YAML 包裹在 `---` 之间" |
| 笔记间用 wikilink | "用 [[wikilink]] 或 [text](path) 互链" |
| 先定位再动手的工作流 | "工作流程：先定位→读取→写入" |
| 写笔记前先说明意图 | persona 里 "State your intent before creating or modifying notes" |

### 2. 一处直接矛盾（最该改）

- SKILL.md 第 29 行：「**重命名会打断指向它的 [[wikilink]]**：优先内容编辑而非改名；必须改名时，**先找出并更新所有引用**（可用 vault_backlinks）」——写死"改名会断链、要手动修引用"。
- 工具提示词段：「重命名或移动笔记**务必用 vault_rename_note（自动更新全库 wikilink 与 markdown 链接并改写笔记自身引用；失败会自动回滚）**」。

技能早于 `vault_rename_note` 出现，已过时且互相打架。

### 3. persona ↔ 工具提示词段（冗余很小）

persona 结尾一句话复述了 vault 段内容（## 标题、保留 frontmatter、.obsidian 私有、优先 vault 工具），是有意的"摘要+细节"分层，可不动。

### 4. runtime context / system-reminder 无重复

文件策略 + 审批策略是每轮动态状态；技能目录只是名称 + 一句话描述。

## 四、SKILL.md 来源调查

**创建者：2026-08-14 的 DSH 智能体会话（cwd = /Users/guagor/Documents/DSH）按用户口头指示起草**，非官方随 DSH 分发，也非 Obsidian 插件自带。

会话 `session-d3d426b9`（`~/.dsh/sessions/--Users-guagor-Documents-DSH--/`，2026-08-14 创建）流程：

1. 用户：「我开发 obsidian agent 用哪个 agent 模式」
2. agent 对比 `code / minimal / standard / cordis` 四个内置 preset，用户「嗯 起草」
3. agent 用 write 起草整套 obsidian preset 4 个文件：
   - `obsidian-agent-preset/preset.yml`（"Obsidian 模式"）
   - `obsidian-agent-preset/agent.cordis.yml`
   - `obsidian-agent-preset/skills/obsidian-conventions/SKILL.md` ← 本文件
   - `obsidian-agent-preset/README.md`
4. 执行 `mkdir -p ~/.dsh/.agent-presets/obsidian && cp ...` 复制三件套到 `~/.dsh/.agent-presets/obsidian/`，把 `settings.yaml` 默认 preset 从 `cordis` 改为 `obsidian`，改 profile 的 `cordis.patch.yml`，启动 3081 端口验证。

时间线：

- SKILL.md 与 preset.yml 同秒创建（birth = 2026-08-14 21:02:26，为复制到 `~/.dsh` 的时间）
- `agent.cordis.yml` 2026-08-18 23:07 又改过（vault 工具从 5 个扩到 16 个、加技能目录等）
- 原始草稿 `/Users/guagor/Documents/DSH/obsidian-agent-preset/` 现已不存在，`~/.dsh/.agent-presets/obsidian/` 为唯一权威副本

这解释了重复的成因：SKILL.md 与 `prompt.js` 由两次会话里的 AI 独立撰写、互相对账，改名守则因此过时。

## 五、已执行的修改（2026-08-19）

判断：**技能本体有必要保留，但内容需精简**。理由：技能按需加载（不占常驻 token，常驻只有目录一行 description）；它含系统提示词没有的独有内容（Callout、嵌入、标签风格、每日笔记命名、字段一致性、忽略目录）；但约一半与 BASE/persona 重复，且改名守则已过时。

**已修改** `~/.dsh/.agent-presets/obsidian/skills/obsidian-conventions/SKILL.md`（31 行 → 23 行）：

- 删除重复：库结构/库根路径、wikilink/frontmatter 基础定义、先定位→读取→写入工作流、写笔记前说明意图
- 修正矛盾：改名守则改为「用 `vault_rename_note`，自动更新全库 wikilink 并回滚失败，不要手工逐处改引用」，与系统提示词口径一致
- 保留独有：Callout 语法、`![[嵌入]]`、标签风格、每日笔记命名、frontmatter 字段一致性、`.obsidian/.trash/.git` 忽略、覆盖前先读原内容
- 文件开头加说明：系统提示词段已覆盖基础规则，本技能只补充细节，防止再次膨胀
- frontmatter 的 description 同步更新为「补充约定」，目录热刷新后模型看到的就是新描述

### 修改后是否需要重启

**不需要**。技能走按需读盘路径：

- 目录（description）由 dsh-tool-skill 的 catalog 热刷新在下一个 pre-step 自动更新（本次会话的 system-reminder 已证实）
- 正文由 `skill` 工具每次调用时从磁盘重新读取，无进程级缓存

**需要重启**的装配层改动见下一节。

## 六、装配层文件路径与重启判定

| 层 | 路径 | 改动是否需重启 |
| --- | --- | --- |
| Agent preset 装配 | `~/.dsh/.agent-presets/obsidian/agent.cordis.yml`（★ 主装配：persona/vault 工具/技能目录/plan/compaction/委托） | ✅ 需重启 |
| Agent preset 元信息 | `~/.dsh/.agent-presets/obsidian/preset.yml`（名称/描述/顺序，UI 预设选择器显示） | ✅ 需重启 |
| Profile 装配 | `~/.dsh/profiles/obsidian/cordis.yml` + `cordis.patch.yml`（★ 进程级插件装载，vault 插件在此挂载）；`web/`、`headless/` 同构 | ✅ 需重启 |
| 全局设置 | `~/.dsh/settings.yaml`（默认 preset、默认模型、主题） | ✅ 需重启 |
| 预设级技能正文 | `~/.dsh/.agent-presets/obsidian/skills/**/SKILL.md` | ❌ 热生效，无需重启 |

注意：`dsh-first-turn-minimal` 这类插件挂在 profile 的 patch 层时只在**新会话**生效；当前会话要重开才看到装配变化（与技能修改无关）。

## 参考资料

- `dsh-tool-obsidian-vault/lib/prompt.js` —— `tools:obsidian-vault` 提示词段（BASE + 绑定断言）
- `~/.dsh/.agent-presets/obsidian/skills/obsidian-conventions/SKILL.md` —— 技能本体
- `~/.dsh/.agent-presets/obsidian/agent.cordis.yml` —— obsidian preset 组装配置
- `~/.dsh/.agent-presets/obsidian/preset.yml` —— preset 元信息（"Obsidian 模式"）
- `node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js` —— 系统提示词服务
- `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` —— runtime context 投影
- `node_modules/@deepseek-ai/dsh-tool-skill/README.md` —— 技能目录 system-reminder 模板与 token 说明
- `node_modules/@deepseek-ai/dsh-agent-instructions/README.md` —— AGENTS.md system-reminder 框架
- `node_modules/@deepseek-ai/dsh-client-ui-trajectory/lib/client.js` —— Summary/Preview/Raw/Source 标签页
- 会话日志 `~/.dsh/sessions/--Users-guagor-Documents-DSH--/session-d3d426b9*/session.jsonl.zstd` —— SKILL.md 创建记录
