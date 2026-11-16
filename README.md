# dsh-chatops-mcp

DSH 的 **MCP 服务管理面板 + MCP Hub**：统一管理任意 MCP 服务，并把**钉钉**、**飞书**、**飞书项目（Meego）**接成三个开箱可用的工具服务器。

- npm：`dsh-chatops-mcp`
- 源码 / issue：https://github.com/li-shaozhe/dsh-chatops-mcp

| MCP serverName | 工具前缀 | 实现方式 | 凭据来源 |
|---|---|---|---|
| `dingtalk` | `mcp__dingtalk__*` | 本包 `server.js dingtalk`，包装 `dws` CLI | `%USERPROFILE%\.dws` 已有登录 |
| `feishu` | `mcp__feishu__*` | 本包 `server.js feishu`，包装 `lark-cli` | `%USERPROFILE%\.lark-cli` 已有登录 |
| `meego` | `mcp__meego__*` | **官方** `@lark-project/mcp`（48 工具），经 `meego-launch.js` 注入 token | `%USERPROFILE%\.dsh\chatops\meego\.env` |

钉钉和飞书复用本机已有 CLI 登录态，零新增应用密钥；飞书项目直接用官方服务器，不自己实现 Open API。这三条只是内置项，面板本身与它们无关：任何 `mcp-client` 行都能在同一张列表里管理和启停，Hub 里还有 21 个可安装模板（文件系统、Git、GitHub、数据库、浏览器、Notion、Slack…）。

装完左侧栏会多一个「MCP 服务管理」（order 3），点开是统一服务列表 —— 每行可展开看工具名、可开关、可删除，`+ 添加 MCP` 支持贴 `mcpServers` JSON 或手填表单。见 [安装](#安装) 与 [面板](#面板)。

## 工具面跟着 CLI 升级走

钉钉 / 飞书两条 surface 的工具清单不写死在代码里，而是**读 CLI 自己的 schema**生成：

| CLI | 自描述命令 | 规模 | 冷启动耗时 |
|---|---|---|---|
| `dws` | `dws schema --all --compact --format json` | 27 个产品 / **1098** 个命令 | ~4.4 s |
| `lark-cli` | `lark-cli schema` | 15 个 service / **246** 个命令 | ~1.7 s |

1300+ 个工具全量展开约需 40 万 token 的工具定义，不现实。所以每条 surface 恒定暴露三个元工具，其余按需 materialise：

| 元工具 | 作用 |
|---|---|
| `dingtalk_catalog` / `feishu_catalog` | 一次调用列出 CLI **当前**支持的所有命令（可按 product / query / effect 过滤）。CLI 升级后新命令立刻出现在这里。 |
| `dingtalk_schema` / `feishu_schema` | 查单个命令的完整 flag 列表、类型、是否必填 |
| `dingtalk_cli` / `feishu_cli` | 逃生舱：`{"argv": ["..."]}` 原样跑任意子命令 |

在此之上，符合「产品白名单 × effect 过滤 × 数量上限」的命令会各自变成一个独立工具（工具名由 CLI 路径规范化而来，如 `contact user get-self` → `contact_user_get-self`）。内置连接器默认 `CHATOPS_TOOL_EFFECT=all`，**读写工具都会出现**；想收紧成只读就把该项改成 `read`。

名额不是按名字母序截断，而是**先按产品轮转**（每个产品一轮各取一个），保证白名单里每个产品都有工具可用；同一产品内部先按语义优先级（`CHATOPS_TOOL_PRIORITY`，默认「消息 / 事件 / 待办 / 任务 / 审批 / 文档 / 文件 / 节点 / 空间 / 工作项 / 日历 / 用户 / 群 / 搜索」这类高频名词），再按命令路径长短排序。`+快捷命令` 与对应 raw API 只差 `-`/`_` 的会去重，避免一个能力占两份名额。

`effect` 按白名单判定：只有 CLI 明确标 `read` 的才算只读，其余（含 dws 的 `destructive`、飞书的 `high-risk-write`）一律归为写；`destructive` 的高危命令在 `*_catalog` 与 `*_schema` 结果里会带 `"destructive": true`。

schema 结果缓存在 `%USERPROFILE%\.dsh\chatops\cache\<surface>.json`（默认 8 小时），只有首次启动慢；缓存过期后重新扫一遍，失败时回退旧缓存并在 catalog 里标注。

## 为什么这样包

**飞书项目用官方服务器**：`@lark-project/mcp`（`meego-mcp-cli`）是本地 stdio ↔ 远端的纯代理 —— 连 `https://project.feishu.cn/mcp_server/v1`，header 带 `X-Mcp-Token: <user_token>` 与 `X-Meego-MCP-Connection-Type: stdio`，只代理 `tools/list` 与 `tools/call`。48 个工具覆盖工作项增删改查、字段/视图/模板/角色配置、WBS 草稿、节点流转、MQL 搜索、评论、工时、附件上传，不需要 `plugin_id` / `plugin_secret`。

**钉钉 / 飞书自己包一层**：npm 上的现成包要么只覆盖其中一家且要另配 appId/appSecret（`@larksuiteoapi/lark-mcp`、`dsh-feishu-mcp`），要么是 IM 频道/bot 桥而不是工具面（`@dingtalk-real-ai/dsh-dingtalk`、`dsh-connect-dingtalk`、`@xmanrui/dsh-im`），要么只推群机器人 webhook（`dsh-dingtalk`）。而 `dws` 与 `lark-cli` 已登录且能自动续期，包一层 CLI 反而零凭据、随 CLI 升级自动获得新能力。

## 手写工具（恒在，不依赖 catalog）

功能固定的高频操作保留手写封装，参数名更友好、少一层 schema 查询。

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

## 连接器

面板第一个页签是「连接器」—— 卡片墙 + 一键连接，不需要手改 `cordis.patch.yml`。

### 一键连接做了什么

点卡片上的 `+` → 按状态提示走完三步，最后写一行 MCP 配置：

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

`ctx.loader.create/remove` 只改 Loader 自己的根树，而 `Loader.write()` 是空实现 —— 写完 profile 的 `cordis.yml` 仍是 `[]`。光靠 `ctx.loader`，连接一重启就没了。

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
- **恢复时机**：插件 `apply(ctx)` 里第一件事是 `rehydrate(loader)` —— 行还在就只恢复 `disabled` 位，行没了就用存下的 config 重新 `create`。
- **启停位要再压一遍**：dsh 在 `app-boot/config-reload` 时会把 patch 重新应用到 include 上，那一轮会用 patch 里的 options 覆盖整份 config，`disabled` 回到默认值。所以插件还挂了 `ctx.on('app-boot/config-reload', …)` → `applyStoredFlags(loader)`：只对**已存在**的行按 store 压 `disabled`，绝不 create，单行失败吞掉等下次 reload 重试。
- **只管自己的行**：内置三条 + `chatops-custom-*`，别人插的 mcp-client 行一律不碰。
- 恢复结果在 `GET /chatops-mcp/connectors` 的 `rehydrate` 字段里可见（`restored` / `resumed` / `failed` / `repaired`）。

### 卡片上能看到什么

- 徽标（钉 / 飞 / 项）、名称、两行摘要。
- 右上角 `+`（未连接）或绿色 `·`（已连接）。
- 底部 chip：`CLI 已装` / `需装 CLI` / `需令牌`、`N 个工具`（来自 `tools.schemas()` 里 `mcp__<server>__*` 的实际注册数）、`已停用`。
- 顶部汇总：`已连接 N` / `注册工具 N` / `MCP 行 N`；超过 80 个工具时出现黄色告警条（工具过多会拉低回复质量）。

### 自定义连接

右上「+ 添加 MCP」默认是**整段贴 JSON**，直接粘 `mcpServers` 壳就能一次建多条，和 workbuddy / claude 的 `mcp.json` 同形：

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

### serverName 冲突与写工具

- 内置三条固定用 `dingtalk` / `feishu` / `meego`。若 profile 里已有别的行占了这些名字，连接会在写入前报错，不会把 dsh 搞成启动失败。
- 内置连接器生成的 config 显式写 `CHATOPS_TOOL_EFFECT=all`，**写工具默认可用**。只想暴露只读工具时，把那一行的 env 改成 `read` 再重连。

## 面板

除了当 MCP 连接器，本包还带一个面板，三个入口共用同一份组件：

| 入口 | 座位 | 说明 |
|---|---|---|
| 左侧栏图标 | `sidebar.panellist`，`id=chatops-mcp`，`order=3` | 排在「插件」「插件市场」「记忆与人设」之后，标签 `MCP 服务管理` |
| 主区域页面 | `main`，`key=chatops-mcp` | 点图标切过来 |
| 设置页 | `settings.section`，`id=chatops-mcp`，`order=45` | 不占侧栏座位也能进 |

定位是**通用 MCP 服务管理面板 + MCP Hub**，不再只服务钉钉 / 飞书 / 飞书项目。

五个页签：

| 页签 | 内容 |
|---|---|
| 我的 MCP | 统一服务列表：每条 `mcp-client` 行一行（内置三条、面板添加的、别处写进 Loader 的都算），左箭头展开工具名清单，右侧开关 + 删除；底部「可一键连接」放还没连的内置连接器 |
| MCP Hub | 预置模板目录，按分类分组（文件与代码 / 搜索与抓取 / 数据与存储 / 浏览器与自动化 / 办公与协作 / 分析工具），选中即把 command / args / url / 凭据字段填进「添加 MCP」弹层 |
| 概览 | 三条内置连接各一张卡：CLI 路径与版本、登录身份、组织/部门/邮箱、catalog 条数、已 materialise 数量与产品配比；飞书项目额外显示 server 入口、token 来源文件、脱敏 token 提示 |
| CLI 目录 | 直接浏览 `dws` / `lark-cli` 的完整 self-schema（1098 / 246 条），支持 surface 切换、关键词、product、effect 过滤；点任意行展开该命令的完整 flag 列表 |
| 工具预览 | 输入 products / effect / max，预览「按当前配置会 materialise 出哪些工具」，改参数不用重装就能看效果 |

### 服务列表里的三个 origin

| origin | 含义 | 启停 | 删除 |
|---|---|---|---|
| `builtin` | 钉钉 / 飞书 / 飞书项目，由本包 `seedBuiltins` provision | 落盘 | 落盘（留 `removed` 标记，重启不会自动长回来） |
| `custom` | 面板里加的（含 Hub 安装的） | 落盘 | 落盘 |
| `external` | 别的插件或手写 patch 建的 `mcp-client` 行 | 只作用于本次进程，不落盘 | **不允许**（删了重启就回来，还会和拥有者冲突） |

外部行只读可见是刻意的：它们是真实在跑的连接，隐瞒反而让人去别处瞎找。

### node 版本：连接绿灯但工具数是 0 时先看这里

MCP 子进程用 `nodeCommand()` 选出的 node 启动。它不会盲取 PATH 里的 `node`：

1. `CHATOPS_NODE_BIN` 显式覆盖
2. 非 Electron 时用宿主自己的 `process.execPath`
3. PATH 里的 `node`，**先探版本，>= 18 才用**
4. nvm / 常见安装目录里版本够的 node
5. 都没有就退回 PATH 那个（报错会显示在面板上）

为什么卡 18：`server.js` 是 ESM 且用 `import.meta.url` 推包内路径，Node 14 的默认加载器直接 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，子进程起来就崩 —— 面板上表现为「连接是绿的、工具数永远是 0」。实测本机 PATH 上就是 Node 14，改之前三条连接工具数全是 0，改之后 47 / 45 / 48。

面板会把选中的 node 与版本印在列表上方；不达标时直接弹红条，并显示 PATH 上那个 node 的版本。

视觉与交互对齐宿主自带面板：

- hero 头、分段页签、双栏卡片；左栏宽度 `clamp(240px, 32%, 380px)`，目录行选中时左侧 2.5px 品牌色竖条。
- 搜索输入 180ms 防抖；目录行可键盘聚焦（`role=button` + `Enter`/`Space`）。
- 静态样式（hover / transition / focus）走 `ctx.effect` 注入一张 `<style>`（`data-plugin-css='dsh-chatops-mcp/panel.css'`），动态值仍内联；主题 token 全部取 `@deepseek-ai/dsh-client-ui-theme` 实际定义的那套，不自造色值。

概览 / CLI 目录 / 工具预览三个页签只读：不发消息、不改日程、不写任何远程状态。我的 MCP / MCP Hub 页签会写本机 MCP 配置与 CLI 登录态，但不调用任何业务写接口。数据来自同进程内的 Host 路由：

| 路由 | 说明 |
|---|---|
| `GET /chatops-mcp/connectors` | 统一服务列表（`services`）+ 内置连接器状态 + 自定义连接 + 工具计数 + node 体检 |
| `GET /chatops-mcp/hub` | MCP Hub 模板目录（每项含可直接提交的 `install` 载荷） |
| `POST /chatops-mcp/services/toggle` | 任意行启停（body `{"entryId":"...","enabled":false}`）；外部行 `persisted:false` |
| `POST /chatops-mcp/services/remove` | 删除本包拥有的行；外部行返回 `reason:"external"` |
| `POST /chatops-mcp/services/install-hub` | 按 Hub 模板建连接（body `{"id":"filesystem","overrides":{...}}`） |
| `POST /chatops-mcp/connectors/connect` | 写一行 mcp-client（body `{"id":"dingtalk"}`） |
| `POST /chatops-mcp/connectors/disconnect` | 删掉那一行 |
| `POST /chatops-mcp/connectors/toggle` | 启用 / 停用（body `{"id":"dingtalk","enabled":false}`） |
| `POST /chatops-mcp/connectors/install` | 全局 npm 安装 CLI |
| `POST /chatops-mcp/connectors/login` | 开始设备码登录，返回验证链接与授权码 |
| `POST /chatops-mcp/connectors/login/finish` | 复查 / 用 `deviceCode` 完成登录 |
| `POST /chatops-mcp/connectors/logout` | 退出 CLI 登录 |
| `POST /chatops-mcp/connectors/token` | 写入飞书项目 MCP 用户令牌（已连接时会重推 config） |
| `POST /chatops-mcp/custom` | 建自定义连接（逐字段表单） |
| `POST /chatops-mcp/custom/json` | 贴 `mcpServers` JSON 批量建连接（body `{"json":"{...}"}`） |
| `POST /chatops-mcp/custom/remove` \| `/custom/toggle` | 删除 / 启停自定义连接 |
| `GET /chatops-mcp/state` | 三条 surface 的完整状态（含 health、catalog 大小、materialised 配比） |
| `GET /chatops-mcp/health?force=1` | 强制重探登录态（默认缓存 2 分钟） |
| `GET /chatops-mcp/catalog?surface=&query=&product=&effect=&limit=&refresh=` | 查 catalog |
| `GET /chatops-mcp/schema?surface=&command=` | 单命令的参数详情 |
| `GET /chatops-mcp/tools?surface=&products=&effect=&max=` | 预览动态工具名单 |
| `POST /chatops-mcp/refresh` | 忽略缓存重读 CLI schema（body `{"surface":"dingtalk"}`） |

### 自检脚本

三个都不依赖 dsh 启动，改完面板先跑它们：

```bash
cd tools/dsh-chatops-mcp
CHATOPS_CONNECTION_STORE=$TEMP/chatops-test-store.json node test-host.mjs   # 路由：/hub、services 增删改、安装、贴 JSON
node test-hub.mjs                                                            # Hub 模板能否过 buildCustomConfig
node test-render.mjs                                                         # 面板能否渲染 + co-* 类名是否都有定义
node test-visual.mjs  # 生成 output/panel-*.html，再用 chrome --headless 截图
```

`test-host.mjs` 必须把这台机器的真实连接表指开（`CHATOPS_CONNECTION_STORE`），否则会写坏 `~/.dsh/chatops/connections.json`。

面板作为 Host 插件 inject 了 `webServer` / `loader` / `tools` 三个服务；`loader` 拿不到时连接器会明确报「宿主没有提供 loader 服务」，不会静默失败。

## 安装

包内**没有任何本机绝对路径**，也没有预置的 mcp-client 行，换机器、换用户名、换 Node 安装位置都能直接用。三条连接由插件自己在上电时 provision（`connectors.js` 的 `seedBuiltins`）：CLI 已装且已登录才自动建行，否则跳过、等用户在面板点 `+`。

### 从 npm 装（推荐）

```bash
plugin_manager action=install_bundle target=dsh-chatops-mcp
# 然后重启 DeepSeek Harness
```

### 从源码装

```bash
git clone https://github.com/li-shaozhe/dsh-chatops-mcp.git
plugin_manager action=install_bundle target=/path/to/dsh-chatops-mcp
# 然后重启 DeepSeek Harness（client.js 是浏览器模块代，必须重启才出现左侧栏图标）
```

改源码时用 link 安装，改 js 重装即生效：

```bash
plugin_manager action=remove_bundle target=dsh-chatops-mcp
plugin_manager action=install_bundle target=/path/to/dsh-chatops-mcp
```

装完 `node_modules/dsh-chatops-mcp` 会变成指向源码目录的 junction。

只改 `server.js` / `discovery.js` / `cli.js` / `connectors.js` / `index.js`（Host 侧）时，重装后新会话即生效。**改 `client.js`（浏览器侧）必须重启软件**。

若 `remove_bundle` 意外失败（pnpm 解析策略拦截时会留下半拆状态：`dsh.profile.bundles` 已删但 dependencies 与 junction 还在，`install_bundle` 会报 `already-installed`），用下面这条恢复：

```bash
plugin_manager action=set_bundle target=dsh-chatops-mcp enabled=true
```

### 对方的机器上需要什么

| 依赖 | 必需性 | 装法 | 说明 |
|---|---|---|---|
| Node.js ≥ 18 | 必需 | 系统安装 | 插件用 `nodeCommand()` 从 `PATH` / `CHATOPS_NODE_BIN` 推真实 node，**不用**宿主进程的 `process.execPath` |
| `dws`（钉钉 CLI） | 用钉钉才需要 | 面板点「安装 CLI」→ 跑 `npm i -g dingtalk-workspace-cli` | 也可手工装 |
| `lark-cli`（飞书 CLI） | 用飞书才需要 | 面板点「安装 CLI」→ 跑 `npm i -g @larksuite/cli` | 也可手工装 |
| `@lark-project/mcp` | 用飞书项目才需要 | 面板填 token 后点连接，或手工 `npm i -g @lark-project/mcp` | 官方服务器；本包通过 `resolveGlobalFile()` 在全局前缀里找它 |
| 飞书项目 user token | 用飞书项目才需要 | 面板「飞书项目」卡片里粘贴 `m-...` | 只写对方自己的 `~/.dsh/chatops/meego/.env`，不进包 |

钉钉与飞书的登录态各自留在 `%USERPROFILE%\.dws` / `%USERPROFILE%\.lark-cli`，**不随包分发**，也不进 profile 配置 —— 面板的「连接」会走设备码授权让对方自己登。

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

## 发版（维护者）

```bash
npm publish --registry=https://registry.npmjs.org/ --access public
```

三处硬要求，别踩：

| 要求 | 说明 |
|---|---|
| 用**手工生成的 Granular Access Token** | web-login 自动写进 `~/.npmrc` 的 token 只读，`npm publish` 直接 403（`... granular access token with bypass 2fa enabled is required to publish packages`） |
| token 四项必须同时对 | 勾 `Bypass two-factor authentication (2FA)`、Packages 权限 `Read and write (publish and stage)`（**`stage only` 不行**，那只支持 `npm stage publish`）、`Select packages` 选 `All packages`、`Organizations` 权限选 `No access`（给了权限却一个组织都不选会报 `You must select at least one organization...`） |
| 首次发布可能只落占位版本 | 第一轮 stdout 形如 `????? -> 0.0.0-stage`，`dist-tags.latest` 会是 `0.0.0-stage`；**再跑一次 `npm publish`** 才把真实版本推上去。之后对占位版本执行 `npm deprecate <pkg>@0.0.0-stage "<说明>"` |

`private` 已删，`license: MIT`、`repository` / `homepage` / `bugs` / `engines: node>=18` / `keywords` 都在 `package.json` 里；`publishConfig` 已设 `access: public` + `registry: https://registry.npmjs.org/`。

`npm view` 有缓存延迟，核版本直接取 packument：

```bash
node -e "fetch('https://registry.npmjs.org/dsh-chatops-mcp').then(r=>r.json()).then(j=>console.log(j['dist-tags']))"
```

验证包是否真能装（**别用命令内 `cd`**，pwsh 里 `Set-Location` 常不生效，会在当前目录凭空生成 `package.json`）：

```bash
npm --prefix /tmp/probe install dsh-chatops-mcp --no-fund --no-audit
```

## 依赖与运行约束

- `server.js` / `discovery.js` / `cli.js` / `connectors.js` / `index.js` / `meego-launch.js` 只用 Node 内置模块，无 npm 依赖，Node 18+ 可跑；`client.js` 在浏览器里跑，React 从宿主 `require('react')` 取，不另装。
- 手写 JSON-RPC 2.0 over stdio，协议版本协商支持 `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` / `2024-10-07`。
- stdout 只输出 JSON-RPC 帧；诊断信息走 stderr，`CHATOPS_DEBUG=1` 打开。
- stdin 关闭不会被立即 exit，会等在途 CLI 请求跑完。
- MCP 客户端会清洗子进程环境（匹配 `KEY|PASSWORD|SECRET|TOKEN` 与 `DSH_*`），所以两个 CLI 靠用户目录里的登录态鉴权，不靠环境变量。
- 两个 CLI 直接 spawn **原生 exe**（`vendor\dws.exe` / `bin\lark-cli.exe`），不走 `bin\dws.js` / `scripts\run.js` 这两个 JS shim。原因是 shim 内部只是 `spawnSync` / `execFileSync` 包一层，**不带 `windowsHide`**，在无控制台的宿主里会弹黑窗口；而 `CREATE_NO_WINDOW` 无法沿进程树继承。顺带更快。
- catalog 在后台预热；若预热晚于第一次 `tools/list`，服务端会发 `notifications/tools/list_changed` 让客户端重新同步。

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CHATOPS_TOOL_PRODUCTS` | `auto`（见下） | 要 materialise 的产品白名单：`auto` = 内置默认集，`none` = 只留元工具+手写工具，逗号列表 = 精确指定 |
| `CHATOPS_TOOL_EFFECT` | `all` | `read` 只放只读工具；`all` / `any` 放全部（含写工具） |
| `CHATOPS_MAX_TOOLS` | `30` | 每条 surface 动态工具数量上限 |
| `CHATOPS_TOOL_PRIORITY` | 内置高频名词表 | 同一产品内的排序关键词（逗号分隔），越靠前越优先占名额 |
| `CHATOPS_CACHE_DIR` | `%USERPROFILE%\.dsh\chatops\cache` | schema 缓存目录 |
| `CHATOPS_CACHE_TTL_MS` | `28800000`（8 h） | 缓存有效期 |
| `CHATOPS_WARM_TIMEOUT_MS` | `30000` | `initialize` 等 catalog 的上限 |
| `CHATOPS_DWS_BIN` | 自动在全局前缀找 `vendor\dws.exe` | 覆盖 dws 路径（找不到时回退 `bin\dws.js` shim） |
| `CHATOPS_LARK_BIN` | 自动在全局前缀找 `bin\lark-cli.exe` | 覆盖 lark-cli 路径（找不到时回退 `scripts\run.js` shim） |
| `CHATOPS_NODE_BIN` | 按版本探测自动选（≥ 18） | 覆盖启动 MCP 子进程的 node。PATH 上是老版本 node 时用它指到 18+ |
| `CHATOPS_CONNECTION_STORE` | `%USERPROFILE%\.dsh\chatops\connections.json` | 连接表位置。自检脚本必须指到临时文件，否则会写坏真实连接表 |
| `CHATOPS_CLI_TIMEOUT_MS` | `60000` | 单次 CLI 超时 |
| `CHATOPS_MEEGO_BIN` | 全局 `@lark-project/mcp/dist/index.js` | 官方服务器入口 |
| `CHATOPS_MEEGO_ENV_FILE` | `%USERPROFILE%\.dsh\chatops\meego\.env` | 凭据文件路径 |
| `CHATOPS_MEEGO_DOMAIN` | 官方默认 | 覆盖 `--domain` |
| `CHATOPS_CONNECTION_STORE` | `%USERPROFILE%\.dsh\chatops\connections.json` | 连接表（跨重启恢复用） |
| `CHATOPS_NODE_BIN` | 按版本探测自动选（≥ 18） | 写进 mcp-client 行 `command` 的 node 路径；不要让它落到 Electron 的 `DeepSeek Harness.exe`，也不要让它落到 < 18 的 node |
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
- 面板生成的 config 里显式写死 `CHATOPS_TOOL_PRODUCTS` / `CHATOPS_TOOL_EFFECT` / `CHATOPS_MAX_TOOLS` 三项，**不受宿主进程环境变量影响**。要收紧成只读，改那一行 config 的 `env.CHATOPS_TOOL_EFFECT` 为 `read` 再重连。
- `installCli` 调的是 `npm install -g <pkg>`，会改本机全局 npm 前缀；不需要时用 `npm uninstall -g` 自行回退。装 CLI 有网络与磁盘副作用，面板会在按钮文案里写明包名。
- 连接表里 `chatops-conn-meego` 的 config 不含令牌（令牌只存 `%USERPROFILE%\.dsh\chatops\meego\.env`）。自定义连接如果自己在 `env` 里填了密钥，那串值会明文写进 `connections.json` —— 这个文件在用户目录下、权限继承用户，别提交进 git。
- 贴 JSON 建连只做语法校验，**不验证连通性**：URL 打不通、包名不存在也会建行成功，表现为该行 `toolCount` 恒为 0。要判断是否真连上，看面板卡片上的工具数。
- 面板里服务行的工具数来自宿主 `tools.schemas()`（全局作用域视角）。MCP 工具若注册在具体会话作用域，这里可能读到 0 而连接其实正常，所以 0 显示成「工具数不可见」而不是报警。真正的失败先看 node 体检红条。
- MCP Hub 是**可安装模板**，不是「已核实的官方服务」清单：每个模板的 command / args / URL 只描述怎么起进程或连地址，`probeStatus` 之类一律不声明。带路径示例的模板（`D:/path/to/workspace`）要用户自己改，否则服务起来也只会指向一个不存在的目录。
