/**
 * 视觉预览：用同一份 client.js + 同一套 PANEL_CSS 渲染成静态 HTML，再交给
 * headless Chrome 截图。目的是把「改完长什么样」变成可以看的证据，而不是靠读代码猜。
 *
 * 与真实运行环境的差异（看预览时要知道）：
 *   - 这里用自己的 h()→HTML 序列化代替 React DOM，交互状态全部是初始态。
 *   - 主题 token（--dsw-alias-*）在预览 HTML 里用一组浅色值兜底；
 *     真实宿主由 @deepseek-ai/dsh-client-ui-theme 提供，取值可能略有差异。
 *
 * 跑法：
 *   node tools/dsh-chatops-mcp/test-visual.mjs
 *   然后 chrome --headless --screenshot=... output/panel-preview.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, 'client.js'), 'utf8')

/* ── 最小 React ─────────────────────────────────────────────────── */

const instances = new Map()
let currentKey = null
let currentCursor = 0
let pendingEffects = []
let renderSerial = 0

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const inst = instances.get(currentKey)
    const index = currentCursor++
    if (inst.states.length <= index) {
      // 预览页要能从非初始态开始（第二个页签、已经打开弹层）。按组件名预设，
      // 不依赖 key 里的序号 —— 那个序号随渲染次数变，写死就失效。
      const name = String(currentKey).split('#')[0]
      const preset = globalThis.__presetStates?.[name]
      inst.states[index] =
        preset && Object.prototype.hasOwnProperty.call(preset, index)
          ? preset[index]
          : typeof initial === 'function'
            ? initial()
            : initial
    }
    return [inst.states[index], (next) => (inst.states[index] = typeof next === 'function' ? next(inst.states[index]) : next)]
  },
  useEffect(fn, deps) {
    const inst = instances.get(currentKey)
    const index = currentCursor++
    const signature = deps === undefined ? null : JSON.stringify(deps)
    const previous = inst.effects[index]
    if (previous === undefined) {
      inst.effects[index] = { fn, signature }
      pendingEffects.push(fn)
      return
    }
    if (previous.signature === signature) {
      previous.fn = fn
      return
    }
    inst.effects[index] = { fn, signature }
    pendingEffects.push(fn)
  },
  useRef(initial) {
    const inst = instances.get(currentKey)
    const index = currentCursor++
    if (!(index in inst.refs)) inst.refs[index] = { current: initial }
    return inst.refs[index]
  },
  useCallback(fn, deps) {
    const inst = instances.get(currentKey)
    const index = currentCursor++
    if (!(index in inst.refs)) inst.refs[index] = { fn }
    return inst.refs[index].fn
  },
}

/* ── h() → HTML ─────────────────────────────────────────────────── */

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link'])
const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function styleText(style) {
  return Object.entries(style || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${value}`)
    .join(';')
}

function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  const { type, props } = node
  if (typeof type === 'function') {
    const key = `${type.name || 'anon'}#${renderSerial++}`
    if (!instances.has(key)) instances.set(key, { states: [], effects: [], refs: {} })
    const previousKey = currentKey
    const previousCursor = currentCursor
    currentKey = key
    currentCursor = 0
    try {
      return toHtml(type(props || {}))
    } finally {
      currentKey = previousKey
      currentCursor = previousCursor
    }
  }
  if (type === React.Fragment) return toHtml(props.children)
  const attrs = []
  for (const [name, value] of Object.entries(props)) {
    if (name === 'children' || value === undefined || value === null || value === false) continue
    // textarea 的 value 已由下面的内容分支输出，别再当属性写一遍（会渲染成多余的空属性）。
    if (name === 'value' && type === 'textarea') continue
    if (name === 'style') {
      const text = styleText(value)
      if (text) attrs.push(`style="${escapeHtml(text)}"`)
      continue
    }
    if (name === 'className') {
      attrs.push(`class="${escapeHtml(value)}"`)
      continue
    }
    if (typeof value === 'function') continue
    if (value === true) {
      attrs.push(name)
      continue
    }
    attrs.push(`${name}="${escapeHtml(value)}"`)
  }
  const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID_TAGS.has(type)) return open
  // textarea 的内容来自 value 属性（HTML 里没有 value，React 走的是 property）。
  // 不特殊处理的话预览里 textarea 永远是空的，等于看不出参数有没有填进去。
  if (type === 'textarea') {
    return `${open}${escapeHtml(props.value ?? '')}</textarea>`
  }
  return `${open}${toHtml(props.children)}</${type}>`
}

async function renderHtml(renderer) {
  pendingEffects = []
  renderSerial = 0
  // 每次新渲染都清掉实例表，让 __presetStates 决定初值而不是沿用上一张图的状态。
  instances.clear()
  let html = toHtml(renderer())
  for (let pass = 0; pass < 3; pass += 1) {
    const batch = pendingEffects
    pendingEffects = []
    if (batch.length === 0) break
    for (const effect of batch) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    renderSerial = 0
    html = toHtml(renderer())
  }
  return html
}

/* ── 加载插件 ───────────────────────────────────────────────────── */

let capturedFactory = null
globalThis.window = { __ModuleLoader__: { load: ({ factory }) => (capturedFactory = factory) } }
let injectedCss = ''
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (tag) => (injectedCss = tag.textContent) },
}
new Function(source)()

const registered = []
const module = capturedFactory((name) => {
  if (name === 'react') return React
  throw new Error(`未知依赖：${name}`)
})
module.apply({
  effect: (fn) => {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
  slots: {
    inject(name, generator) {
      for (const entry of generator()) registered.push({ name, entry })
    },
    register: (meta, component) => ({ meta, component }),
  },
})

/* ── 假数据（与真实接口同形） ───────────────────────────────────── */

const tools = (server, names) => names.map((raw) => ({ name: `mcp__${server}__${raw}`, rawName: raw, description: `${raw} 描述` }))

const APIPOST_TOOLS = ['create_project', 'create_target', 'delete_targets', 'get_env_details', 'get_global_param_details', 'get_project_tree', 'get_target_detail', 'import_swagger', 'search_model', 'search_target']

const CONNECTORS = {
  services: [
    { entryId: 'chatops-conn-dingtalk', serverName: 'dingtalk', icon: 'dingtalk', origin: 'builtin', transport: 'stdio', target: 'D:\\nodejs\\node.exe server.js dingtalk', disabled: false, connected: true, toolCount: 30, tools: tools('dingtalk', ['contact_user_get', 'chat_send', 'todo_create', 'calendar_events', 'drive_list']), name: '钉钉', badge: '钉', badgeColor: '#1677ff', summary: '钉钉全产品能力', kind: 'cli' },
    { entryId: 'chatops-conn-feishu', serverName: 'feishu', icon: 'feishu', origin: 'builtin', transport: 'stdio', target: 'D:\\nodejs\\node.exe server.js feishu', disabled: false, connected: true, toolCount: 30, tools: tools('feishu', ['im_send', 'doc_fetch', 'calendar_agenda']), name: '飞书', badge: '飞', badgeColor: '#3370ff', summary: '飞书全产品能力', kind: 'cli' },
    { entryId: 'chatops-conn-meego', serverName: 'meego', icon: 'feishu-project', origin: 'builtin', transport: 'stdio', target: 'D:\\nodejs\\node.exe meego-launch.js', disabled: false, connected: true, toolCount: 48, tools: tools('meego', ['workitem_search', 'workitem_create', 'comment_list']), name: '飞书项目', badge: '项', badgeColor: '#00b96b', summary: '飞书项目官方 MCP', kind: 'token' },
    { entryId: 'chatops-custom-feishuprojectmcp', serverName: 'FeishuProjectMcp', icon: 'feishu-project', origin: 'custom', transport: 'stdio', target: 'npx -y @lark-project/mcp --domain https://project.feishu.cn', disabled: false, connected: true, toolCount: 48, tools: tools('FeishuProjectMcp', ['workitem_search', 'workitem_create']), name: 'FeishuProjectMcp', badge: 'FP', badgeColor: '#475569', summary: '本机 MCP 连接' },
    { entryId: 'chatops-custom-lighthouseops', serverName: 'lighthouse-ops', origin: 'custom', transport: 'streamable-http', target: 'https://example.com/workbuddy/mcp', disabled: false, connected: true, toolCount: 60, tools: tools('lighthouseops', ['ops_query', 'ops_alert']), name: 'lighthouse-ops', badge: 'LI', badgeColor: '#475569', summary: 'https://example.com/workbuddy/mcp' },
    { entryId: 'chatops-custom-apipostmcp', serverName: 'apipostMcp', icon: null, origin: 'custom', transport: 'stdio', target: 'npx -y mcp-remote https://open.apipost.net/mcp --header api-token:eyJhbGciOi...', disabled: false, connected: true, toolCount: 10, tools: tools('apipostMcp', APIPOST_TOOLS), name: 'apipostMcp', badge: 'AP', badgeColor: '#475569', summary: '本机 MCP 连接' },
    { entryId: 'chatops-custom-dgate', serverName: 'dgate', icon: null, origin: 'custom', transport: 'stdio', target: 'node gateway.js', disabled: true, connected: true, toolCount: 16, tools: tools('dgate', ['route_query']), name: 'dgate', badge: 'DG', badgeColor: '#475569', summary: '本机 MCP 连接' },
    { entryId: 'chatops-custom-miora', serverName: 'miora', icon: null, origin: 'custom', transport: 'stdio', target: 'node miora.js', disabled: false, connected: true, toolCount: 8, tools: tools('miora', ['task_run']), name: 'miora', badge: 'MI', badgeColor: '#475569', summary: '来自插件 mcp-miora' },
  ],
  builtins: [
    { id: 'dingtalk', name: '钉钉', serverName: 'dingtalk', connected: true, enabled: true, toolCount: 30, kind: 'cli', cli: { installed: true, bin: 'dws' }, ready: true, summary: '钉钉', badge: '钉', badgeColor: '#1677ff', prompts: [] },
    { id: 'feishu', name: '飞书', serverName: 'feishu', connected: true, enabled: true, toolCount: 30, kind: 'cli', cli: { installed: true, bin: 'lark-cli' }, ready: true, summary: '飞书', badge: '飞', badgeColor: '#3370ff', prompts: [] },
    { id: 'meego', name: '飞书项目', serverName: 'meego', connected: true, enabled: true, toolCount: 48, kind: 'token', token: { label: 'MCP 用户令牌', placeholder: 'm-xxx', help: '', envFile: '', present: true, source: 'file', hint: 'm-abc…1234' }, ready: true, summary: '飞书项目', badge: '项', badgeColor: '#00b96b', prompts: [] },
  ],
  custom: [],
  connectedCount: 7,
  enabledToolTotal: 186,
  warnOverload: true,
  totalMcpEntries: 8,
  storeFile: '',
  rehydrate: { restored: [], resumed: [], failed: [] },
  node: { command: 'D:\\nvm\\v20.15.0\\node.exe', version: 'v20.15.0', major: 20, ok: true, minMajor: 18, fromPath: 'D:\\nodejs\\node.exe', fromPathVersion: 'v14.8.0' },
}

const HUB = {
  categories: ['办公协作', '文件与代码', '搜索与抓取', '数据与存储', '浏览器与自动化', '分析工具'],
  total: 24,
  builtins: [
    { id: 'dingtalk', connected: true, enabled: true, ready: true, toolCount: 47, cliInstalled: true, tokenPresent: true },
    { id: 'feishu', connected: true, enabled: true, ready: true, toolCount: 45, cliInstalled: true, tokenPresent: true },
    { id: 'meego', connected: false, enabled: false, ready: false, toolCount: 0, cliInstalled: true, tokenPresent: false },
  ],
  items: [
    { id: 'builtin-dingtalk', name: '钉钉', vendor: 'DingTalk', category: '办公协作', badge: '钉', badgeColor: '#1677ff', icon: 'dingtalk', summary: '钉钉全产品能力：AI 表格、考勤、日历、群聊与机器人、通讯录、文档、待办、审批、钉盘、听记。复用本机 dws CLI 的登录态。', tags: ['钉钉', 'IM', '日历'], transport: 'stdio', builtin: true, connectorId: 'dingtalk', install: null },
    { id: 'builtin-feishu', name: '飞书', vendor: 'Lark / 飞书', category: '办公协作', badge: '飞', badgeColor: '#3370ff', icon: 'feishu', summary: '飞书 / Lark 全产品能力：消息与群聊、日历、任务、通讯录、云文档、云空间、审批、知识库、表格、妙记。', tags: ['飞书', 'IM', '云文档'], transport: 'stdio', builtin: true, connectorId: 'feishu', install: null },
    { id: 'builtin-meego', name: '飞书项目', vendor: 'Lark Project / Meego', category: '办公协作', badge: '项', badgeColor: '#00b96b', icon: 'feishu-project', summary: '飞书项目（Meego）官方 MCP：需求 / 缺陷 / 迭代 / 排期、字段与角色、工作项检索（MQL）、WBS、评论、工时。', tags: ['飞书项目', '需求', 'MQL'], transport: 'stdio', builtin: true, connectorId: 'meego', install: null },
    { id: 'slack', name: 'Slack', vendor: 'Model Context Protocol', category: '办公协作', badge: 'SL', badgeColor: '#611f69', icon: 'slack', summary: '读频道历史、发消息、查用户。用 Bot Token 换，注意给最小 scope。', tags: ['IM', '频道'], transport: 'stdio', envKeys: [{ key: 'SLACK_BOT_TOKEN' }], headerKeys: [], install: null },
    { id: 'filesystem', name: 'Filesystem', vendor: 'Model Context Protocol', category: '文件与代码', badge: 'FS', badgeColor: '#2563eb', icon: 'filesystem', summary: '在指定目录内读写文件、搜索、打补丁。启动参数里必须给出允许访问的根目录。', tags: ['文件', '读写'], transport: 'stdio', envKeys: [], headerKeys: [] },
    { id: 'git', name: 'Git', vendor: 'Model Context Protocol', category: '文件与代码', badge: 'GIT', badgeColor: '#f97316', icon: 'git', summary: '读取仓库状态、diff、提交历史、分支，并执行只读的 git 命令。', tags: ['git', 'diff'], transport: 'stdio', envKeys: [], headerKeys: [] },
    { id: 'github', name: 'GitHub', vendor: 'GitHub（官方远程）', category: '文件与代码', badge: 'GH', badgeColor: '#111827', icon: 'github', summary: '仓库、Issue、PR、Code Search 与 Actions 日志。用 PAT 走远程 MCP。', tags: ['GitHub', 'PR'], transport: 'streamable-http', envKeys: [], headerKeys: [{ key: 'Authorization' }] },
    { id: 'brave-search', name: 'Brave Search', vendor: 'Brave', category: '搜索与抓取', badge: 'BS', badgeColor: '#fb542b', icon: 'brave-search', summary: '网页 / 新闻 / 图片搜索，需要 Brave Search API Key。', tags: ['搜索'], transport: 'stdio', envKeys: [{ key: 'BRAVE_API_KEY' }], headerKeys: [] },
    { id: 'postgres', name: 'PostgreSQL', vendor: 'Model Context Protocol', category: '数据与存储', badge: 'PG', badgeColor: '#336791', icon: 'postgres', summary: '只读 SQL 查询、表结构探查。连接串写进环境变量。', tags: ['数据库', 'SQL'], transport: 'stdio', envKeys: [], headerKeys: [] },
    { id: 'chrome-devtools', name: 'Chrome DevTools', vendor: 'Chrome DevTools', category: '浏览器与自动化', badge: 'CD', badgeColor: '#22c55e', icon: 'chrome-devtools', summary: '驱动真实 Chrome：导航、点按、抓网络请求、读控制台、截图。', tags: ['浏览器'], transport: 'stdio', envKeys: [], headerKeys: [] },
    { id: 'sequential-thinking', name: 'Sequential Thinking', vendor: 'Model Context Protocol', category: '分析工具', badge: 'ST', badgeColor: '#f59e0b', icon: 'sequential-thinking', summary: '把复杂问题拆成可回溯的推理步骤。', tags: ['推理'], transport: 'stdio', envKeys: [], headerKeys: [] },
  ],
}

globalThis.fetch = async (url) => {
  const path = String(url)
  const pick = path.includes('/connectors') ? CONNECTORS : path.includes('/hub') ? HUB : { cacheDir: 'C:\\Users\\xhzl\\.dsh\\chatops\\cache', cacheTtlMs: 28800000, surfaces: [], health: {}, config: {} }
  return { ok: true, status: 200, text: async () => JSON.stringify(pick) }
}

/* ── 生成 HTML ─────────────────────────────────────────────────── */

const mainEntry = registered.find((item) => item.name === 'main')
const Panel = mainEntry.entry.component

// 主题 token 兜底值（浅色）：真实取值由 ui-theme 提供。
const THEME = `
:root{
  --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#f7f8fa; --dsw-alias-bg-layer-2:#eef0f4;
  --dsw-alias-bg-mask-2:rgba(15,17,21,.42);
  --dsw-alias-border-l1:#e7e9ee; --dsw-alias-border-l2:#d4d8e0;
  --dsw-alias-label-primary:#12141a; --dsw-alias-label-secondary:#4a4f5a;
  --dsw-alias-label-tertiary:#6b7280; --dsw-alias-label-caption:#8b91a0;
  --dsw-alias-brand-primary:#3f5efb; --dsw-alias-interactive-bg-hover:#f0f2f6;
  --dsw-alias-interactive-bg-active:#e9ecf4;
  --dsw-alias-state-success-primary:#12a150; --dsw-alias-state-error-primary:#e5484d;
  --dsw-alias-state-warn-primary:#d97706;
  --dsw-alias-button-primary-fill:#3f5efb; --dsw-alias-button-primary-hover:#3450e0;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsh-font-family-text:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  --dsh-font-family-code:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
html,body{margin:0;padding:0;background:#ffffff;}
body{width:1180px;}
`

mkdirSync(join(HERE, 'output'), { recursive: true })

async function shot(name, render, width, height) {
  const body = await render()
  const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${name}</title>
<style>${THEME}${injectedCss}</style></head>
<body><div style="min-height:${height - 40}px">${body}</div></body></html>`
  const file = join(HERE, 'output', `panel-${name}.html`)
  writeFileSync(file, page, 'utf8')
  console.log(`${name}: ${file} (${page.length} 字节, ${width}x${height})`)
  return file
}

// 1) 我的 MCP：默认态
globalThis.__presetStates = {}
await shot('mcp', () => renderHtml(() => React.createElement(Panel, {})), 1180, 1100)

// 2) MCP Hub：预置 Panel 的第 0 个 state（当前页签）为 'hub'。
//    走点击回调不可靠（收集点击目标时的组件 key 与真正渲染时不同），
//    预置 state 走的是同一份代码、同一条渲染路径。
globalThis.__presetStates = { Panel: { 0: 'hub' } }
await shot('hub', () => renderHtml(() => React.createElement(Panel, {})), 1180, 1000)

// 3) 添加弹层：预置「从 Hub 选中 Filesystem」，走 presetSeed 那条真实路径。
//    形状必须与 Panel.pickFromHub 一致：{...item.install, ...item} 摊平到顶层，
//    否则 command / args 取不到，弹层会退回成空表单（第一版预览就是这么错的）。
const filesystemItem = {
  ...HUB.items[0],
  install: {
    serverName: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/path/to/workspace'],
    env: {},
    headers: {},
    toolCallTimeoutMs: 60000,
  },
}
globalThis.__presetStates = {
  Panel: {
    0: 'connectors',
    // 与 Panel.pickFromHub 同形：{...item, ...item.install}
    4: { ...filesystemItem, ...filesystemItem.install },
  },
}
await shot('install', () => renderHtml(() => React.createElement(Panel, {})), 1180, 900)
globalThis.__presetStates = {}
console.log('预览 HTML 已生成：output/panel-mcp.html / panel-hub.html / panel-install.html')
