# dsh-chatops-mcp

把**钉钉**、**飞书**、**飞书项目（Meego）**接成三个 MCP 工具服务器，挂进 DeepSeek Harness。

| MCP serverName | 工具前缀 | 实现方式 | 凭据来源 |
|---|---|---|---|
| `dingtalk` | `mcp__dingtalk__*` | 本包 `server.js dingtalk`，包装 `dws` CLI | `%USERPROFILE%\.dws` 已有登录 |
| `feishu` | `mcp__feishu__*` | 本包 `server.js feishu`，包装 `lark-cli` | `%USERPROFILE%\.lark-cli` 已有登录 |
| `meego` | `mcp__meego__*` | **官方** `@lark-project/mcp`（48 工具），经 `meego-launch.js` 注入 token | `%USERPROFILE%\.dsh\chatops\meego\.env` |

钉钉和飞书复用本机已有 CLI 登录态，零新增应用密钥；飞书项目直接用官方服务器，不自己实现 Open API。

v1.5.0 起本包变成**连接器市场**：面板里点「连接」就写 MCP 配置、缺 CLI 就地装、缺登录走设备码授权 —— 见 [连接器](#连接器v150-起)。v1.5.1 补上持久化（Loader 的根树只在内存，重启会丢行，因此本包自记一份 `connections.json` 并在启动时重建；启停位还要挂 `app-boot/config-reload` 再压一遍，否则会被 patch 覆盖）。v1.5.2 只改文案：面板底部那句原写「写入 profile 的 cordis.yml」是错的，改为「写进 Loader + 记到 connections.json」；副标题原写「命中率 8 h」也错了，那是缓存 TTL。v1.5.3 改交互：卡片上的 `+` 直接连（不再先进弹层），「添加 MCP」改成整段贴 JSON。v1.5.4 修一个会让连接在重启后失效的 bug：写进 `command` 的原来是 `process.execPath`，宿主跑在 Electron 里时它等于 `DeepSeek Harness.exe`，见 [node 路径](#node-路径不要用-processexecpath)。**v1.6.0 把包做成真的可移植**：包内不再有任何本机绝对路径，`cordis.patch.yml` 不再预置 mcp-client 行，三条连接改由启动时的 `seedBuiltins` 自行 provision（CLI 没装就跳过，等用户点 `+`）—— 见 [给别人用](#给别人用分发与安装)。**v1.6.1 默认启用写工具**：内置连接的 `CHATOPS_TOOL_EFFECT` 从 `read` 改为 `all`，`mcp__dingtalk__*` / `mcp__feishu__*` 里会直接出现发消息、建日程、建待办这类命令；同时 `seedBuiltins` 改成「已有行也按 CATALOG 现算 config 就地 update」，否则老 store 的 `read` 永远追不上新默认值。**v1.6.1 已发布到 npmjs**，正式包名 **`dsh-chatops-mcp`**（v1.7.0 起改名为无 scope），别人 `plugin_manager action=install_bundle target=dsh-chatops-mcp` 即可。

## 工具面跟着 CLI 升级走（v1.2.0 起）

钉钉 / 飞书两条 surface 的工具清单不再写死在代码里，而是**读 CLI 自己的 schema**生成：

| CLI | 自描述命令 | 规模 | 冷启动耗时 |
|---|---|---|---|
| `dws` | `dws schema --all --compact --format json` | 27 个产品 / **1098** 个命令 | ~6 s |
| `lark-cli` | `lark-cli schema` | 15 个 service / **246** 个命令 | ~13 s |

1300+ 个工具全量展开大约要 40 万 token 的工具定义，不现实。所以每条 surface 恒定暴露三个元工具，其余按需 materialise：

| 元工具 | 作用 |
|---|---|
| `dingtalk_catalog` / `feishu_catalog` | 一次调用列出 CLI **当前**支持的所有命令（可按 product / query / effect 过滤）。CLI 升级后新命令立刻出现在这里。 |
| `dingtalk_schema` / `feishu_schema` | 查单个命令的完整 flag 列表、类型、是否必填 |
| `dingtalk_cli` / `feishu_cli` | 逃生舱：`{"argv": ["..."]}` 原样跑任意子命令 |

在此之上，符合「产品白名单 × effect 过滤 × 数量上限」的命令会各自变成一个独立工具（工具名由 CLI 路径规范化而来，如 `contact user get-self` → `contact_user_get-self`）。v1.6.1 起内置连接器默认 `CHATOPS_TOOL_EFFECT=all`，**读写工具都会出现**；想收紧成只读就把该项改成 `read`。参数为 `read` / `all` / `any`，前两个之外的写法按 `read` 处理。

名额不是按名字母序截断，而是**先按产品轮转**（每个产品一轮各取一个），保证白名单里每个产品都有工具可用；同一产品内部先按语义优先级（`CHATOPS_TOOL_PRIORITY`，默认「消息 / 事件 / 待办 / 任务 / 审批 / 文档 / 文件 / 节点 / 空间 / 工作项 / 日历 / 用户 / 群 / 搜索」这类高频名词），再按命令路径长短排序。`+快捷命令` 与对应 raw API 只差 `-`/`_` 的会去重，避免一个能力占两份名额。

`effect` 按白名单判定：只有 CLI 明确标 `read` 的才算只读，其余（含 dws 的 `destructive`、飞书的 `high-risk-write`）一律归为写；`destructive` 的高危命令在 `*_catalog` 与 `*_schema` 结果里会带 `"destructive": true`。

schema 结果缓存在 `%USERPROFILE%\.dsh\chatops\cache\<surface>.json`（默认 8 小时），所以只有首次启动慢；缓存过期后会重新扫一遍，失败时回退到旧缓存并在 catalog 里标注。

## 飞书项目为什么用官方的

`@lark-project/mcp`（`meego-mcp-cli`）是本地 stdio ↔ 远端的纯代理：连 `https://project.feishu.cn/mcp_server/v1`，header 带 `X-Mcp-Token: <user_token>`、`X-Meego-MCP-Connection-Type: stdio`，只代理 `tools/list` 与 `tools/call`。48 个工具覆盖工作项增删改查、字段/视图/模板/角色配置、WBS 草稿、节点流转、MQL 搜索、评论、工时、附件上传等 —— 比自建 surface 覆盖更全，也不需要 `plugin_id` / `plugin_secret`。

本包早期版本自带一个直连 Open API 的 `meego.js`（12 个工具，走 `plugin_token`），已删除。

## 钉钉 / 飞书为什么自己包一层

npm 上的现成钉钉/飞书包都不是「通用工具面」：

| 包 | 缺口 |
|---|---|
| `@larksuiteoapi/lark-mcp`、`dsh-feishu-mcp` | 只覆盖飞书，且要另配 appId/appSecret |
| `@dingtalk-real-ai/dsh-dingtalk`、`dsh-connect-dingtalk`、`@xmanrui/dsh-im` | IM 频道/bot 桥，不是工具面 |
| `dsh-dingtalk`、`dingtalk-dsh-assistant` | 只推群机器人 webhook / 群助理 |

而本机 `dws` 与 `lark-cli` 已登录且能自动续期，包一层 CLI 反而零凭据、随 CLI 升级自动获得新能力。

## 手写工具（恒在，不依赖 catalog）

功能固定的高频操作仍保留手写封装，参数名更友好、少一层 schema 查询。

### dingtalk（15 个）

| 工具 | 作用 |
|---|---|
| `dingtalk_whoami` | 当前登录身份（企业、部门、邮箱） |
| `dingtalk_user_search` | 按关键词搜通讯录用户 |
| `dingtalk_user_get` | 按 userId 批量取用户详情 |
| `dingtalk_dept_members` | 列部门成员 |
| `dingtalk_send_message` | 发消息到群 / 个人 / openDingtalkId |
| `dingtalk_list_messages` | 拉会话消息（需 `time` 锚点） |
| `dingtalk_list_groups` | 列我所在的群 |
| `dingtalk_calendar_events` | 查日历事件 |
| `dingtalk_calendar_create` | 建日程（可带参会人） |
| `dingtalk_todo_list` | 列待办 |
| `dingtalk_todo_create` | 建待办并指派 |
| `dingtalk_approval_pending` | 我的待审批 |
| `dingtalk_approval_detail` | 审批实例详情 |
| `dingtalk_drive_list` | 列钉盘目录 |
| `dingtalk_cli` | 逃生舱：任意 dws 子命令 |

### feishu（13 个）

| 工具 | 作用 |
|---|---|
| `feishu_whoami` | 当前身份与 token 状态 |
| `feishu_user_search` | 搜人 / 按 open_id 解析 |
| `feishu_user_get` | 单人详情（省略 id = 自己） |
| `feishu_chat_list` | 列会话（group / p2p） |
| `feishu_messages_list` | 拉某个会话的消息 |
| `feishu_message_search` | 按关键词搜消息 |
| `feishu_send_message` | 发文本 / markdown |
| `feishu_calendar_agenda` | 日程 agenda |
| `feishu_task_create` | 建任务 |
| `feishu_my_tasks` | 我的任务 |
| `feishu_doc_fetch` | 读文档内容（支持 wiki URL） |
| `feishu_drive_search` | 搜云空间文档 |
| `feishu_cli` | 逃生舱：任意 lark-cli 命令 |

### meego（48 个，官方实现）

工作项：`create_workitem` `update_field` `get_workitem_brief` `search_by_mql` `search_project_info` `search_user_info` `list_workitem_types` `list_workitem_field_config` `list_workitem_role_config` `get_workitem_field_meta` `get_workitem_op_record` `get_workitem_man_hour_records` `list_related_workitem` `list_workitem_relations` `list_workitem_comments` `add_comment` `list_todo` `list_project_team` `list_team_members`

流转与节点：`transition_state` `transition_node` `get_transitable_states` `get_transition_required` `get_node_detail` `update_node` `update_node_subtask` `list_node_field_config`

视图与图表：`create_fixed_view` `update_fixed_view` `get_view_detail` `search_view_by_title` `list_multi_project_view_workitems` `create_resource_work_item` `get_resource_work_item_type_conf` `list_charts` `get_chart_detail` `list_schedule` `list_deliverables`

WBS 与模板：`create_wbs_draft` `edit_wbs_draft` `publish_wbs_draft` `reset_wbs_draft` `list_wbs_draft_rows` `list_wbs_instance_rows` `get_wbs_draft_operation_progress` `list_element_template`

文件：`upload_file` `get_download_url`

## 连接器（v1.5.0 起）

面板第一个页签是「连接器」—— 卡片墙 + 一键连接，不需要手改 `cordis.patch.yml`。

### 一键连接做了什么

点卡片 → 弹层 → 按状态提示走完三步，最后写一行 MCP 配置：

| 连接器 | 缺 CLI 时 | 缺登录时 | 写入的条目 |
|---|---|---|---|
| 钉钉 | `npm i -g dingtalk-workspace-cli` | `dws auth login --device --no-browser --recommend`，横幅里解析验证码与链接，后台进程一直轮询到授权完成 | `chatops-conn-dingtalk`，serverName `dingtalk` |
| 飞书 | `npm i -g @larksuite/cli` | `lark-cli auth login --no-wait --json --recommend` 拿 `device_code` + `verification_url`，点「我已授权」再 `--device-code` 换 token | `chatops-conn-feishu`，serverName `feishu` |
| 飞书项目 | —（官方服务器已在全局前缀下） | 填 MCP 用户令牌，写进 `%USERPROFILE%\.dsh\chatops\meego\.env` | `chatops-conn-meego`，serverName `meego` |

写入走宿主 `ctx.loader`（不是改文件）：

```js
await loader.create({ id: 'chatops-conn-dingtalk', name: '@deepseek-ai/dsh-mcp-client', config, disabled: false })
await loader.update(entryId, { config, disabled: false })   // 已存在时
loader.remove(entryId)                                      // 断开连接
```

### 持久化：Loader 只管内存，本包自己记一张表

**实测结论（别照抄别的插件文档）**：`ctx.loader.create/remove` 只改 Loader 自己的根树，而 `Loader.write()` 是空实现 —— 写完 profile 的 `cordis.yml` 仍然是 223 字节的 `[]`。也就是说光靠 `ctx.loader`，连接一重启就没了。

所以本包自己落一份 JSON：

```
%USERPROFILE%\.dsh\chatops\connections.json     # 可用 CHATOPS_CONNECTION_STORE 覆盖
{
  "version": 1,
  "entries": {
    "chatops-conn-dingtalk": { "name": "@deepseek-ai/dsh-mcp-client", "config": { … }, "disabled": false },
    "chatops-custom-foo":    { "name": "@deepseek-ai/dsh-mcp-client", "config": { … }, "disabled": true }
  }
}
```

- **写入时机**：连接 / 断开 / 启停 / 保存令牌（令牌类会重推 config）。
- **恢复时机**：插件 `apply(ctx)` 里第一件事就是 `rehydrate(loader)` —— 行还在（patch 行或 HMR 重载）就只恢复 `disabled` 位，行没了就用存下的 config 重新 `create`。
- **还要再压一次启停位**：`cordis.patch.yml` 里写着内置三条的原文，dsh 在 `app-boot/config-reload` 时会把 patch 重新应用到 include 上 —— 那一轮会用 patch 里的 options 覆盖整份 config，`disabled` 回到 patch 默认值（没写 = 启用）。实测：重启后 `rehydrate` 报 `resumed: ['include:chatops-mcp-dingtalk']`、store 里 `disabled: true`，面板却显示 `enabled: true / tools: 47`。所以插件还挂了 `ctx.on('app-boot/config-reload', …)` → `applyStoredFlags(loader)`：只对**已存在**的行按 store 压 `disabled`，绝不 create，单行失败吞掉等下次 reload 重试。
- **只管自己的行**：内置三条 + `chatops-custom-*`，别人插的 mcp-client 行一律不碰。
- 恢复结果在 `GET /chatops-mcp/connectors` 的 `rehydrate` 字段里可见（`restored` / `resumed` / `failed`）。

`dsh-mcp-connector` 走的是 `ctx.storageDomain`，效果相同但要多一个依赖；这里一个纯 JSON 文件够了。

### 卡片上能看到什么

- 徽标（钉 / 飞 / 项）、名称、两行摘要。
- 右上角 `+`（未连接）或绿色 `·`（已连接）。
- 底部 chip：`CLI 已装` / `需装 CLI` / `需令牌`、`N 个工具`（来自 `tools.schemas()` 里 `mcp__<server>__*` 的实际注册数）、`已停用`。
- 顶部汇总：`已连接 N` / `注册工具 N` / `MCP 行 N`；超过 80 个工具时顶部出现黄色告警条（工具过多会拉低回复质量）。

### 自定义连接

右上「+ 添加 MCP」默认就是**整段贴 JSON**（v1.5.3 起），直接粘 `mcpServers` 壳就能一次建多条，和 workbuddy / claude 的 `mcp.json` 同形：

```json
{
  "mcpServers": {
    "FeishuProjectMcp": {
      "command": "npx",
      "args": ["-y", "@lark-project/mcp", "--domain", "https://project.feishu.cn"],
      "env": { "MCP_USER_TOKEN": "m-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
    },
    "lighthouse-ops": {
      "type": "streamableHttp",
      "url": "https://lightai.cloud.tencent.com/workbuddy/mcp",
      "timeout": 30000
    }
  }
}
```

`parseMcpJson` 接受四种形状混贴：带 `mcpServers` 壳的、省略壳的 `{"a":{...}}`、单条 `{"serverName":"a","command":"npx"}`、数组 `[{...}]`。字段映射 `type` → `transport`（`streamableHttp` / `http` / `sse` 都归一为 `streamable-http`，没写就看有没有 `url`）、`timeout` → `toolCallTimeoutMs`、`disabled` 忽略（新连的一律启用）。**一条失败不影响其他条**，返回 `{ok, total, succeeded, results[]}`。

语法校验通过就建连，实际起不起得来由 mcp-client 自己的重连机制兜 —— 假 URL / 假包不会让整批失败，只是那一行的 `toolCount` 一直是 0。

也可以切到「手动填写」，走两种传输的逐字段表单：

| 传输 | 必填 | 其余 |
|---|---|---|
| `stdio` | `command` | `args`（每行一个）、`env`（每行 `KEY=VALUE`）、`cwd` |
| `streamable-http` | `url`（`http(s)://`） | `headers`（每行 `Key: Value`） |

`serverName` 必须是 `[A-Za-z0-9_-]{1,32}`，且不能与其他 MCP 行重名（重名会在写入前报「serverName「X」已被 Y 占用」）。自定义条目的 entryId 前缀是 `chatops-custom-`，面板底部表格可启停 / 删除。

### node 路径不要用 `process.execPath`

v1.5.3 及以前，`buildCatalogConfig` 把 `command` 写成 `process.execPath`。宿主跑在 Electron 里时它是 **`D:\DeepSeek Harness\DeepSeek Harness.exe`** —— 这个值被写进了 `connections.json`，重启后拿来 spawn 根本起不来，等于「连接只在本次进程内有效」。

v1.5.4 改成 `nodeCommand()`，顺序 `CHATOPS_NODE_BIN` 环境变量 → PATH 里的 `node` → 非 Electron 时的 `process.execPath` → 字面量 `node`。同一处还修了 `npmCliJs()`（原来按 Electron 的目录找 npm，必然找不到）和装 CLI 时 `run(process.execPath, ...)`。

历史脏数据有自愈：`rehydrate` 里对每条 store 记录跑 `fixNodeCommand()`，只纠正「等于 `process.execPath`」或「以 `DeepSeek Harness.exe` 结尾」这两种形状，用户自己填的 `npx` / 别的 node 路径原样保留；纠正后会写回 store，返回值的 `rehydrate.repaired` 为 `true`。

实测：往 store 里注入一条 `command` 为 `D:\DeepSeek Harness\DeepSeek Harness.exe` 的条目 → 重装触发 rehydrate → `{"restored":["chatops-custom-repairprobe"],"repaired":true}`，该行 `tools=17`，store 里的 `command` 已变成 `D:\nodejs\node.exe`。

### serverName 冲突与写工具

- 内置三条固定用 `dingtalk` / `feishu` / `meego`。若 profile 里已有别的行占了这些名字，连接会在写入前报错，不会把 dsh 搞成启动失败。
- 内置连接器生成的 config 显式写 `CHATOPS_TOOL_EFFECT=all`，**写工具默认可用**（v1.6.1 起；1.6.0 及之前是 `read`）。只想暴露只读工具时，把那一行的 env 改成 `read` 再重连。

## 面板（v1.5.0）

除了当 MCP 连接器，本包还带一个面板，三个入口共用同一份组件：

| 入口 | 座位 | 说明 |
|---|---|---|
| 左侧栏图标 | `sidebar.panellist`，`id=chatops-mcp`，`order=3` | 排在「插件」「插件市场」「记忆与人设」之后，标签 `钉钉/飞书连接器` |
| 主区域页面 | `main`，`key=chatops-mcp` | 点图标切过来 |
| 设置页 | `settings.section`，`id=chatops-mcp`，`order=45` | 与 memory-panel 一致，不占侧栏座位也能进 |

四个页签：

| 页签 | 内容 |
|---|---|
| 连接器 | 卡片墙 + 一键连接（已就绪的卡点右上 `+` 直接连，不先进弹层）+ 贴 JSON 添加 MCP（见上一节） |
| 概览 | 三条连接各一张卡：CLI 路径与版本、登录身份、组织/部门/邮箱、catalog 条数、已 materialise 数量与产品配比；飞书项目额外显示 server 入口、token 来源文件、脱敏 token 提示 |
| CLI 目录 | 直接浏览 `dws` / `lark-cli` 的完整 self-schema（1098 / 246 条），支持 surface 切换、关键词、product、effect 过滤；点任意行展开该命令的完整 flag 列表 |
| 工具预览 | 输入 products / effect / max，预览「按当前配置会 materialise 出哪些工具」，改参数不用重装就能看效果 |

视觉与交互对齐宿主自带面板（参考 `@xhzl/dsh-memory-panel` 与 `dshmarket`）：

- hero 头（32px 渐变 logo + 19px 标题 + 12px 副标题）、分段页签、双栏卡片。
- 左栏宽度 `clamp(240px, 32%, 380px)`，窄窗不挤爆右栏；目录行选中时左侧 2.5px 品牌色竖条。
- 搜索输入 180ms 防抖（200 行目录每敲一字符都发请求会互相覆盖）。
- 静态样式（hover / transition / focus）走 `ctx.effect` 注入一张 `<style>`（`data-plugin-css='dsh-chatops-mcp/panel.css'`），动态值仍内联；主题 token 全部取 `@deepseek-ai/dsh-client-ui-theme` 实际定义的那套，不自造色值。
- 目录行可键盘聚焦（`role=button` + `Enter`/`Space`），焦点环复用宿主 `:focus-visible` 行为，不自己写 `outline:none` 去覆盖。

概览 / CLI 目录 / 工具预览三个页签只读：不发消息、不改日程、不写任何远程状态。连接器页签会写本机 MCP 配置与 CLI 登录态，但不调用任何业务写接口。数据来自同进程内的 Host 路由：

| 路由 | 说明 |
|---|---|
| `GET /chatops-mcp/connectors` | 内置连接器目录 + 本机状态 + 自定义连接 + 工具计数 |
| `POST /chatops-mcp/connectors/connect` | 写一行 mcp-client（body `{"id":"dingtalk"}`） |
| `POST /chatops-mcp/connectors/disconnect` | 删掉那一行 |
| `POST /chatops-mcp/connectors/toggle` | 启用 / 停用（body `{"id":"dingtalk","enabled":false}`） |
| `POST /chatops-mcp/connectors/install` | 全局 npm 安装 CLI |
| `POST /chatops-mcp/connectors/login` | 开始设备码登录，返回验证链接与授权码 |
| `POST /chatops-mcp/connectors/login/finish` | 复查 / 用 `deviceCode` 完成登录 |
| `POST /chatops-mcp/connectors/logout` | 退出 CLI 登录 |
| `POST /chatops-mcp/connectors/token` | 写入飞书项目 MCP 用户令牌（已连接时会重推 config 让子进程拿到新值） |
| `POST /chatops-mcp/custom` | 建自定义连接（逐字段表单） |
| `POST /chatops-mcp/custom/json` | 贴 `mcpServers` JSON 批量建连接（body `{"json":"{...}"}`） |
| `POST /chatops-mcp/custom/remove` \| `/custom/toggle` | 删除 / 启停自定义连接 |
| `GET /chatops-mcp/state` | 三条 surface 的完整状态（含 health、catalog 大小、materialised 配比） |
| `GET /chatops-mcp/health?force=1` | 强制重探登录态（默认缓存 2 分钟） |
| `GET /chatops-mcp/catalog?surface=&query=&product=&effect=&limit=&refresh=` | 查 catalog |
| `GET /chatops-mcp/schema?surface=&command=` | 单命令的参数详情 |
| `GET /chatops-mcp/tools?surface=&products=&effect=&max=` | 预览动态工具名单 |
| `POST /chatops-mcp/refresh` | 忽略缓存重读 CLI schema（body `{"surface":"dingtalk"}`） |

面板作为 Host 插件 inject 了 `webServer` / `loader` / `tools` 三个服务；`loader` 拿不到时连接器会明确报「宿主没有提供 loader 服务」，不会静默失败。

## 给别人用（分发与安装）

v1.6.0 起包内**没有任何本机绝对路径**，也没有预置的 mcp-client 行，因此换机器、换用户名、换 Node 安装位置都能直接用。三条连接由插件自己在上电时 provision（`connectors.js` 的 `seedBuiltins`）：CLI 已装且已登录才自动建行，否则跳过、等用户在面板点 `+`。

### 三步装完（本机路径直装）

```bash
# 1. 拿到包：git clone 或解压到任意目录，比如 /path/to/dsh-chatops-mcp
# 2. 装进目标 profile（target 指向包目录，不要指向 node_modules 里的副本）
plugin_manager action=install_bundle target=/path/to/dsh-chatops-mcp
# 3. 重启 DeepSeek Harness（client.js 是浏览器模块代，必须重启才出现左侧栏图标）
```

装完左侧栏会多一个「钉钉/飞书连接器」（order 3），点开就是连接器卡片墙。

### 从 npm 装（推荐，已发布）

**已发布到 npmjs**：正式包名是 **`dsh-chatops-mcp`**（不带 scope，可直接搜短名）。别人一句话装：

```bash
plugin_manager action=install_bundle target=dsh-chatops-mcp
# 然后重启 DeepSeek Harness
```

或先看包在不在：

```bash
npm view dsh-chatops-mcp version      # 期望 1.6.1
```

> 早期还发过一个 scope 版本 `@xhzl/dsh-chatops-mcp@1.6.1`，内容与本包相同。**两个包只能装一个** —— 它们注册同一个面板 id（`chatops-mcp`）和同一组 serverName（`dingtalk` / `feishu` / `meego`），同时装会抢 slot 座位。换包前先 `plugin_manager action=remove_bundle`。**新包一律用无 scope 名发布**，scope 版只作为历史遗留保留。

### 本机开发时切回源码版

默认装 npm 版时，改这里源码不会生效。要边改边验，用 link 安装：

```bash
plugin_manager action=remove_bundle target=dsh-chatops-mcp
plugin_manager action=install_bundle target=D:\xhzl-scf\tools\dsh-chatops-mcp
# 重启 DeepSeek Harness（client.js 是浏览器模块代）
```

装完 `node_modules\dsh-chatops-mcp` 会变成指向源码目录的 junction，改 js 重装即生效。

### 自己发版（维护者）

本包已改名为 **`dsh-chatops-mcp`**（无 scope），直接在源码目录发布即可，不再需要同步出第二份：

```bash
cd /path/to/dsh-chatops-mcp
npm publish --registry=https://registry.npmjs.org/ --access public
```

`D:\xhzl-scf\tools\dsh-chatops-mcp-alias` 与 `D:\xhzl-scf\tools\sync-chatops-alias.mjs` 是改名前的产物，**现在不再需要**；留着只用于给老版本补发 scope 包。


### 自己发版（维护者）

```bash
cd /path/to/dsh-chatops-mcp
npm publish --registry=https://registry.npmjs.org/ --access public
```

发版有三处硬要求，别踩：

| 要求 | 说明 |
|---|---|
| 用**手工生成的 Granular Access Token** | web-login 自动写进 `~/.npmrc` 的 token 只读，`npm publish` 直接 403（`... granular access token with bypass 2fa enabled is required to publish packages`） |
| token 四项必须同时对 | 勾 `Bypass two-factor authentication (2FA)`、Packages 权限 `Read and write (publish and stage)`（**`stage only` 不行**，那只支持 `npm stage publish`）、`Select packages` 选 `All packages`、`Organizations` 权限选 `No access`（给了权限却一个组织都不选会报 `You must select at least one organization...`） |
| 首次发布可能只落占位版本 | 第一轮 stdout 形如 `????? -> 0.0.0-stage`，`dist-tags.latest` 会是 `0.0.0-stage`；**再跑一次 `npm publish`** 才把真实版本推上去。之后对占位版本执行 `npm deprecate dsh-chatops-mcp@0.0.0-stage "<说明>"` |

> `private` 已删，`license: MIT`、`repository` / `homepage` / `bugs` / `engines: node>=18` / `keywords` 都在 `package.json` 里；`publishConfig` 已设 `access: public` + `registry: https://registry.npmjs.org/`。

验证包是否真能装（**别用命令内 `cd`**，pwsh 里 `Set-Location` 常不生效，会在当前目录凭空生成 `package.json`）：

```bash
npm --prefix /tmp/probe install dsh-chatops-mcp --no-fund --no-audit
```

### 对方的机器上需要什么

| 依赖 | 必需性 | 装法 | 说明 |
|---|---|---|---|
| Node.js ≥ 18 | 必需 | 系统安装 | 插件用 `nodeCommand()` 从 `PATH` / `CHATOPS_NODE_BIN` 推真实 node，**不用**宿主进程的 `process.execPath` |
| `dws`（钉钉 CLI） | 用钉钉才需要 | 面板点「安装 CLI」→ 跑 `npm i -g dingtalk-workspace-cli` | 也可手工 `npm i -g dingtalk-workspace-cli` |
| `lark-cli`（飞书 CLI） | 用飞书才需要 | 面板点「安装 CLI」→ 跑 `npm i -g @larksuite/cli` | 也可手工 `npm i -g @larksuite/cli` |
| `@lark-project/mcp` | 用飞书项目才需要 | 面板填 token 后点连接，或手工 `npm i -g @lark-project/mcp` | 官方服务器；本包通过 `resolveGlobalFile()` 在全局前缀里找它 |
| 飞书项目 user token | 用飞书项目才需要 | 面板「飞书项目」卡片里粘贴 `m-...` | 只写对方自己的 `~/.dsh/chatops/meego/.env`，不进包 |

钉钉与飞书的登录态各自留在 `%USERPROFILE%\.dws` / `%USERPROFILE%\.lark-cli`，**不随包分发**，也不进 profile 配置 —— 面板的「连接」会走设备码授权让对方自己登。

### 分发时要交代的三件事

1. **要重启**：只装 bundle 不重启，`client.js` 不会加载（模块已在内存里驻留）。
2. **连接存在对方自己机器上**：`%USERPROFILE%\.dsh\chatops\connections.json`。这个文件**不要提交、不要发给别人** —— 里面的自定义连接 env 是明文。
3. **工具名固定**：`mcp__dingtalk__*` / `mcp__feishu__*` / `mcp__meego__*`，因为 `serverName` 是固定的，换机器也一样。

### 改本包之后

只改 `server.js` / `discovery.js` / `cli.js` / `connectors.js` / `index.js`（Host 侧）时，重装后新会话即生效。**改 `client.js`（浏览器侧）必须重启软件**。

```
plugin_manager action=remove_bundle target=dsh-chatops-mcp
plugin_manager action=install_bundle target=/path/to/dsh-chatops-mcp
```

若 `remove_bundle` 意外失败（pnpm 解析策略拦截时会留下半拆状态：`dsh.profile.bundles` 已删但 dependencies 与 junction 还在，`install_bundle` 会报 `already-installed`），用下面这条恢复：

```
plugin_manager action=set_bundle target=dsh-chatops-mcp enabled=true
```

## 凭据

| serverName | 变量 | 来源 |
|---|---|---|
| `dingtalk` | 无 | `dws auth login` 已存在 `%USERPROFILE%\.dws` |
| `feishu` | 无 | `lark-cli auth login` 已存在 `%USERPROFILE%\.lark-cli` |
| `meego` | `MCP_USER_TOKEN` | 飞书项目签发的 MCP user token |

飞书项目 token **不进 patch**。`meego-launch.js` 按下面顺序解析，找到后写进 `process.env` 再 import 官方服务器（它在模块加载期读 token）：

1. 环境变量 `MCP_USER_TOKEN`（或 `MEEGO_MCP_USER_TOKEN` / `MCP_TOKEN`）
2. `%USERPROFILE%\.dsh\chatops\meego\.env`（或 `CHATOPS_MEEGO_ENV_FILE` 指定的路径）
3. 当前工作目录下的 `.env`

凭据文件格式就是一行：

```
MCP_USER_TOKEN=m-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

换 token 只改这个文件，重开 dsh 即可，不碰 `cordis.patch.yml`，也不需要重新安装 bundle。

## 依赖与运行约束

- `server.js` / `discovery.js` / `cli.js` / `connectors.js` / `index.js` / `meego-launch.js` 只用 Node 内置模块，无 npm 依赖，Node 18+ 可跑；`client.js` 在浏览器里跑，React 从宿主 `require('react')` 取，不另装。
- 手写 JSON-RPC 2.0 over stdio，协议版本协商支持 `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07`。
- stdout 只输出 JSON-RPC 帧；诊断信息走 stderr，`CHATOPS_DEBUG=1` 打开。
- stdin 关闭不会被立即 exit，会等在途 CLI 请求跑完。
- MCP 客户端会清洗子进程环境（匹配 `KEY|PASSWORD|SECRET|TOKEN` 与 `DSH_*`），所以两个 CLI 靠用户目录里的登录态鉴权，不靠环境变量。
- 两个 CLI 直接 spawn **原生 exe**（`vendor\dws.exe` / `bin\lark-cli.exe`），不走 `bin\dws.js` / `scripts\run.js` 这两个 JS shim。原因是 shim 内部只是 `spawnSync` / `execFileSync` 包一层，**不带 `windowsHide`**，在无控制台的宿主里会弹出黑窗口；而 `CREATE_NO_WINDOW` 无法沿进程树继承。顺带更快：`dws schema --all --compact` 从约 6.0 s 降到 4.4 s，`lark-cli schema` 从约 13 s 降到 1.7 s。
- catalog 在后台预热；若预热晚于第一次 `tools/list`，服务端会发 `notifications/tools/list_changed` 让客户端重新同步（dsh 的 mcp-client 支持 `listChanged.tools.onChanged`）。

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHATOPS_TOOL_PRODUCTS` | `auto`（见下） | 要 materialise 的产品白名单：`auto` = 内置默认集，`none` = 只留元工具+手写工具，逗号列表 = 精确指定 |
| `CHATOPS_TOOL_EFFECT` | `all`（v1.6.1 起；1.6.0 及以前是 `read`） | `read` 只放只读工具；`all` / `any` 放全部（含写工具） |
| `CHATOPS_MAX_TOOLS` | `30` | 每条 surface 动态工具数量上限 |
| `CHATOPS_TOOL_PRIORITY` | 内置高频名词表 | 同一产品内的排序关键词（逗号分隔），越靠前越优先占名额 |
| `CHATOPS_CACHE_DIR` | `%USERPROFILE%\.dsh\chatops\cache` | schema 缓存目录 |
| `CHATOPS_CACHE_TTL_MS` | `28800000`（8 h） | 缓存有效期 |
| `CHATOPS_WARM_TIMEOUT_MS` | `30000` | `initialize` 等 catalog 的上限 |
| `CHATOPS_DWS_BIN` | `D:\nvm\node_global\node_modules\dingtalk-workspace-cli\vendor\dws.exe` | dws 原生 exe（找不到时回退 `bin\dws.js` shim） |
| `CHATOPS_LARK_BIN` | `D:\nvm\node_global\node_modules\@larksuite\cli\bin\lark-cli.exe` | lark-cli 原生 exe（找不到时回退 `scripts\run.js` shim） |
| `CHATOPS_CLI_TIMEOUT_MS` | `60000` | 单次 CLI 超时 |
| `CHATOPS_MEEGO_BIN` | 全局 `@lark-project/mcp/dist/index.js` | 官方服务器入口 |
| `CHATOPS_MEEGO_ENV_FILE` | `%USERPROFILE%\.dsh\chatops\meego\.env` | 凭据文件路径 |
| `CHATOPS_MEEGO_DOMAIN` | 官方默认 | 覆盖 `--domain` |
| `CHATOPS_CONNECTION_STORE` | `%USERPROFILE%\.dsh\chatops\connections.json` | 连接表（跨重启恢复用） |
| `CHATOPS_NODE_BIN` | PATH 里的 `node` | 写进 mcp-client 行 `command` 的 node 路径；不要让它落到 Electron 的 `DeepSeek Harness.exe` |
| `CHATOPS_DEBUG` | 未设 | `1` 时输出 exec 日志到 stderr |

内置默认产品集：钉钉 `contact calendar chat todo oa drive aisearch doc`，飞书 `im calendar task contact drive approval wiki docs`。

## 已知边界

- 1098 / 246 个命令不能全量展开成工具（约 40 万 token），所以未 materialise 的命令必须经 `*_catalog` 发现 + `*_schema` 查参 + `*_cli` 执行。
- `dws api`（raw OpenAPI）在 MCP 默认凭证下不可用，需自有 app 凭证；本包不包装它。
- `lark-cli schema` 的 246 条是 **raw API 面**，不含 `+` 快捷命令；`+` 命令（如 `im +messages-send`）只能经 `feishu_cli` 调用。部分 raw API 还需要额外 scope，会返回 `unauthorized: ... missing_scopes`。
- `feishu_drive_search` 的 `query` 上限 30 个字符，超出服务端报 `99992402`。
- `dingtalk_list_messages` 必带 `--time`（dws 的硬要求），不能只给时间区间。
- `lark-cli whoami` 不接受 `--format json`，本包只给 dws 追加该 flag。
- `search_by_mql` 的 `FROM` 必须用 project_key 或 simple_name，用显示名报 `project not found (Code: 3004)`。
- 官方 `@lark-project/mcp` 启动时会把 dotenv 的一行提示打到 stdout，MCP 客户端按行解析时会跳过非 JSON 行，不影响工具调用。
- 面板生成的 config 里显式写死 `CHATOPS_TOOL_PRODUCTS` / `CHATOPS_TOOL_EFFECT` / `CHATOPS_MAX_TOOLS` 三项，**不受宿主进程环境变量影响**。v1.6.1 起 `CHATOPS_TOOL_EFFECT` 默认 `all`（写工具启用）；要收紧成只读，改那一行 config 的 `env.CHATOPS_TOOL_EFFECT` 为 `read` 再重连。
- `installCli` 调的是 `npm install -g <pkg>`，会改本机全局 npm 前缀；不需要时用 `npm uninstall -g` 自行回退。装 CLI 有网络与磁盘副作用，面板会在按钮文案里写明包名。
- 连接表里 `chatops-conn-meego` 的 config 不含令牌（令牌只存 `%USERPROFILE%\.dsh\chatops\meego\.env`）。自定义连接如果自己在 `env` 里填了密钥，那串值会明文写进 `connections.json` —— 这个文件在用户目录下、权限继承用户，别提交进 git。
- 贴 JSON 建连只做语法校验，**不验证连通性**：URL 打不通、包名不存在也会建行成功，表现为该行 `toolCount` 恒为 0。要判断是否真连上，看面板卡片上的工具数。
