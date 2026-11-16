/**
 * 静态渲染冒烟：不装浏览器，用最小 React 运行时把 client.js 的面板渲染出来。
 *
 * 为什么值得写：client.js 是手写 `h()` 树 + 大量内联样式和 CSS 类名，改完没有
 * 编译器兜底。拼错一个变量名、类名和 CSS 对不上、props 传错，页面打开才炸。
 * 这里做的是「渲染一遍 + 抓异常 + 校对类名」，比肉眼看 diff 靠谱。
 *
 * 覆盖：
 *   1. 面板能渲染（含 /connectors、/hub 数据回来后的第二遍渲染）
 *   2. 用到的 co-* 类名都真的在注入的样式表里
 *   3. Hub 卡片、服务行、添加弹层都能渲染
 *
 * 跑法：node tools/dsh-chatops-mcp/test-render.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(HERE, 'client.js'), 'utf8')

/* ── 最小 React ─────────────────────────────────────────────────── */

const instances = new Map() // 组件位置 key → { states: [], effects: [], cursor }
let currentKey = null
let currentCursor = 0
let pendingEffects = []

function makeElement(type, props, children) {
  const merged = { ...(props || {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { type, props: merged }
}

const React = {
  createElement: (type, props, ...children) => makeElement(type, props, children),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const inst = instances.get(currentKey)
    const index = currentCursor++
    if (inst.states.length <= index) inst.states[index] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      inst.states[index] = typeof next === 'function' ? next(inst.states[index]) : next
      inst.dirty = true
    }
    return [inst.states[index], setter]
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
      // 依赖没变：只换最新闭包，不重跑 —— 和 React 语义一致，也让冒烟能收敛。
      previous.fn = fn
      return
    }
    inst.effects[index] = { fn, signature }
    pendingEffects.push(() => previous.fn())
    pendingEffects.push(fn)
  },
  useRef(initial) {
    const inst = instances.get(currentKey)
    const index = currentCursor++
    if (!(index in inst.refs)) inst.refs[index] = { current: initial }
    return inst.refs[index]
  },
  // 依赖为空数组的 useCallback 在 React 里返回稳定引用，这里也要稳定：
  // 否则每次渲染都换新函数，把依赖它的 useEffect 变成无限重跑。
  useCallback(fn, deps) {
    const inst = instances.get(currentKey)
    const index = currentCursor++
    if (!(index in inst.refs)) inst.refs[index] = { fn, signature: deps === undefined ? 'always' : JSON.stringify(deps) }
    return inst.refs[index].fn
  },
}

/* ── 渲染器：把 h() 树展开成带 key 的遍历，同时收集文本与可点元素 ── */

let renderCounter = 0

function renderTree(node, sink) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    sink.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, sink)
    return
  }
  if (typeof node !== 'object') return
  const { type, props } = node
  if (typeof type === 'function') {
    const key = `${type.name || 'anon'}#${renderCounter++}`
    if (!instances.has(key)) instances.set(key, { states: [], effects: [], refs: {}, ranEffects: new Set() })
    const previousKey = currentKey
    const previousCursor = currentCursor
    currentKey = key
    currentCursor = 0
    let output
    try {
      output = type(props || {})
    } finally {
      currentKey = previousKey
      currentCursor = previousCursor
    }
    renderTree(output, sink)
    return
  }
  if (type === React.Fragment) {
    renderTree(props.children, sink)
    return
  }
  if (typeof props.onClick === 'function') {
    sink.clickables.push({ props, label: collectText(props.children) })
  }
  if (type === 'svg') sink.svgs.push(props)
  renderTree(props.children, sink)
}

function collectText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (typeof node === 'object') return collectText(node.props?.children)
  return ''
}

async function renderOnce(rootRenderer) {
  pendingEffects = []
  const sink = { text: [], clickables: [], svgs: [] }
  renderCounter = 0
  renderTree(rootRenderer(), sink)
  // 跑副作用（异步的等一拍），最多三轮：够让 fetch → setState 的数据落地。
  // 清理由 React 在卸载时调用，这里收集但不回灌，否则「还有未跑完的副作用」永远为真。
  const cleanups = []
  for (let pass = 0; pass < 3; pass += 1) {
    const batch = pendingEffects
    pendingEffects = []
    if (batch.length === 0) break
    for (const effect of batch) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    sink.text = []
    sink.clickables = []
    sink.svgs = []
    renderCounter = 0
    renderTree(rootRenderer(), sink)
  }
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch {
      /* 清理失败不影响断言 */
    }
  }
  return { text: sink.text.join(' '), clickables: sink.clickables, svgs: sink.svgs }
}

/* ── 抓 apply() 注册的 slot 组件 ────────────────────────────────── */

let capturedFactory = null
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      capturedFactory = factory
    },
  },
}
// 样式表注入走 document；这里只要把 CSS 文本留下来做类名校对。
let injectedCss = ''
globalThis.document = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (tag) => (injectedCss = tag.textContent) },
}
new Function(source)()

if (typeof capturedFactory !== 'function') {
  console.error('client.js 没有调用 window.__ModuleLoader__.load')
  process.exit(1)
}

const registered = []
const factory = capturedFactory
const module = factory((name) => {
  if (name === 'react') return React
  throw new Error(`未知依赖：${name}`)
})

const fakeCtx = {
  effect(fn) {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
  slots: {
    inject(name, generator) {
      for (const entry of generator()) registered.push({ name, entry })
    },
    register(meta, component) {
      return { meta, component }
    },
  },
}
module.apply(fakeCtx)

/* ── fetch 替身：喂真实形状的数据 ───────────────────────────────── */

const tools = (server, names) => names.map((raw) => ({ name: `mcp__${server}__${raw}`, rawName: raw, description: `${raw} 描述` }))

const CONNECTORS = {
  services: [
    {
      entryId: 'chatops-conn-dingtalk',
      serverName: 'dingtalk',
      origin: 'builtin',
      transport: 'stdio',
      target: 'D:\\nodejs\\node.exe server.js dingtalk',
      disabled: false,
      connected: true,
      toolCount: 3,
      tools: tools('dingtalk', ['contact_user_get', 'chat_send', 'todo_create']),
      name: '钉钉',
      vendor: 'DingTalk',
      category: '办公协作',
      badge: '钉',
      badgeColor: '#1677ff',
      summary: '钉钉全产品能力',
      kind: 'cli',
    },
    {
      entryId: 'chatops-custom-apipostmcp',
      serverName: 'apipostMcp',
      origin: 'custom',
      transport: 'stdio',
      target: 'npx -y mcp-remote https://open.apipost.net/mcp',
      disabled: false,
      connected: true,
      toolCount: 2,
      tools: tools('apipostMcp', ['create_project', 'search_model']),
      name: 'apipostMcp',
      vendor: '自定义',
      category: '自定义',
      badge: 'AP',
      badgeColor: '#475569',
      summary: '本机 MCP 连接',
      kind: 'custom',
    },
    {
      entryId: 'my-own-row',
      serverName: 'lighthouse',
      origin: 'external',
      transport: 'streamable-http',
      target: 'https://example.com/mcp',
      disabled: true,
      connected: true,
      toolCount: 0,
      tools: [],
      name: 'lighthouse',
      vendor: '外部连接',
      category: '自定义',
      badge: 'LI',
      badgeColor: '#475569',
      summary: 'https://example.com/mcp',
      kind: 'custom',
    },
  ],
  builtins: [
    { id: 'dingtalk', name: '钉钉', serverName: 'dingtalk', connected: true, enabled: true, toolCount: 3, kind: 'cli', cli: { installed: true, bin: 'dws', path: 'D:\\dws\\dws.exe', package: 'dingtalk-workspace-cli' }, ready: true, summary: '钉钉', badge: '钉', badgeColor: '#1677ff', prompts: [] },
    { id: 'feishu', name: '飞书', serverName: 'feishu', connected: false, enabled: false, toolCount: 0, kind: 'cli', cli: { installed: true, bin: 'lark-cli', path: 'D:\\lark-cli\\lark-cli.exe', package: '@larksuite/cli' }, ready: true, summary: '飞书', badge: '飞', badgeColor: '#3370ff', prompts: [] },
    { id: 'meego', name: '飞书项目', serverName: 'meego', connected: false, enabled: false, toolCount: 0, kind: 'token', token: { label: 'MCP 用户令牌', placeholder: 'm-xxx', help: 'help', envFile: 'C:\\m\\.env', present: false, source: null, hint: null }, ready: false, summary: '飞书项目', badge: '项', badgeColor: '#00b96b', prompts: [] },
  ],
  custom: [],
  connectedCount: 2,
  enabledToolTotal: 5,
  warnOverload: false,
  totalMcpEntries: 3,
  storeFile: 'C:\\store.json',
  rehydrate: { restored: [], resumed: [], failed: [] },
  node: { command: 'D:\\nvm\\v20.15.0\\node.exe', version: 'v20.15.0', major: 20, ok: true, minMajor: 18, fromPath: 'D:\\nodejs\\node.exe', fromPathVersion: 'v14.8.0' },
}

const HUB = {
  categories: ['办公协作', '文件与代码', '搜索与抓取'],
  items: [
    { id: 'builtin-dingtalk', name: '钉钉', vendor: 'DingTalk', category: '办公协作', badge: '钉', badgeColor: '#1677ff', icon: 'dingtalk', summary: '钉钉全产品能力', tags: ['钉钉', 'IM'], transport: 'stdio', builtin: true, connectorId: 'dingtalk', install: null },
    { id: 'builtin-feishu', name: '飞书', vendor: 'Lark / 飞书', category: '办公协作', badge: '飞', badgeColor: '#3370ff', icon: 'feishu', summary: '飞书全产品能力', tags: ['飞书'], transport: 'stdio', builtin: true, connectorId: 'feishu', install: null },
    { id: 'builtin-meego', name: '飞书项目', vendor: 'Lark Project / Meego', category: '办公协作', badge: '项', badgeColor: '#00b96b', icon: 'feishu-project', summary: '飞书项目官方 MCP', tags: ['项目'], transport: 'stdio', builtin: true, connectorId: 'meego', install: null },
    { id: 'filesystem', name: 'Filesystem', vendor: 'Model Context Protocol', category: '文件与代码', badge: 'FS', badgeColor: '#2563eb', icon: 'filesystem', summary: '在指定目录内读写文件', tags: ['文件', '读写'], transport: 'stdio', serverName: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/path/to/workspace'], envKeys: [], headerKeys: [], install: { serverName: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/path/to/workspace'], env: {}, headers: {}, toolCallTimeoutMs: 60000 } },
    { id: 'github', name: 'GitHub', vendor: 'GitHub（官方远程）', category: '文件与代码', badge: 'GH', badgeColor: '#111827', icon: 'github', summary: '仓库、Issue、PR', tags: ['GitHub'], transport: 'streamable-http', serverName: 'github', headerKeys: [{ key: 'Authorization' }], envKeys: [], install: { serverName: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: '' }, env: {} } },
  ],
  builtins: [
    { id: 'dingtalk', connected: true, enabled: true, ready: true, toolCount: 3, cliInstalled: true, tokenPresent: true },
    { id: 'feishu', connected: false, enabled: false, ready: true, toolCount: 0, cliInstalled: true, tokenPresent: true },
    { id: 'meego', connected: false, enabled: false, ready: false, toolCount: 0, cliInstalled: true, tokenPresent: false },
  ],
  total: 5,
}
const STATE = { cacheDir: 'C:\\cache', cacheTtlMs: 28800000, surfaces: [], health: {}, config: { max: 30, effect: 'all', products: 'auto' } }

globalThis.fetch = async (url) => {
  const path = String(url)
  const pick = path.includes('/connectors') ? CONNECTORS : path.includes('/hub') ? HUB : path.includes('/state') ? STATE : {}
  return { ok: true, status: 200, text: async () => JSON.stringify(pick) }
}

/* ── 跑：把每个注册的 slot 组件都渲染一遍，并断言关键内容出现 ───── */

const problems = []
const rendered = new Map()

for (const { name, entry } of registered) {
  const Component = entry.component
  const label = `${name}/${entry.meta?.id || entry.meta?.key || ''}`
  try {
    rendered.set(name, await renderOnce(() => React.createElement(Component, {})))
    if (pendingEffects.length) problems.push(`${label}：仍有未收敛的副作用`)
  } catch (error) {
    problems.push(`${label} 渲染异常：${error.stack?.split('\n')[0] || error.message}`)
  }
}

const mainText = rendered.get('main')?.text || ''
const expectText = (needle, why) => {
  if (!mainText.includes(needle)) problems.push(`主面板没渲染出「${needle}」（${why}）`)
}

expectText('MCP 服务管理', '标题应已改为通用 MCP 面板')
expectText('我的 MCP（3）', '服务列表应显示统一的 3 条连接')
expectText('v20.15.0', 'node 体检信息应显示在列表上方')
expectText('apipostMcp', '自定义连接应出现在卡片里（以前只有表格行）')
expectText('lighthouse', '别处写的 mcp-client 行也应被看见')
expectText('个工具', '应显示每条连接的工具数')
expectText('可一键连接', '未连接的内置项应落到「可一键连接」区')
expectText('外部', 'origin=external 应有标记')
expectText('自定义', 'origin=custom 应有标记')

// 侧栏与设置页也渲染同一份面板
for (const slotName of ['settings.section']) {
  const text = rendered.get(slotName)?.text || ''
  if (!text.includes('我的 MCP（3）')) problems.push(`${slotName} 没渲染出数据`)
}

/* ── 交互：点「MCP Hub」页签 → 选一项 → 应切回我的 MCP 并打开安装弹层 ── */

{
  const panel = registered.find((item) => item.name === 'main').entry.component
  const clickables = rendered.get('main')?.clickables || []
  const hubTab = clickables.find((item) => item.label.trim() === 'MCP Hub')
  if (!hubTab) {
    problems.push('工具条里没找到「MCP Hub」页签')
  } else {
    hubTab.props.onClick()
    const afterTab = await renderOnce(() => React.createElement(panel, {}))
    if (!afterTab.text.includes('Filesystem')) problems.push('MCP Hub 页没渲染出模板卡片')
    if (!afterTab.text.includes('Hub 只是可安装模板')) problems.push('MCP Hub 缺少「这只是模板」的说明')
    // 内置三条必须出现在 Hub 里，否则用户以为 Hub 不支持钉钉飞书。
    for (const name of ['钉钉', '飞书', '飞书项目']) {
      if (!afterTab.text.includes(name)) problems.push(`Hub 里没渲染出内置项「${name}」`)
    }
    // 分类改成横排标签：标签文本要出现，且不能再是 <select>。
    for (const name of ['全部', '办公协作', '文件与代码', '搜索与抓取']) {
      if (!afterTab.text.includes(name)) problems.push(`分类标签栏缺「${name}」`)
    }
    const hasSelect = afterTab.clickables.some((node) => node.props?.['aria-label'] === '按分类筛选')
    if (hasSelect) problems.push('分类仍是下拉框（应改为横排标签）')
    // 品牌图标：Hub 卡片应画出 svg（而不是全部回落成两字母块）。
    if (afterTab.svgs.length === 0) problems.push('Hub 卡片没有渲染任何 svg 品牌图标')

    const card = afterTab.clickables.find((item) => item.label.includes('Filesystem'))
    if (!card) {
      problems.push('Hub 卡片不可点（找不到 Filesystem 的点击目标）')
    } else {
      card.props.onClick()
      const afterPick = await renderOnce(() => React.createElement(panel, {}))
      if (!afterPick.text.includes('安装 Filesystem')) problems.push('选模板后没打开安装弹层')
      if (!afterPick.text.includes('安装并连接')) problems.push('模板弹层的提交按钮文案不对')
      if (!afterPick.text.includes('serverName')) problems.push('模板弹层没预填表单字段')
    }
  }
}

/* ── 类名校对：client.js 用到的 co-* 必须在注入的 CSS 里 ────────── */

const usedClasses = new Set()
for (const match of source.matchAll(/className:\s*'([^']+)'/g)) {
  for (const token of match[1].split(/\s+/)) if (token.startsWith('co-')) usedClasses.add(token)
}
for (const match of source.matchAll(/className:\s*"([^"]+)"/g)) {
  for (const token of match[1].split(/\s+/)) if (token.startsWith('co-')) usedClasses.add(token)
}
const definedClasses = new Set([...injectedCss.matchAll(/\.(co-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]))
const missing = [...usedClasses].filter((name) => !definedClasses.has(name))
if (missing.length) problems.push('用了但没定义的类名：' + missing.join(', '))
if (!injectedCss) problems.push('样式表没有被注入（PANEL_CSS 为空或注入路径变了）')

console.log(`渲染 slot：${registered.map((item) => item.name).join(', ')}`)
console.log(`类名：用到 ${usedClasses.size} 个，样式表定义 ${definedClasses.size} 个`)
if (problems.length) {
  console.error('\n问题：')
  for (const line of problems) console.error(' - ' + line)
  process.exit(1)
}
console.log('渲染冒烟通过')
