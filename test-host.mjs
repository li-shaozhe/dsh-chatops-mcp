/**
 * 后端自检：用假 ctx 跑 chatops-mcp-panel 的真实路由，不需要启动 dsh。
 *
 * 覆盖：
 *   - GET /hub                          模板目录
 *   - GET /connectors                   统一 services 列表（builtin / custom / external）
 *   - POST /services/toggle|remove      启停与删除（内置删除要留 sticky 标记）
 *   - POST /services/install-hub        用 Hub 模板建一条连接
 *   - POST /custom/json                 贴 mcpServers JSON
 *
 * 跑法（必须先把连接表指到临时文件，别动本机真实 connections.json）：
 *   CHATOPS_CONNECTION_STORE=... node tools/dsh-chatops-mcp/test-host.mjs
 */
import { pathToFileURL } from 'node:url'
import { readFile, rm } from 'node:fs/promises'

const STORE = process.env.CHATOPS_CONNECTION_STORE
if (!STORE) {
  console.error('请先设置 CHATOPS_CONNECTION_STORE 指向一个临时文件')
  process.exit(1)
}
await rm(STORE, { force: true })

const { apply } = await import('./index.js')

/* ── 假 Loader：内存树 + 和真 loader 同形的入口 API ─────────────── */

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

function makeLoader() {
  const tree = new Map()
  const entries = () =>
    [...tree.entries()].map(([id, options]) => ({
      id,
      options,
      update: async (patch) => {
        tree.set(id, { ...tree.get(id), ...patch })
      },
    }))
  return {
    tree,
    entries,
    resolve(id) {
      if (!tree.has(id)) throw new Error(`no entry ${id}`)
      return {
        options: tree.get(id),
        update: async (patch) => {
          tree.set(id, { ...tree.get(id), ...patch })
        },
      }
    },
    async create(options) {
      if (tree.has(options.id)) throw new Error(`duplicate ${options.id}`)
      tree.set(options.id, { name: options.name, config: options.config, disabled: Boolean(options.disabled) })
      return options.id
    },
    async update(id, patch) {
      if (!tree.has(id)) throw new Error(`no entry ${id}`)
      tree.set(id, { ...tree.get(id), ...patch })
    },
    remove(id) {
      tree.delete(id)
    },
  }
}

/* ── 假 ctx：拦下 effect / on / webServer.register ──────────────── */

const routes = []
let handler = null
const loader = makeLoader()

// 预置：一条内置（钉钉）、一条自定义、一条「别人的」外部行
loader.tree.set('chatops-conn-dingtalk', {
  name: MCP_CLIENT,
  config: { serverName: 'dingtalk', transport: 'stdio', command: 'node', args: ['server.js', 'dingtalk'] },
  disabled: false,
})
loader.tree.set('chatops-custom-apipostmcp', {
  name: MCP_CLIENT,
  config: { serverName: 'apipostMcp', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://open.apipost.net/mcp'] },
  disabled: false,
})
loader.tree.set('my-own-row', {
  name: MCP_CLIENT,
  config: { serverName: 'lighthouse', transport: 'streamable-http', url: 'https://example.com/mcp' },
  disabled: true,
})

const toolSchemas = [
  ...Array.from({ length: 7 }, (_, i) => ({ name: `mcp__dingtalk__tool_${i}`, description: `钉钉工具 ${i}` })),
  ...Array.from({ length: 10 }, (_, i) => ({ name: `mcp__apipostMcp__api_${i}`, description: `接口工具 ${i}` })),
]

const ctx = {
  get(name) {
    if (name === 'loader') return loader
    if (name === 'tools') return { schemas: () => toolSchemas }
    return null
  },
  effect(fn) {
    const dispose = fn()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
  on() {},
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    register(def) {
      routes.push(def.path)
      handler = def.handler
      return () => {}
    },
  },
}

apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 120))

if (!handler) {
  console.error('apply() 没有注册任何路由')
  process.exit(1)
}

/* ── 一个最小的 req/res 替身 ───────────────────────────────────── */

async function call(method, path, body) {
  const url = new URL('http://localhost' + path)
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: url.pathname + url.search,
    [Symbol.asyncIterator]() {
      let index = 0
      return { next: async () => (index < payload.length ? { value: payload[index++], done: false } : { done: true }) }
    },
  }
  let status = 200
  let text = ''
  const res = {
    set statusCode(value) {
      status = value
    },
    get statusCode() {
      return status
    },
    setHeader() {},
    end(chunk) {
      text = String(chunk || '')
    },
  }
  await handler(req, res)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status, json }
}

const problems = []
const ok = (cond, message) => {
  if (!cond) problems.push(message)
}

/* ── 用例 ──────────────────────────────────────────────────────── */

{
  const { status, json } = await call('GET', '/chatops-mcp/hub')
  ok(status === 200, `GET /hub 应 200，实际 ${status}`)
  ok(json.total >= 15, `GET /hub total 应 >= 15，实际 ${json.total}`)
  ok(Array.isArray(json.categories) && json.categories.length >= 5, 'GET /hub 分类不足')
  const fs = json.items.find((item) => item.id === 'filesystem')
  ok(fs && fs.install && fs.install.command === 'npx', 'filesystem 模板没有带 install.command')
  ok(fs && fs.install.transport === 'stdio', 'filesystem 模板 transport 不对')
}

{
  const { status, json } = await call('GET', '/chatops-mcp/connectors')
  ok(status === 200, `GET /connectors 应 200，实际 ${status}`)
  ok(Array.isArray(json.services), 'GET /connectors 没有 services 字段')
  const byServer = Object.fromEntries((json.services || []).map((item) => [item.serverName, item]))
  // 启动时 seedBuiltins 会按本机 CLI 安装情况补行，所以这里只断言「该有的在」，不断言总数。
  ok(byServer.dingtalk?.origin === 'builtin', 'dingtalk 应为 builtin')
  ok(byServer.dingtalk?.toolCount === 7, `dingtalk 工具数应为 7，实际 ${byServer.dingtalk?.toolCount}`)
  ok(byServer.apipostMcp?.origin === 'custom', 'apipostMcp 应为 custom')
  ok(byServer.apipostMcp?.toolCount === 10, `apipostMcp 工具数应为 10，实际 ${byServer.apipostMcp?.toolCount}`)
  ok(byServer.lighthouse?.origin === 'external', 'lighthouse 应为 external')
  ok(byServer.lighthouse?.disabled === true, 'lighthouse 应为停用')
  ok(byServer.lighthouse?.transport === 'streamable-http', 'lighthouse transport 应为 streamable-http')
  ok(byServer.lighthouse?.target === 'https://example.com/mcp', 'lighthouse target 应回落到 url')
  // 停用的排最后
  const list = json.services || []
  ok(list[list.length - 1].serverName === 'lighthouse', '停用项应排在最后')
  ok(json.enabledToolTotal === 17, `启用工具总数应为 17，实际 ${json.enabledToolTotal}`)
  ok(json.warnOverload === false, '17 个工具不该报超载')
  // 工具清单要带 rawName，面板展开时显示的是裸名
  ok(byServer.dingtalk?.tools?.[0]?.rawName?.startsWith('tool_'), 'dingtalk 工具清单缺 rawName')
}

{
  const { json } = await call('POST', '/chatops-mcp/services/toggle', { entryId: 'my-own-row', enabled: true })
  ok(json.ok === true && json.enabled === true, 'toggle 外部行失败')
  ok(loader.tree.get('my-own-row').disabled === false, 'toggle 没写回 loader')
  // 外部行不能落进我们的 store：那会在重启时替别的插件重建一份连接。
  ok(json.persisted === false, '外部行启停不该持久化')
  const storeAfterToggle = await readFile(STORE, 'utf8').catch(() => '{"entries":{}}')
  ok(!JSON.parse(storeAfterToggle).entries['my-own-row'], '外部行不该出现在 store 里')
}

{
  // 外部行不接受删除，避免「删了重启又回来」和与拥有者冲突。
  const { json } = await call('POST', '/chatops-mcp/services/remove', { entryId: 'my-own-row' })
  ok(json.ok === false && json.reason === 'external', '外部行删除应被拒并给出 reason=external')
  ok(loader.tree.has('my-own-row'), '外部行不该被删掉')
}

{
  const { json } = await call('POST', '/chatops-mcp/services/remove', { entryId: 'chatops-conn-dingtalk' })
  ok(json.removed === true, '内置行删除应返回 removed=true')
  ok(json.sticky === true, '内置行删除应带 sticky 标记')
  ok(!loader.tree.has('chatops-conn-dingtalk'), '内置行没从 loader 删掉')
  const store = JSON.parse(await readFile(STORE, 'utf8'))
  ok(store.entries['chatops-conn-dingtalk']?.removed === true, 'store 里没留下 removed 标记')
}

{
  const { json } = await call('POST', '/chatops-mcp/services/install-hub', { id: 'filesystem' })
  ok(json.ok === true, `install-hub 失败：${json.error || ''}`)
  ok(json.serverName === 'filesystem', 'install-hub serverName 不对')
  const created = [...loader.tree.entries()].find(([, options]) => options.config?.serverName === 'filesystem')
  ok(created, 'install-hub 没在 loader 里建行')
}

{
  const { json } = await call('POST', '/chatops-mcp/custom/json', {
    json: JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['-y', 'a'] }, beta: { type: 'streamableHttp', url: 'https://x.test/mcp' } } }),
  })
  ok(json.succeeded === 2, `贴 JSON 应建 2 条，实际 ${json.succeeded}`)
}

{
  // 未知 Hub 项要报错而不是静默建一条空连接
  const { status } = await call('POST', '/chatops-mcp/services/install-hub', { id: 'not-exist' })
  ok(status === 400, `未知 Hub 项应 400，实际 ${status}`)
}

await rm(STORE, { force: true })
await rm(new URL('./.test-tmp-store.json', import.meta.url), { force: true })

if (problems.length) {
  console.error('失败：')
  for (const line of problems) console.error(' - ' + line)
  process.exit(1)
}
console.log(`路由：${routes.join(', ')}`)
console.log('后端用例全部通过')
