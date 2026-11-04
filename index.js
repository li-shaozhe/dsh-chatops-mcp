/**
 * dsh-chatops-mcp — Host half of the panel.
 *
 * Two jobs:
 *
 *  A. 连接器（新增）：把一行 `@deepseek-ai/dsh-mcp-client` 写进 Loader 树，
 *     让「点连接」真的接上一个 MCP 服务。写入走 `ctx.loader.create/update/remove`，
 *     但 Loader 只改内存（`Loader.write()` 是空实现），所以持久化靠本包自己的
 *     `~/.dsh/chatops/connections.json`：`apply()` 启动时 rehydrate，
 *     `app-boot/config-reload` 时再按表压一次启停位。
 *
 *  B. 只读观测：CLI 版本 / 登录身份 / CLI 自描述目录。
 *
 * Routes:
 *
 *   GET  /chatops-mcp/state              one call: three surfaces + effective config
 *   GET  /chatops-mcp/health             CLI versions and logged-in identities (cached)
 *   GET  /chatops-mcp/catalog            browse the CLI's own catalog
 *   GET  /chatops-mcp/schema             full flag list for one command
 *   GET  /chatops-mcp/tools              preview which entries become real MCP tools
 *   POST /chatops-mcp/refresh            re-read a CLI catalog and rewrite the cache
 *
 *   GET  /chatops-mcp/connectors         内置连接器目录 + 本机状态 + 自定义连接
 *   POST /chatops-mcp/connectors/connect     写一行 mcp-client（连接）
 *   POST /chatops-mcp/connectors/disconnect  删掉那一行（断开连接）
 *   POST /chatops-mcp/connectors/toggle      启用 / 停用
 *   POST /chatops-mcp/connectors/install     全局 npm 安装 CLI
 *   POST /chatops-mcp/connectors/login       开始设备码登录，返回验证链接
 *   POST /chatops-mcp/connectors/login/finish 复查 / 用 device_code 完成登录
 *   POST /chatops-mcp/connectors/logout      退出 CLI 登录
 *   POST /chatops-mcp/connectors/token       写入飞书项目 MCP 用户令牌
 *   POST /chatops-mcp/custom                 自定义连接（stdio / streamable-http）
 *   POST /chatops-mcp/custom/json            粘贴 MCP JSON 批量连接（mcpServers 形态）
 *   POST /chatops-mcp/custom/remove          删除自定义连接
 *   POST /chatops-mcp/custom/toggle          启用 / 停用自定义连接
 *
 * 连接器路由之外的部分仍然只读；唯一的磁盘副作用是 CLI 目录缓存与
 * `~/.dsh/chatops/meego/.env`（只在用户主动提交令牌时写）。
 */

import { runCli, resolveCli, resolveGlobalFile } from './cli.js'
import {
  CATALOG,
  ENTRY_PREFIX,
  buildCatalogConfig,
  buildCustomConfig,
  collectMcpEntries,
  connectorState,
  countToolsByServer,
  customEntryId,
  customState,
  entryExists,
  parseMcpJson,
  resolveConnectorEntry,
  findConnector,
  cliLocation,
  finishLogin,
  installCli,
  logout,
  provisionEntry,
  readMeegoToken,
  removeEntry,
  setEntryEnabled,
  startLogin,
  writeMeegoToken,
  applyStoredFlags,
  forgetEntry,
  migrateStoreKeys,
  rehydrate,
  rememberEnabled,
  rememberEntry,
  seedBuiltins,
  storeFile,
  CUSTOM_PREFIX,
} from './connectors.js'
import {
  discoverDingTalk,
  discoverFeishu,
  peekCache,
  cacheDirPath,
  cacheTtlMs,
  productsFor,
  effectiveConfig,
  catalogSummary,
  catalogProducts,
  findEntry,
  schemaDetail,
  selectEntries,
  maxTools,
} from './discovery.js'

const name = 'chatops-mcp-panel'
const inject = ['webServer', 'loader', 'tools']

const ROUTE_PREFIX = '/chatops-mcp'

const SURFACES = [
  { id: 'dingtalk', label: '钉钉', cli: 'dws', prefix: 'dingtalk' },
  { id: 'feishu', label: '飞书', cli: 'lark-cli', prefix: 'feishu' },
  { id: 'meego', label: '飞书项目', cli: '@lark-project/mcp', prefix: 'meego' },
]

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/* ------------------------------------------------------------------ *
 * Health: CLI versions + who is logged in
 * ------------------------------------------------------------------ */

let healthCache = { at: 0, data: null }

/** apply() 里 rehydrate 的结果，给面板一个「上次恢复情况」的可见入口。 */
let rehydrateReport = { restored: [], resumed: [], failed: [] }
const HEALTH_TTL_MS = 120000

async function probeHealth({ force = false } = {}) {
  if (!force && healthCache.data && Date.now() - healthCache.at < HEALTH_TTL_MS) {
    return { ...healthCache.data, cached: true }
  }

  const [dwsVersion, dwsSelf, larkVersion, larkWho] = await Promise.all([
    runCli('dws', ['version', '--format', 'json'], { timeoutMs: 20000 }),
    runCli('dws', ['contact', 'user', 'get-self', '--format', 'json'], { timeoutMs: 30000 }),
    runCli('lark-cli', ['--version'], { timeoutMs: 20000 }),
    runCli('lark-cli', ['whoami'], { timeoutMs: 30000 }),
  ])

  // dws wraps the payload as { result: [ { orgEmployeeModel } ], success: true }, while the
  // MCP child's dwsResult unwraps one level. Accept both shapes — a wrong guess here shows
  // up as "未登录" on a perfectly healthy connection.
  const dwsPayload = dwsSelf.json?.result ?? dwsSelf.json
  const dwsFirst = Array.isArray(dwsPayload) ? dwsPayload[0] : dwsPayload
  const dwsOrg = dwsFirst?.orgEmployeeModel ?? dwsFirst ?? null
  const larkIdentity = larkWho.json ?? null

  const data = {
    dingtalk: {
      cliFound: resolveCli('dws').path,
      version: dwsVersion.json?.version || (dwsVersion.text || '').split('\n')[0] || null,
      edition: dwsVersion.json?.edition ?? null,
      loggedIn: Boolean(dwsSelf.ok && dwsOrg),
      user: dwsOrg?.orgUserName ?? null,
      org: dwsOrg?.orgName ?? null,
      department: Array.isArray(dwsOrg?.depts) && dwsOrg.depts[0]?.deptName ? dwsOrg.depts[0].deptName : null,
      email: dwsOrg?.orgAuthEmail ?? null,
      error: dwsSelf.ok ? null : (dwsSelf.stderr || dwsSelf.text || '').slice(0, 400) || null,
    },
    feishu: {
      cliFound: resolveCli('lark-cli').path,
      version: (larkVersion.text || '').replace(/^lark-cli version\s*/i, '').trim() || null,
      loggedIn: Boolean(larkWho.ok && larkIdentity?.available !== false && larkIdentity?.identity),
      identity: larkIdentity?.identity ?? null,
      tokenStatus: larkIdentity?.tokenStatus ?? null,
      user: larkIdentity?.onBehalfOf?.userName ?? null,
      openId: larkIdentity?.onBehalfOf?.openId ?? null,
      brand: larkIdentity?.brand ?? null,
      error: larkWho.ok ? null : (larkWho.stderr || larkWho.text || '').slice(0, 400) || null,
    },
  }

  healthCache = { at: Date.now(), data }
  return { ...data, cached: false }
}

/* ------------------------------------------------------------------ *
 * Meego: the official server owns the tools; we only report credential state
 * ------------------------------------------------------------------ */

async function meegoState() {
  const { readFileSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')

  // 官方包位置靠推导，不写死盘符 —— 这个包要能被别人装到别的机器上。
  const bin =
    process.env.CHATOPS_MEEGO_BIN ||
    resolveGlobalFile(join('@lark-project', 'mcp', 'dist', 'index.js')) ||
    ''
  const envFile = process.env.CHATOPS_MEEGO_ENV_FILE || join(homedir(), '.dsh', 'chatops', 'meego', '.env')

  let tokenSource = null
  let tokenHint = null
  if (process.env.MCP_USER_TOKEN) {
    tokenSource = 'environment'
    tokenHint = mask(process.env.MCP_USER_TOKEN)
  } else if (existsSync(envFile)) {
    const text = readFileSync(envFile, 'utf8')
    const match = text.match(/^\s*(?:MCP_USER_TOKEN|MEEGO_MCP_USER_TOKEN|MCP_TOKEN)\s*=\s*(.+)$/m)
    if (match) {
      tokenSource = envFile
      tokenHint = mask(match[1].trim().replace(/^['"]|['"]$/g, ''))
    }
  }

  return {
    serverFound: existsSync(bin),
    serverPath: bin,
    envFile,
    tokenSource,
    tokenHint,
    ready: Boolean(tokenSource && existsSync(bin)),
  }
}

function mask(value) {
  const text = String(value || '')
  if (text.length <= 10) return text ? '***' : null
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

/* ------------------------------------------------------------------ *
 * 连接器：目录 / 连接 / 断开 / 安装 CLI / 登录 / 令牌 / 自定义连接
 * ------------------------------------------------------------------ */

/** 当前 loader 里的 mcp-client 行；loader 未就绪时返回空表而不是抛错。 */
function mcpEntries(ctx) {
  const loader = ctx.get('loader')
  if (!loader) return new Map()
  return collectMcpEntries(loader)
}

/** 每个 serverName 已注册的工具数（来自 tools 服务，反映「真正生效」的结果）。 */
function toolCounts(ctx) {
  const tools = ctx.get('tools')
  if (!tools) return {}
  return countToolsByServer(tools)
}

function connectorsPayload(ctx) {
  const entries = mcpEntries(ctx)
  const counts = toolCounts(ctx)
  const builtins = CATALOG.map((connector) => connectorState(connector, entries, counts))
  const custom = []
  for (const [entryId, options] of entries) {
    if (!entryId.startsWith(CUSTOM_PREFIX)) continue
    custom.push(customState(entryId, options, counts))
  }
  const connectedCount = builtins.filter((item) => item.connected && item.enabled).length
  const enabledToolTotal = [...builtins.map((item) => item.toolCount), ...custom.filter((c) => !c.disabled).map((c) => c.toolCount)]
    .reduce((sum, value) => sum + (Number(value) || 0), 0)
  return {
    builtins,
    custom,
    connectedCount,
    enabledToolTotal,
    warnOverload: enabledToolTotal > 80,
    totalMcpEntries: entries.size,
    storeFile: storeFile(),
    rehydrate: rehydrateReport,
  }
}

/** 连接器操作需要 loader；没有就直接报错，让面板显示原因。 */
function requireLoader(ctx) {
  const loader = ctx.get('loader')
  if (!loader) throw new Error('宿主没有提供 loader 服务，无法写入 MCP 配置')
  return loader
}

/**
 * 「点 + 就连上」：把前置条件也一起办掉。
 *
 *  - CLI 没装 → 先 npm i -g，装完再往下走
 *  - CLI 没登录 → 返回 device 授权信息（`needsLogin: true`），面板直接显示设备码，
 *    用户授权完点「我已授权」再调一次本函数即可
 *  - 令牌没有 → 抛「请先填写令牌」，这条没法自动完成
 *
 * 每步做了什么放在返回的 `steps[]` 里，面板可以逐条展示，不至于「转圈圈然后失败」。
 */
async function quickConnect(ctx, payload) {
  const id = String(payload?.id || '')
  const connector = findConnector(id)
  if (!connector) throw new Error(`未知连接器：${id}`)
  const steps = []

  if (connector.kind === 'cli') {
    if (!cliLocation(connector.cliKind)) {
      steps.push(`CLI 未安装，正在 npm i -g ${connector.cliPackage}`)
      const installed = await installCli(connector)
      if (!installed.ok) {
        throw new Error(`安装 ${connector.cliPackage} 失败：${(installed.output || '').split(/\r?\n/).slice(-3).join(' ')}`)
      }
      steps.push('CLI 安装完成')
    }
    const login = await startLogin(connector)
    if (login.mode !== 'already') {
      return {
        ok: false,
        needsLogin: true,
        connector: connector.id,
        steps,
        device: login,
        message: `${connector.name} 需要先授权登录`,
      }
    }
    steps.push('登录状态正常')
  } else if (connector.kind === 'token') {
    const token = readMeegoToken(connector.tokenSpec)
    if (!token.value) throw new Error(`请先填写${connector.tokenSpec.label}`)
    steps.push('令牌已配置')
  }

  const result = await connectConnector(ctx, payload)
  return { ...result, steps }
}

async function connectConnector(ctx, payload) {
  const id = String(payload?.id || '')
  const connector = findConnector(id)
  if (!connector) throw new Error(`未知连接器：${id}`)

  // 前置条件：CLI 装了 / 令牌有值。缺了就明确告诉面板该点哪一步，不静默失败。
  if (connector.kind === 'cli') {
    const path = cliLocation(connector.cliKind)
    if (!path) throw new Error(`${connector.name} CLI 未安装，请先点「安装 CLI」`)
  } else if (connector.kind === 'token') {
    const token = readMeegoToken(connector.tokenSpec)
    if (!token.value) throw new Error(`请先填写${connector.tokenSpec.label}`)
  }

  const loader = requireLoader(ctx)
  const config = buildCatalogConfig(connector, payload || {})
  const entries = collectMcpEntries(loader)

  // 已经有同 serverName 的行（bundle 的 patch 行或用户之前连的）→ 就地更新那一行，
  // 不要再 create 一条，否则 serverName 重复会让 dsh 启动报错。
  const existing = resolveConnectorEntry(connector, entries)
  const entryId = existing?.entryId || ENTRY_PREFIX + connector.id

  // serverName 被别的连接器占用的检查：只在该名字属于另一个 entry 时才报错。
  for (const [otherId, options] of entries) {
    if (otherId === entryId) continue
    if (options?.config?.serverName === config.serverName) {
      throw new Error(`serverName「${config.serverName}」已被 ${otherId} 占用，换一个名字再连`)
    }
  }
  const result = await provisionEntry(loader, entryId, config)
  // 记进自有存储：Loader 的根树是内存态，不记就熬不过重启。
  rememberEntry(result.entryId || entryId, { config, disabled: false })
  return { ok: true, ...result, serverName: config.serverName, connector: connector.id }
}

async function disconnectConnector(ctx, payload, { prefix = ENTRY_PREFIX } = {}) {
  const loader = requireLoader(ctx)

  if (prefix === ENTRY_PREFIX) {
    const id = String(payload?.id || '')
    const connector = findConnector(id)
    if (!connector) throw new Error(`未知连接器：${id}`)
    // 断开的是「这个 serverName 对应的行」，不限于面板自己建的那条 id。
    const existing = resolveConnectorEntry(connector, collectMcpEntries(loader))
    if (!existing) return { ok: true, removed: false, entryId: null }
    const removed = removeEntry(loader, existing.entryId)
    if (removed) forgetEntry(existing.entryId)
    return { ok: true, removed, entryId: existing.entryId }
  }

  const entryId = String(payload?.entryId || '')
  if (!entryId.startsWith(prefix)) throw new Error(`不是本插件创建的连接：${entryId}`)
  const removed = removeEntry(loader, entryId)
  if (removed) forgetEntry(entryId)
  return { ok: true, removed, entryId }
}

async function toggleConnector(ctx, payload, { prefix = ENTRY_PREFIX } = {}) {
  const loader = requireLoader(ctx)
  const enabled = payload?.enabled === undefined ? true : Boolean(payload.enabled)
  let entryId
  if (prefix === ENTRY_PREFIX) {
    const connector = findConnector(String(payload?.id || ''))
    if (!connector) throw new Error(`未知连接器：${payload?.id}`)
    const existing = resolveConnectorEntry(connector, collectMcpEntries(loader))
    if (!existing) throw new Error('这条连接还不存在')
    entryId = existing.entryId
  } else {
    entryId = String(payload?.entryId || '')
    if (!entryId.startsWith(prefix)) throw new Error(`不是本插件创建的连接：${entryId}`)
  }
  if (!entryExists(loader, entryId)) throw new Error('这条连接还不存在')
  await setEntryEnabled(loader, entryId, enabled)
  // 启停位也要落盘，否则重启后自定义连接会按旧状态复活。
  const options = collectMcpEntries(loader).get(entryId)
  rememberEnabled(entryId, enabled, entryId.startsWith(CUSTOM_PREFIX) ? options?.config : undefined)
  return { ok: true, entryId, enabled }
}

async function connectCustom(ctx, payload) {
  const loader = requireLoader(ctx)
  const config = buildCustomConfig(payload || {})
  const entryId = payload?.entryId || customEntryId(config.serverName)
  if (entryId.startsWith(ENTRY_PREFIX)) throw new Error('自定义连接的 entryId 不能用内置前缀')
  for (const [existing, options] of collectMcpEntries(loader)) {
    if (existing === entryId) continue
    if (options?.config?.serverName === config.serverName) {
      throw new Error(`serverName「${config.serverName}」已被 ${existing} 占用，换一个名字再连`)
    }
  }
  const result = await provisionEntry(loader, entryId, config)
  rememberEntry(result.entryId || entryId, { config, disabled: false })
  return { ok: true, ...result, serverName: config.serverName }
}

function safeTail(text, lines = 12) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  return trimmed.split(/\r?\n/).slice(-lines).join('\n')
}

/* ------------------------------------------------------------------ *
 * Catalog routes
 * ------------------------------------------------------------------ */

const DISCOVERY = { dingtalk: discoverDingTalk, feishu: discoverFeishu }

function surfaceOrThrow(id) {
  const surface = DISCOVERY[id]
  if (!surface) throw new Error(`surface 只支持 dingtalk / feishu，收到：${id}`)
  return surface
}

async function loadEntries(id, { refresh = false } = {}) {
  const cache = peekCache(id)
  if (!refresh && cache.entries.length > 0) {
    return { entries: cache.entries, fetchedAt: cache.fetchedAt, stale: cache.stale, source: 'cache' }
  }
  const slot = await surfaceOrThrow(id)(runCli, { force: refresh })
  return {
    entries: slot.entries || [],
    fetchedAt: slot.fetchedAt || 0,
    stale: false,
    source: refresh ? 'cli' : cache.entries.length > 0 ? 'cache' : 'cli',
    error: slot.error || null,
  }
}

async function handleState() {
  const [health, meego] = await Promise.all([probeHealth(), meegoState()])
  const surfaces = SURFACES.map((surface) => {
    if (surface.id === 'meego') {
      return {
        ...surface,
        kind: 'official',
        ready: meego.ready,
        catalogSize: null,
        materialised: null,
        meego,
      }
    }
    const cache = peekCache(surface.id)
    const config = effectiveConfig()
    // The MCP child gets CHATOPS_TOOL_* from cordis.patch.yml, not from this Host process,
    // so derive the preview from the configured spec (default 'auto') rather than the
    // env-only helper — otherwise a healthy surface reads as "disabled".
    const products = productsFor(surface.id, config.products)
    let materialised = null
    if (cache.entries.length > 0) {
      const picked = selectEntries(surface.id, cache.entries, {
        reserved: staticNames(surface.id),
        products: config.products,
        effect: config.effect,
        max: config.max,
      })
      materialised = { count: picked.entries.length, reason: picked.reason }
    }
    return {
      ...surface,
      kind: 'cli',
      ready: Boolean(health[surface.id]?.loggedIn),
      catalogSize: cache.entries.length,
      catalogFetchedAt: cache.fetchedAt || null,
      catalogStale: cache.stale,
      materialised,
      products,
      config,
    }
  })

  return {
    surfaces,
    config: effectiveConfig(),
    cacheDir: cacheDirPath(),
    cacheTtlMs: cacheTtlMs(),
    health,
  }
}

/**
 * Static (hand-written) tool names per surface, used as reserved keys when previewing.
 * Kept in sync with server.js by name only — the preview does not need the schemas.
 */
const STATIC_NAMES = {
  dingtalk: [
    'dingtalk_catalog', 'dingtalk_schema', 'dingtalk_whoami', 'dingtalk_user_search',
    'dingtalk_user_get', 'dingtalk_dept_members', 'dingtalk_send_message', 'dingtalk_list_messages',
    'dingtalk_list_groups', 'dingtalk_calendar_events', 'dingtalk_calendar_create',
    'dingtalk_todo_list', 'dingtalk_todo_create', 'dingtalk_approval_pending',
    'dingtalk_approval_detail', 'dingtalk_drive_list', 'dingtalk_cli',
  ],
  feishu: [
    'feishu_catalog', 'feishu_schema', 'feishu_whoami', 'feishu_user_search', 'feishu_user_get',
    'feishu_chat_list', 'feishu_messages_list', 'feishu_message_search', 'feishu_send_message',
    'feishu_calendar_agenda', 'feishu_task_create', 'feishu_my_tasks', 'feishu_doc_fetch',
    'feishu_drive_search', 'feishu_cli',
  ],
}

function staticNames(id) {
  return new Set(STATIC_NAMES[id] || [])
}

function parseCatalogRows(id, entries, params) {
  const summary = catalogSummary(entries, {
    query: params.get('query') || undefined,
    product: params.get('product') || undefined,
    effect: params.get('effect') || undefined,
    limit: Number(params.get('limit') || 60),
  })
  return {
    surface: id,
    ...summary,
    products: catalogProducts(entries),
  }
}

function previewTools(id, entries, params) {
  const productsRaw = params.get('products')
  const effectRaw = params.get('effect')
  const maxRaw = params.get('max')
  const picked = selectEntries(id, entries, {
    reserved: staticNames(id),
    products: productsRaw === null ? undefined : productsRaw,
    effect: effectRaw === null ? undefined : effectRaw,
    max: maxRaw === null || maxRaw === '' ? undefined : Number(maxRaw),
  })
  return {
    surface: id,
    total: entries.length,
    count: picked.entries.length,
    reason: picked.reason,
    max: maxRaw ? Number(maxRaw) : maxTools(),
    tools: picked.entries.map((entry) => ({
      name: entry.name,
      cli: entry.cliPath,
      product: entry.product,
      effect: entry.effect,
      ...(entry.destructive ? { destructive: true } : {}),
      summary: entry.summary,
    })),
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function handle(req, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  const method = req.method ?? 'GET'
  const params = url.searchParams

  const readJson = async () => {
    const text = await readBody(req)
    if (!text.trim()) return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('请求体不是合法 JSON')
    }
  }

  if (method === 'GET' && sub === '/state') {
    return { status: 200, body: await handleState() }
  }

  /* ── 连接器 ─────────────────────────────────────────────────────── */

  if (method === 'GET' && sub === '/connectors') {
    return { status: 200, body: connectorsPayload(ctx) }
  }

  if (method === 'POST' && sub === '/connectors/connect') {
    return { status: 200, body: await quickConnect(ctx, await readJson()) }
  }

  if (method === 'POST' && sub === '/connectors/disconnect') {
    return { status: 200, body: await disconnectConnector(ctx, await readJson()) }
  }

  if (method === 'POST' && sub === '/connectors/toggle') {
    return { status: 200, body: await toggleConnector(ctx, await readJson()) }
  }

  if (method === 'POST' && sub === '/connectors/install') {
    const payload = await readJson()
    const connector = findConnector(String(payload?.id || ''))
    if (!connector) throw new Error(`未知连接器：${payload?.id}`)
    const result = await installCli(connector)
    return { status: 200, body: { ...result, output: safeTail(result.output) } }
  }

  if (method === 'POST' && sub === '/connectors/login') {
    const payload = await readJson()
    const connector = findConnector(String(payload?.id || ''))
    if (!connector) throw new Error(`未知连接器：${payload?.id}`)
    return { status: 200, body: await startLogin(connector) }
  }

  if (method === 'POST' && sub === '/connectors/login/finish') {
    const payload = await readJson()
    const connector = findConnector(String(payload?.id || ''))
    if (!connector) throw new Error(`未知连接器：${payload?.id}`)
    return { status: 200, body: await finishLogin(connector, payload) }
  }

  if (method === 'POST' && sub === '/connectors/logout') {
    const payload = await readJson()
    const connector = findConnector(String(payload?.id || ''))
    if (!connector) throw new Error(`未知连接器：${payload?.id}`)
    return { status: 200, body: await logout(connector) }
  }

  if (method === 'POST' && sub === '/connectors/token') {
    const payload = await readJson()
    const connector = findConnector(String(payload?.id || ''))
    if (!connector) throw new Error(`未知连接器：${payload?.id}`)
    if (connector.kind !== 'token' || !connector.tokenSpec) throw new Error(`${connector.name} 不需要令牌`)
    const token = String(payload?.token || '').trim()
    if (!token) throw new Error('令牌不能为空')
    const file = writeMeegoToken(connector.tokenSpec, token)
    // 已经连上的话，把新令牌通过 loader.update 推到运行中的 MCP 子进程：
    // meego-launch.js 在启动时读 env 文件，光改文件不重启不会生效。
    const loader = ctx.get('loader')
    let restarted = false
    let entryId = null
    if (loader) {
      const existing = resolveConnectorEntry(connector, collectMcpEntries(loader))
      if (existing) {
        entryId = existing.entryId
        const config = buildCatalogConfig(connector, {})
        await provisionEntry(loader, entryId, config)
        rememberEntry(entryId, { config, disabled: false })
        restarted = true
      }
    }
    return { status: 200, body: { ok: true, envFile: file, restarted, entryId } }
  }

  /* ── 自定义连接 ─────────────────────────────────────────────────── */

  if (method === 'POST' && sub === '/custom') {
    return { status: 200, body: await connectCustom(ctx, await readJson()) }
  }

  if (method === 'POST' && sub === '/custom/json') {
    const payload = await readJson()
    const specs = parseMcpJson(payload?.json ?? payload?.text ?? '')
    // 一条失败不影响其他条：逐条收集结果，面板把失败原因逐条显示。
    const results = []
    for (const spec of specs) {
      try {
        const result = await connectCustom(ctx, spec)
        results.push({ ok: true, serverName: spec.serverName, entryId: result.entryId, created: result.created })
      } catch (error) {
        results.push({ ok: false, serverName: spec.serverName, error: error.message })
      }
    }
    const failed = results.filter((item) => !item.ok)
    return {
      status: 200,
      body: { ok: failed.length === 0, total: results.length, succeeded: results.length - failed.length, results },
    }
  }

  if (method === 'POST' && sub === '/custom/remove') {
    return { status: 200, body: await disconnectConnector(ctx, await readJson(), { prefix: CUSTOM_PREFIX }) }
  }

  if (method === 'POST' && sub === '/custom/toggle') {
    return { status: 200, body: await toggleConnector(ctx, await readJson(), { prefix: CUSTOM_PREFIX }) }
  }

  /* ── 观测类 ─────────────────────────────────────────────────────── */

  if (method === 'GET' && sub === '/health') {
    return { status: 200, body: await probeHealth({ force: params.get('force') === '1' }) }
  }

  if (method === 'GET' && sub === '/catalog') {
    const id = params.get('surface') || 'dingtalk'
    const loaded = await loadEntries(id, { refresh: params.get('refresh') === '1' })
    const body = parseCatalogRows(id, loaded.entries, params)
    return {
      status: 200,
      body: {
        ...body,
        source: loaded.source,
        fetchedAt: loaded.fetchedAt || null,
        stale: loaded.stale,
        error: loaded.error || null,
      },
    }
  }

  if (method === 'GET' && sub === '/schema') {
    const id = params.get('surface') || 'dingtalk'
    const loaded = await loadEntries(id)
    const entry = findEntry(loaded.entries, params.get('command'))
    if (!entry) return { status: 404, body: { error: `目录里没有这个命令：${params.get('command')}` } }
    return { status: 200, body: schemaDetail(entry) }
  }

  if (method === 'GET' && sub === '/tools') {
    const id = params.get('surface') || 'dingtalk'
    const loaded = await loadEntries(id)
    return {
      status: 200,
      body: {
        ...previewTools(id, loaded.entries, params),
        fetchedAt: loaded.fetchedAt || null,
        source: loaded.source,
      },
    }
  }

  if (method === 'POST' && sub === '/refresh') {
    const payload = await readJson()
    const id = payload.surface || 'dingtalk'
    const slot = await surfaceOrThrow(id)(runCli, { force: true })
    return {
      status: 200,
      body: {
        surface: id,
        count: (slot.entries || []).length,
        fetchedAt: slot.fetchedAt || null,
        error: slot.error || null,
      },
    }
  }

  return { status: 404, body: { error: `未知接口：${method} ${sub}` } }
}

function apply(ctx) {
  // 顺序：迁移旧 key → 按连接表重建 → 补内置三条 → 开路由。
  // 补内置三条是 v1.6.0 的新步骤：patch 里不再预置 mcp-client 行（那些行必须带本机绝对路径，
  // 别人装上跑不起来），改由这里用可移植路径 provision。前置条件不满足就先不建，等用户点 `+`。
  ctx.effect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const loader = ctx.get('loader')
        if (!loader) return
        migrateStoreKeys()
        const report = await rehydrate(loader)
        const seeded = await seedBuiltins(loader)
        if (!cancelled) {
          const parts = []
          if (report.restored.length) parts.push(`重建 ${report.restored.length} 条`)
          if (report.failed.length) parts.push(`失败 ${report.failed.length} 条`)
          if (seeded.seeded.length) parts.push(`初始化 ${seeded.seeded.join('、')}`)
          if (parts.length) ctx.logger?.info?.(`chatops-mcp-panel: 连接表 — ${parts.join('，')}`)
        }
        rehydrateReport = { ...report, seeded: seeded.seeded, seedFailed: seeded.failed }
      } catch (error) {
        rehydrateReport = {
          restored: [],
          resumed: [],
          failed: [{ entryId: '*', error: error instanceof Error ? error.message : String(error) }],
          seeded: [],
          seedFailed: [],
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, 'chatops-mcp-panel: rehydrate connections')

  // patch 重新应用会把内置三条的 disabled 位刷回 patch 默认值，
  // 所以每次 config-reload 之后都按我们的 store 再压一遍。
  ctx.on('app-boot/config-reload', () => {
    void (async () => {
      try {
        const loader = ctx.get('loader')
        if (!loader) return
        const fixed = await applyStoredFlags(loader)
        if (fixed.length) ctx.logger?.info?.(`chatops-mcp-panel: 已恢复 ${fixed.length} 条连接的启停位`)
      } catch {
        /* 恢复启停位失败不影响插件其他功能 */
      }
    })()
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            const { status, body } = await handle(req, ctx)
            return sendJson(res, status, body)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return sendJson(res, 400, { error: message })
          }
        },
      }),
    'chatops-mcp-panel: routes',
  )
}

export { apply, inject, name }
