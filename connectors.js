/**
 * connectors.js — 连接器内核：目录、探活、装 CLI、登录、写入 / 移除 MCP 行。
 *
 * 设计要点（为什么这么写）：
 *
 * 1. 一行 MCP 配置就是 Loader 树里的一个 entry。`ctx.loader.create/remove/update`
 *    会即时挂载 / 卸载 MCP server，工具立刻可用 —— 但它**只改内存根树**，
 *    `Loader.write()` 是空实现，所以重启就丢。真正写盘的是 cordis-plugin-include 的
 *    `Include.write()`，而它写的是 `applyPatches(this.data)` 的结果，我们 create 的行
 *    不在里面（实测 create 成功后 profile 的 cordis.yml 仍是 223 字节的 `[]`）。
 *    因此本包自己记一张表（见第 5 段持久化），启动时按表重建。
 *
 * 2. 凭据不落地到配置里。飞书项目那种 user token 写进
 *    `~/.dsh/chatops/meego/.env`，由 meego-launch.js 在导入官方服务器前读出来；
 *    配置行里只放空字符串占位，connections.json 里也只存 env 键名，不存值。
 *
 * 3. 钉钉 / 飞书复用本机 CLI 的登录态（~/.dws、~/.lark-cli），不在插件里存任何
 *    密钥。没装 CLI 就调 npm 全局装，没登录就走各自的设备码流程。
 *
 * 4. 所有子进程都走 `windowsHide: true` + 原生 exe（见 cli.js 的注释），
 *    否则 dsh 这种无控制台进程会闪黑窗口。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCli, resolveGlobalFile, runCli } from './cli.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_JS = join(HERE, 'server.js')
const MEEGO_LAUNCH_JS = join(HERE, 'meego-launch.js')

/** Loader entry id 前缀。改成别的会丢掉已有连接，不要动。 */
export const ENTRY_PREFIX = 'chatops-conn-'
export const CUSTOM_PREFIX = 'chatops-custom-'

const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'

/* ------------------------------------------------------------------ *
 * 1. 内置连接器目录
 * ------------------------------------------------------------------ */

/**
 * `kind` 决定「连接」时做什么：
 *   - `cli`   ：本机有 CLI，wrap 成 stdio MCP（钉钉 / 飞书）
 *   - `token` ：没有 CLI，只需要一个 user token（飞书项目 / 官方服务器）
 */
export const CATALOG = [
  {
    id: 'dingtalk',
    name: '钉钉',
    vendor: 'DingTalk',
    category: '办公协作',
    badge: '钉',
    badgeColor: '#1677ff',
    summary: '通过命令行管理钉钉全产品能力：AI 表格、考勤、日历、群聊与机器人、通讯录、文档、待办、审批、钉盘、听记。',
    homepage: 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli',
    kind: 'cli',
    cliKind: 'dws',
    cliPackage: 'dingtalk-workspace-cli',
    cliBin: 'dws',
    serverName: 'dingtalk',
    args: [SERVER_JS, 'dingtalk'],
    env: {
      CHATOPS_TOOL_PRODUCTS: 'auto',
      CHATOPS_TOOL_EFFECT: 'all',
      CHATOPS_MAX_TOOLS: '30',
    },
    toolCallTimeoutMs: 90000,
    prompts: [
      '在钉钉群【产品周会】里用机器人发一条通知：今天 15:00 在 3 楼会议室开周会，记得带上本周的进展材料',
      '查一下我下周的钉钉日程，列出和【客户对接】相关的会议，并帮我找出三人空闲的时段约一次同步会',
      '在钉钉 AI 表格【任务跟踪】里新增一行：标题=Q2 上线评审、负责人=张三、截止时间=2026-05-20、状态=进行中',
    ],
  },
  {
    id: 'feishu',
    name: '飞书',
    vendor: 'Lark / 飞书',
    category: '办公协作',
    badge: '飞',
    badgeColor: '#3370ff',
    summary: '通过命令行管理飞书 / Lark 全产品能力：消息与群聊、日历、任务、通讯录、云文档、云空间、审批、知识库、表格、妙记。',
    homepage: 'https://github.com/larksuite/cli',
    kind: 'cli',
    cliKind: 'lark-cli',
    cliPackage: '@larksuite/cli',
    cliBin: 'lark-cli',
    serverName: 'feishu',
    args: [SERVER_JS, 'feishu'],
    env: {
      CHATOPS_TOOL_PRODUCTS: 'auto',
      CHATOPS_TOOL_EFFECT: 'all',
      CHATOPS_MAX_TOOLS: '30',
    },
    toolCallTimeoutMs: 90000,
    prompts: [
      '把这份周报发到飞书群【信息科技部】，并且 @ 一下张工看下接口字段',
      '查一下我今天的飞书日程，如果 14:00 有空就约一个 30 分钟的需求澄清会，参会人是李四和王五',
      '在飞书云文档里找一下标题包含「租赁」的文档，把最近修改的三篇列出来并给出链接',
    ],
  },
  {
    id: 'meego',
    name: '飞书项目',
    vendor: 'Lark Project / Meego',
    category: '研发管理',
    badge: '项',
    badgeColor: '#00b96b',
    summary: '飞书项目（Meego）官方 MCP：需求 / 缺陷 / 迭代 / 排期、字段与角色、工作项检索（MQL）、WBS、评论、工时。',
    homepage: 'https://project.feishu.cn',
    kind: 'token',
    serverName: 'meego',
    args: [MEEGO_LAUNCH_JS],
    env: {},
    toolCallTimeoutMs: 120000,
    tokenSpec: {
      label: 'MCP 用户令牌',
      envKeys: ['MCP_USER_TOKEN', 'MEEGO_MCP_USER_TOKEN', 'MCP_TOKEN'],
      envFile: () => join(homedir(), '.dsh', 'chatops', 'meego', '.env'),
      placeholder: 'm-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      help: '飞书项目 → 开放平台 → 我的插件 → MCP 服务，复制 MCP 用户令牌（形如 m-…）。令牌只写到本机 ~/.dsh/chatops/meego/.env。',
    },
    prompts: [
      '查一下飞书项目里我负责的、还没完成的需求和任务，按截止时间排一下',
      '把需求 7124005234 的内容和当前节点进度总结成五条要点',
      '在【项目空间】里新建一个缺陷：标题、优先级 P1、指派给张工',
    ],
  },
]

export function findConnector(id) {
  return CATALOG.find((item) => item.id === id) || null
}

/* ------------------------------------------------------------------ *
 * 2. 探活：CLI 是否装了、是否登录、token 在不在
 * ------------------------------------------------------------------ */

/** 在 PATH 里找一个可执行文件（Windows 带 .exe / .cmd）。 */
function findOnPath(bin) {
  const pathValue = process.env.PATH || ''
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* 权限问题跳过 */
      }
    }
  }
  return null
}

/** CLI 可执行路径；优先走 cli.js 的解析（内含原生 exe 优先策略）。 */
export function cliLocation(cliKind) {
  const resolved = resolveCli(cliKind)
  if (resolved.mode !== 'path') return resolved.path
  return findOnPath(cliKind === 'dws' ? 'dws' : 'lark-cli')
}

/**
 * 真正的 node 可执行文件。
 *
 * 不能用 `process.execPath`：宿主跑在 Electron 里时它是 `DeepSeek Harness.exe`，
 * 把这个值写进 mcp-client 行的 `command` 会让子进程拿不到 node 语义（实测写出来的
 * command 就是 `D:\DeepSeek Harness\DeepSeek Harness.exe`，重启后起不来）。
 * 顺序：CHATOPS_NODE_BIN → PATH 里的 node → 非 Electron 时的 process.execPath。
 */
export function nodeCommand() {
  const override = process.env.CHATOPS_NODE_BIN
  if (override && existsSync(override)) return override
  const fromPath = findOnPath('node')
  if (fromPath) return fromPath
  if (!process.versions.electron) return process.execPath
  return 'node'
}

/**
 * 纠正历史脏数据：v1.5.3 及以前把 `process.execPath` 写进了 `command`，
 * 宿主在 Electron 里跑时它等于 `D:\DeepSeek Harness\DeepSeek Harness.exe`，
 * 重启后拿这个值 spawn 根本起不来（store 里已经躺了一条这样的记录）。
 *
 * 只纠正这一种形状 —— 用户自己填的 npx / python / 别的 node 路径一律原样保留。
 */
export function fixNodeCommand(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config
  const command = config.command
  if (typeof command !== 'string' || !command) return config
  const isElectronSelf = Boolean(process.versions.electron) && command === process.execPath
  const isHarnessExe = /[\\/]DeepSeek Harness\.exe$/i.test(command)
  if (!isElectronSelf && !isHarnessExe) return config
  return { ...config, command: nodeCommand() }
}

export function cliInstalled(cliKind) {
  return Boolean(cliLocation(cliKind))
}

/** 读飞书项目 token：环境变量优先，其次 env 文件。 */
export function readMeegoToken(spec) {
  for (const key of spec.envKeys) {
    const value = process.env[key]
    if (value && value.trim()) return { source: 'environment', value: value.trim() }
  }
  const file = spec.envFile()
  if (!existsSync(file)) return { source: null, value: null, file }
  const text = readFileSync(file, 'utf8')
  const pattern = new RegExp(`^\\s*(?:${spec.envKeys.join('|')})\\s*=\\s*(.+)$`, 'm')
  const match = text.match(pattern)
  if (!match) return { source: null, value: null, file }
  return { source: file, value: match[1].trim().replace(/^['"]|['"]$/g, ''), file }
}

/** 把 token 写进 env 文件（会保留文件里其他键）。 */
export function writeMeegoToken(spec, token) {
  const file = spec.envFile()
  mkdirSync(dirname(file), { recursive: true })
  const key = spec.envKeys[0]
  const lines = []
  const existing = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const kept = existing.filter((line) => line.trim() && !spec.envKeys.some((k) => new RegExp(`^\\s*${k}\\s*=`).test(line)))
  kept.push(`${key}=${token}`)
  for (const line of kept) lines.push(line)
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  return file
}

export function maskToken(value) {
  const text = String(value || '')
  if (!text) return null
  if (text.length <= 10) return '***'
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

/**
 * 找出某个内置连接器当前对应的 MCP 行。
 *
 * 不能只按 `chatops-conn-<id>` 找：bundle 自带的 cordis.patch.yml 用的是
 * `chatops-mcp-<id>`，而面板写的是 `chatops-conn-<id>`，两者 serverName 相同。
 * serverName 才是「这条连接是谁」的真正身份（dsh 也按它给工具加前缀），
 * 所以按 serverName 匹配，谁先占就管谁 —— 否则 patch 行明明在跑、
 * 卡片却显示「未连接」，用户点连接还会撞 serverName 冲突。
 */
export function resolveConnectorEntry(connector, entries) {
  const preferred = ENTRY_PREFIX + connector.id
  const direct = entries.get(preferred)
  if (direct) return { entryId: preferred, options: direct }
  for (const [entryId, options] of entries) {
    if (options?.config?.serverName === connector.serverName) return { entryId, options }
  }
  return null
}

/**
 * 一条连接器的完整状态。`entries` 是 loader 里现存的 mcp-client 行（Map<entryId, options>）。
 * 只读：不触发任何 CLI 登录、不写配置。
 */
export function connectorState(connector, entries, toolCounts) {
  const resolved = resolveConnectorEntry(connector, entries)
  const entry = resolved?.options || null
  const entryId = resolved?.entryId || null
  const serverName = entry?.config?.serverName || connector.serverName

  const base = {
    id: connector.id,
    name: connector.name,
    vendor: connector.vendor,
    category: connector.category,
    summary: connector.summary,
    badge: connector.badge,
    badgeColor: connector.badgeColor,
    homepage: connector.homepage,
    kind: connector.kind,
    connected: Boolean(entry),
    enabled: entry ? entry.disabled !== true : false,
    entryId,
    serverName,
    toolCount: toolCounts?.[serverName] || 0,
    prompts: connector.prompts || [],
  }

  if (connector.kind === 'cli') {
    const cliPath = cliLocation(connector.cliKind)
    return {
      ...base,
      cli: {
        kind: connector.cliKind,
        package: connector.cliPackage,
        bin: connector.cliBin,
        installed: Boolean(cliPath),
        path: cliPath,
      },
      ready: Boolean(cliPath),
      needs: cliPath ? [] : ['install'],
    }
  }

  const token = readMeegoToken(connector.tokenSpec)
  return {
    ...base,
    token: {
      label: connector.tokenSpec.label,
      placeholder: connector.tokenSpec.placeholder,
      help: connector.tokenSpec.help,
      envFile: connector.tokenSpec.envFile(),
      present: Boolean(token.value),
      source: token.source,
      hint: maskToken(token.value),
    },
    ready: Boolean(token.value),
    needs: token.value ? [] : ['token'],
  }
}

/* ------------------------------------------------------------------ *
 * 3. 装 CLI
 * ------------------------------------------------------------------ */

function npmCliJs() {
  // npm 装在 node 旁边，所以要用真实 node 的目录，不能用 Electron 的 execPath。
  const nodeDir = dirname(nodeCommand())
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'npm', 'bin', 'npm-cli.js'),
    // Unix 布局：<prefix>/bin/node → <prefix>/lib/node_modules/npm
    join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/** 跑一条命令并收集输出（windowsHide，避免黑窗口）。 */
function run(command, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      })
    } catch (error) {
      resolve({ ok: false, text: '', stderr: String(error?.message || error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve({ ok: false, text: stdout, stderr: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, text: stdout, stderr: String(error?.message || error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, text: stdout, stderr })
    })
  })
}

/**
 * 全局安装 CLI。npm 的全局 prefix 在本机是 D:\nvm\node_global（dws / lark-cli
 * 就装在那里），所以装完 resolveCli 立刻能解析到。
 */
export async function installCli(connector) {
  if (connector.kind !== 'cli') throw new Error(`${connector.name} 不是 CLI 连接器`)
  if (cliInstalled(connector.cliKind)) {
    return { ok: true, alreadyInstalled: true, path: cliLocation(connector.cliKind) }
  }
  const npmCli = npmCliJs()
  if (!npmCli) throw new Error('找不到 npm-cli.js，无法自动安装 CLI；请手动执行 npm i -g ' + connector.cliPackage)
  const result = await run(nodeCommand(), [npmCli, 'install', '-g', connector.cliPackage, '--no-fund', '--no-audit'])
  const path = cliInstalled(connector.cliKind) ? cliLocation(connector.cliKind) : null
  const tail = [result.text, result.stderr].filter(Boolean).join('\n').trim().split('\n').slice(-14).join('\n')
  return { ok: Boolean(path), installed: Boolean(path), path, exitCode: result.code, output: tail }
}

/* ------------------------------------------------------------------ *
 * 4. 登录
 * ------------------------------------------------------------------ */

const loginSessions = new Map()

/** 钉钉设备流：横幅里带 user_code 和验证链接，进程会一直轮询到授权完成。 */
function parseDwsDeviceBanner(text) {
  const code = text.match(/authorization code:\s*([A-Z0-9][A-Z0-9-]{4,})/i)?.[1] || null
  const url =
    text.match(/https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm[^\s|]*/)?.[0] ||
    (code ? `https://login.dingtalk.com/oauth2/device/verify.htm?user_code=${code}` : null)
  const expires = text.match(/expire in (\d+) seconds/i)?.[1]
  return { code, url: url ? url.split(/\s/)[0] : null, expiresIn: expires ? Number(expires) : null }
}

function startDwsLogin() {
  const cli = cliLocation('dws')
  if (!cli) throw new Error('钉钉 CLI 还没装，先点「安装 CLI」')
  const isScript = /\.(c|m)?js$/i.test(cli)
  const command = isScript ? nodeCommand() : cli
  const args = isScript
    ? [cli, 'auth', 'login', '--device', '--no-browser', '--recommend']
    : ['auth', 'login', '--device', '--no-browser', '--recommend']

  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env })
  const session = { child, buffer: '', info: null, startedAt: Date.now() }
  loginSessions.set('dws', session)

  const onData = (chunk) => {
    session.buffer += chunk.toString('utf8')
    if (!session.info) {
      const parsed = parseDwsDeviceBanner(session.buffer)
      if (parsed.code && parsed.url) session.info = parsed
    }
    if (session.buffer.length > 200000) session.buffer = session.buffer.slice(-20000)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('close', () => {
    session.closed = true
  })
  child.on('error', () => {
    session.closed = true
  })
  return session
}

function stopSession(key) {
  const session = loginSessions.get(key)
  if (!session) return
  try {
    session.child.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  loginSessions.delete(key)
}

/** 等钉钉横幅出现验证码（最多等 20 秒）。 */
async function waitDwsInfo(session) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (session.info) return session.info
    if (session.closed) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (session.info) return session.info
  const parsed = parseDwsDeviceBanner(session.buffer)
  return parsed.code ? parsed : null
}

async function dwsAuthStatus() {
  const result = await runCli('dws', ['auth', 'status', '--format', 'json'], { timeoutMs: 25000 })
  const json = result.json || null
  return {
    ok: Boolean(json?.authenticated),
    authenticated: Boolean(json?.authenticated),
    tokenValid: Boolean(json?.token_valid),
    expiresAt: json?.expires_at || null,
    user: json?.user_name || null,
    corp: json?.corp_name || null,
    raw: json,
  }
}

async function larkAuthStatus() {
  const result = await runCli('lark-cli', ['auth', 'status'], { timeoutMs: 25000 })
  const json = result.json || null
  const user = json?.identities?.user || json?.identities || null
  const status = user?.status || json?.tokenStatus || null
  return {
    ok: status === 'ready' || status === 'valid',
    status,
    user: user?.userName || json?.onBehalfOf?.userName || null,
    openId: user?.openId || json?.onBehalfOf?.openId || null,
    raw: json,
  }
}

/**
 * 开始登录。
 *  - 钉钉：spawn 设备流进程，解析横幅里的验证码，进程留在后台轮询
 *  - 飞书：`--no-wait --json` 立刻返回 device_code + verification_url（非阻塞）
 */
export async function startLogin(connector) {
  if (connector.kind !== 'cli') throw new Error(`${connector.name} 用令牌连接，不需要登录`)

  if (connector.cliKind === 'dws') {
    const status = await dwsAuthStatus()
    if (status.authenticated) return { mode: 'already', ...status }
    stopSession('dws')
    const session = startDwsLogin()
    const info = await waitDwsInfo(session)
    if (!info) {
      const tail = session.buffer.trim().split('\n').slice(-12).join('\n')
      stopSession('dws')
      throw new Error(`没能从 dws 输出里取到设备码。原始输出：\n${tail}`)
    }
    return { mode: 'device', code: info.code, url: info.url, expiresIn: info.expiresIn, provider: 'dingtalk' }
  }

  const status = await larkAuthStatus()
  if (status.ok) return { mode: 'already', ...status }
  const result = await runCli(
    'lark-cli',
    ['auth', 'login', '--no-wait', '--json', '--recommend'],
    { timeoutMs: 60000 },
  )
  const json = result.json
  if (!json?.device_code) {
    throw new Error(`lark-cli auth login 没有返回 device_code：${(result.stderr || result.text || '').slice(0, 600)}`)
  }
  loginSessions.set('lark', { deviceCode: json.device_code, startedAt: Date.now() })
  return {
    mode: 'device',
    code: json.user_code || null,
    url: json.verification_url || null,
    expiresIn: json.expires_in || null,
    deviceCode: json.device_code,
    provider: 'feishu',
  }
}

/**
 * 完成登录 / 复查登录。
 * 飞书必须拿 device_code 去换 token；钉钉只需要复查 auth status（后台进程会自己回写）。
 */
export async function finishLogin(connector, payload = {}) {
  if (connector.kind !== 'cli') throw new Error(`${connector.name} 用令牌连接，不需要登录`)

  if (connector.cliKind === 'dws') {
    const status = await dwsAuthStatus()
    if (status.authenticated) {
      stopSession('dws')
      return { ok: true, ...status }
    }
    return { ok: false, reason: '还没检测到授权完成，请在浏览器里完成授权后再点一次「已授权」。', ...status }
  }

  const deviceCode = payload.deviceCode || payload.device_code || loginSessions.get('lark')?.deviceCode
  if (!deviceCode) throw new Error('缺少 device_code，请重新点「连接」获取新的验证链接')
  const result = await runCli(
    'lark-cli',
    ['auth', 'login', '--device-code', String(deviceCode), '--json'],
    { timeoutMs: 120000 },
  )
  const status = await larkAuthStatus()
  loginSessions.delete('lark')
  if (!status.ok) {
    const detail = (result.stderr || result.text || '').slice(0, 600)
    return { ok: false, reason: `授权还没完成或已过期。${detail}`, ...status }
  }
  return { ok: true, ...status }
}

/** 退出登录（连接器详情里的「退出登录」）。 */
export async function logout(connector) {
  if (connector.kind !== 'cli') return { ok: true }
  if (connector.cliKind === 'dws') {
    const result = await runCli('dws', ['auth', 'logout', '--format', 'json'], { timeoutMs: 30000 })
    return { ok: result.ok, output: (result.text || result.stderr || '').slice(0, 400) }
  }
  const result = await runCli('lark-cli', ['auth', 'logout', '--json'], { timeoutMs: 30000 })
  return { ok: result.ok, output: (result.text || result.stderr || '').slice(0, 400) }
}

/* ------------------------------------------------------------------ *
 * 5. 写入 / 移除 MCP 行
 * ------------------------------------------------------------------ */

export function isServerName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value)
}

/** 内置连接器的 mcp-client 配置。 */
export function buildCatalogConfig(connector, overrides = {}) {
  const config = {
    serverName: overrides.serverName || connector.serverName,
    transport: 'stdio',
    command: nodeCommand(),
    args: [...connector.args],
    cwd: HERE,
    env: { ...connector.env },
    toolCallTimeoutMs: connector.toolCallTimeoutMs || 90000,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  }
  // 只有 meego 需要转发 token 环境变量；值留空，真正的 token 在 env 文件里。
  if (connector.kind === 'token' && connector.tokenSpec) {
    config.env = { [connector.tokenSpec.envKeys[0]]: process.env[connector.tokenSpec.envKeys[0]] || '' }
  }
  return config
}

/** 自定义连接的配置：stdio 或 streamable-http。 */
export function buildCustomConfig(input) {
  const serverName = String(input.serverName || '').trim()
  if (!isServerName(serverName)) {
    throw new Error('serverName 只能包含字母、数字、下划线和短横线，长度 1–32')
  }
  const transport = input.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const toolCallTimeoutMs = Number(input.toolCallTimeoutMs) > 0 ? Number(input.toolCallTimeoutMs) : 60000

  if (transport === 'streamable-http') {
    const url = String(input.url || '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('HTTP 连接的 url 必须以 http:// 或 https:// 开头')
    const headers = {}
    if (input.headers && typeof input.headers === 'object') {
      for (const [key, value] of Object.entries(input.headers)) {
        if (key && value !== undefined && value !== null && String(value) !== '') headers[key] = String(value)
      }
    }
    return {
      serverName,
      transport,
      url,
      headers,
      toolCallTimeoutMs,
      failOnStartupError: false,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
    }
  }

  const command = String(input.command || '').trim()
  if (!command) throw new Error('stdio 连接必须填 command')
  const args = Array.isArray(input.args)
    ? input.args.map((item) => String(item)).filter((item) => item !== '')
    : String(input.args || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
  const env = {}
  if (input.env && typeof input.env === 'object') {
    for (const [key, value] of Object.entries(input.env)) {
      if (key && value !== undefined && value !== null && String(value) !== '') env[key] = String(value)
    }
  }
  return {
    serverName,
    transport,
    command,
    args,
    env,
    ...(input.cwd ? { cwd: String(input.cwd) } : {}),
    toolCallTimeoutMs,
    failOnStartupError: false,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  }
}

/** `type` / `transport` 的各种写法都归一化到 dsh 认识的两个值。 */
function normalizeTransport(spec) {
  const raw = String(spec?.transport || spec?.type || '').trim().toLowerCase()
  if (raw === 'stdio') return 'stdio'
  if (raw === 'streamable-http' || raw === 'streamablehttp' || raw === 'http' || raw === 'sse') return 'streamable-http'
  // 没写就看有没有 url：有 url 就是远程，否则按本地进程处理。
  return spec?.url ? 'streamable-http' : 'stdio'
}

/**
 * 把用户粘贴的 MCP JSON 拆成若干条待连接配置。
 *
 * 支持的形状（都能混着来，一次贴多个也能全建）：
 *   { "mcpServers": { "a": {...}, "b": {...} } }   ← workbuddy / claude 的标准写法
 *   { "a": {...} }                                  ← 省略 mcpServers 外壳
 *   { "serverName": "a", "command": "npx", ... }    ← 直接一条
 *   [ {...}, {...} ]                                ← 数组
 *
 * 单条里的 `type: "streamableHttp"` 会转成 dsh 的 `transport: "streamable-http"`，
 * `timeout` 转成 `toolCallTimeoutMs`，`disabled` 被忽略（新连的一律启用）。
 *
 * @param {string} text 用户粘贴的原文
 * @returns {Array<object>} 可直接喂给 buildCustomConfig 的输入
 */
export function parseMcpJson(text) {
  const source = String(text || '').trim()
  if (!source) throw new Error('先粘贴一段 MCP JSON')

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`JSON 解析失败：${error.message}`)
  }

  // 先摊平成 [serverName, spec] 对。
  const pairs = []
  const pushSpec = (name, spec) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`「${name}」对应的值必须是一个对象`)
    }
    pairs.push([String(name || '').trim(), spec])
  }

  const collect = (node) => {
    if (!node || typeof node !== 'object') throw new Error('顶层必须是一个 JSON 对象或数组')
    if (Array.isArray(node)) {
      for (const item of node) collect(item)
      return
    }
    // 标准外壳
    if (node.mcpServers && typeof node.mcpServers === 'object' && !Array.isArray(node.mcpServers)) {
      for (const [name, spec] of Object.entries(node.mcpServers)) pushSpec(name, spec)
      return
    }
    // 已经是单条（自带 serverName / command / url）
    if (node.serverName || node.command || node.url) {
      pushSpec(node.serverName || node.name, node)
      return
    }
    // 省略外壳：{ "a": {...}, "b": {...} }
    const entries = Object.entries(node).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    if (!entries.length) throw new Error('没找到任何 MCP 服务定义，检查一下 JSON 结构')
    for (const [name, spec] of entries) pushSpec(name, spec)
  }
  collect(parsed)

  if (!pairs.length) throw new Error('没找到任何 MCP 服务定义')

  return pairs.map(([name, spec]) => {
    const out = {
      serverName: name || spec.serverName || spec.name || '',
      transport: normalizeTransport(spec),
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
      url: spec.url,
      headers: spec.headers,
      toolCallTimeoutMs: spec.toolCallTimeoutMs ?? spec.timeout,
    }
    // 提前跑一遍校验，哪条不合法就在粘贴这一步报出来，别等到写 Loader 才发现。
    buildCustomConfig(out)
    return out
  })
}

/**
 * 把一行 mcp-client 写进 Loader 树（存在则更新）。返回 entryId。
 * 注意：`ctx.loader.create` 的 id 是显式给的，不依赖 loader 的随机 id，
 * 这样「断开连接」时能精确 resolve 到同一行。
 */
export async function provisionEntry(loader, entryId, config) {
  const has = (() => {
    try {
      loader.resolve(entryId)
      return true
    } catch {
      return false
    }
  })()
  if (has) {
    await loader.update(entryId, { config, disabled: false })
    return { entryId, created: false }
  }
  const createdId = await loader.create({ id: entryId, name: MCP_CLIENT_NAME, config, disabled: false })
  return { entryId: createdId || entryId, created: true }
}

export function entryExists(loader, entryId) {
  try {
    loader.resolve(entryId)
    return true
  } catch {
    return false
  }
}

export function removeEntry(loader, entryId) {
  if (!entryExists(loader, entryId)) return false
  loader.remove(entryId)
  return true
}

export function setEntryEnabled(loader, entryId, enabled) {
  const entry = loader.resolve(entryId)
  return entry.update({ disabled: !enabled }, false, true)
}

/**
 * 收集 Loader 里所有 mcp-client 行：Map<entryId, EntryOptions>。
 * 只取本插件与用户自建的（有 name 且是 mcp-client），不碰别的插件。
 */
export function collectMcpEntries(loader) {
  const map = new Map()
  try {
    for (const entry of loader.entries()) {
      if (entry?.options?.name !== MCP_CLIENT_NAME) continue
      map.set(entry.id, entry.options)
    }
  } catch {
    /* loader 不可枚举时返回空表，面板显示 0 条 */
  }
  return map
}

/** 统计每个 serverName 在当前可见工具表里注册了多少个工具。 */
export function countToolsByServer(tools) {
  const counts = {}
  try {
    for (const schema of tools.schemas()) {
      const match = /^mcp__([A-Za-z0-9_-]+?)__/.exec(schema.name || '')
      if (!match) continue
      counts[match[1]] = (counts[match[1]] || 0) + 1
    }
  } catch {
    /* tools 服务不可用时返回空表 */
  }
  return counts
}

/** 自定义连接在面板上的展示形状（不含凭据值）。 */
export function customState(entryId, options, toolCounts) {
  const config = options?.config || {}
  const serverName = config.serverName || entryId
  const transport = config.transport || 'stdio'
  return {
    entryId,
    serverName,
    transport,
    disabled: Boolean(options?.disabled),
    toolCount: toolCounts?.[serverName] || 0,
    target:
      transport === 'streamable-http'
        ? config.url || ''
        : [config.command, ...(Array.isArray(config.args) ? config.args : [])].filter(Boolean).join(' '),
    envKeys: config.env && typeof config.env === 'object' ? Object.keys(config.env) : [],
    headerKeys: config.headers && typeof config.headers === 'object' ? Object.keys(config.headers) : [],
    cwd: config.cwd || null,
    toolCallTimeoutMs: config.toolCallTimeoutMs || null,
  }
}

/** 自定义连接：把面板上的输入规整成一个安全的 entryId。 */
export function customEntryId(serverName) {
  const slug = String(serverName)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return CUSTOM_PREFIX + (slug || Math.random().toString(16).slice(2, 8))
}

/* ------------------------------------------------------------------ *
 * 5. 自有持久化：Loader 的根树是内存态，重启会丢
 * ------------------------------------------------------------------ */

/**
 * 为什么需要这一层（实测结论，别删）：
 *
 * `ctx.loader.create/remove/update` 改的是 Loader 自己的根树，
 * 而 `Loader.write()` 是**空实现**（`Loader's root tree is in-memory; writes are no-ops`）。
 * desktop profile 的 `cordis.yml` 是一个 `cordis:include` 子节点，但它挂在
 * `--patch` 组合出来的树上，我们 create 的行并不会被写回那个文件
 * —— 实测 create 成功后 `cordis.yml` 仍是 223 字节的 `[]`。
 *
 * 后果：连接、断开、启停全部只在本次进程内有效，重启就没了。
 * 所以本插件自己落一份小 JSON（`~/.dsh/chatops/connections.json`），
 * 启动时按它把行重建进 Loader。`dsh-mcp-connector` 用的是 storageDomain，
 * 我们不想为此引入它的依赖，一个纯 JSON 文件够了。
 *
 * 只存「本插件负责的行」：内置三条 + 自定义连接。别的插件的 mcp-client 行不碰。
 */
export function storeFile() {
  return process.env.CHATOPS_CONNECTION_STORE || join(homedir(), '.dsh', 'chatops', 'connections.json')
}

function readStoreRaw() {
  const file = storeFile()
  try {
    if (!existsSync(file)) return { version: 1, entries: {} }
    // 记事本另存为会加 BOM，JSON.parse 直接抛 —— 剥掉再解析。
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    const entries = parsed && typeof parsed.entries === 'object' && parsed.entries ? parsed.entries : {}
    return { version: 1, entries }
  } catch {
    // 文件坏了不能让插件起不来：当作空表，下一次写入会覆盖掉坏文件。
    return { version: 1, entries: {} }
  }
}

function writeStoreRaw(store) {
  const file = storeFile()
  mkdirSync(dirname(file), { recursive: true })
  const sorted = { version: 1, entries: {} }
  for (const key of Object.keys(store.entries).sort()) sorted.entries[key] = store.entries[key]
  writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
  return file
}

/** 记下一条连接（config 里可能含 token，所以调用方必须自己脱敏后再传）。 */
export function rememberEntry(entryId, { config, disabled = false }) {
  const store = readStoreRaw()
  store.entries[entryId] = { name: MCP_CLIENT_NAME, config, disabled: Boolean(disabled) }
  writeStoreRaw(store)
  return entryId
}

/**
 * 只更新启停位，不动 config（内置行来自 patch，config 不归我们管）。
 *
 * `config: null` 是有意义的：表示「只记启停，不要重建这一行」。
 * 内置的三条来自 bundle 的 cordis.patch.yml，行由 dsh 自己挂；
 * 我们只关心用户有没有把它停用，重启后按这个把 disabled 位恢复回去。
 */
export function rememberEnabled(entryId, enabled, hintConfig) {
  const store = readStoreRaw()
  const current = store.entries[entryId]
  if (!current) {
    store.entries[entryId] = { name: MCP_CLIENT_NAME, config: hintConfig || null, disabled: !enabled }
  } else {
    current.disabled = !enabled
    if (!current.config && hintConfig) current.config = hintConfig
  }
  writeStoreRaw(store)
  return entryId
}

export function forgetEntry(entryId) {
  const store = readStoreRaw()
  if (!store.entries[entryId]) return false
  delete store.entries[entryId]
  writeStoreRaw(store)
  return true
}

/**
 * 把旧版本写在 store 里的 entryId 迁到新形状。
 *
 * 为什么不兼容旧 key：v1.5.x 及以前，内置三条来自 bundle 的 `cordis.patch.yml`，
 * 它们的 id 经父 include 前缀后长这样 —— `include:chatops-mcp-dingtalk`。
 * v1.6.0 起 patch 里不再写死任何 mcp-client 行（那些行必须带本机绝对路径，
 * 别人装上跑不起来），内置三条改由本包自己 provision，id 变成 `chatops-conn-dingtalk`。
 * 旧 key 里带 `:`，`loader.resolve` 会按 `:` 分段下钻而失败，所以必须换掉。
 *
 * 只迁启停位（config 置 null，不拿旧配置重建）—— 新配置由 seedBuiltins 用
 * 可移植路径重新生成。
 */
export function migrateStoreKeys() {
  const store = readStoreRaw()
  let changed = false
  for (const key of Object.keys(store.entries)) {
    if (!key.includes(':')) continue
    const tail = key.split(':').pop() || ''
    const known = CATALOG.find((item) => tail === `chatops-mcp-${item.id}` || tail === `chatops-conn-${item.id}`)
    if (!known) continue
    const nextKey = `${ENTRY_PREFIX}${known.id}`
    const previous = store.entries[key]
    if (!store.entries[nextKey]) {
      store.entries[nextKey] = { name: MCP_CLIENT_NAME, config: null, disabled: Boolean(previous?.disabled) }
    }
    delete store.entries[key]
    changed = true
  }
  if (changed) writeStoreRaw(store)
  return changed
}

/**
 * 内置连接器的「开箱即用」。
 *
 * patch 里不再预置 mcp-client 行，所以启动时要自己补：只要前置条件满足
 * （CLI 装好 / 令牌已填），就把行建起来；不满足就留空，等用户点 `+`。
 * 这样任何人 clone + 安装后都不需要改任何配置。
 */
export async function seedBuiltins(loader) {
  const report = { seeded: [], skipped: [], failed: [] }
  if (!loader) return report
  const store = readStoreRaw()
  let dirty = false
  for (const connector of CATALOG) {
    try {
      const ready =
        connector.kind === 'cli'
          ? Boolean(cliLocation(connector.cliKind))
          : Boolean(readMeegoToken(connector.tokenSpec).value)
      if (!ready) {
        report.skipped.push(connector.id)
        continue
      }
      const entryId = resolveConnectorEntry(connector, collectMcpEntries(loader))?.entryId || `${ENTRY_PREFIX}${connector.id}`
      const disabled = Boolean(store.entries[entryId]?.disabled)
      // 配置一律按 CATALOG 现算，不沿用 store 里存的那份 —— 否则升级后改的默认值
      // （比如把 CHATOPS_TOOL_EFFECT 从 read 改成 all）永远追不上老用户。
      const config = buildCatalogConfig(connector)
      await provisionEntry(loader, entryId, config)
      rememberEntry(entryId, { config, disabled })
      report.seeded.push(connector.id)
      dirty = true
    } catch (error) {
      report.failed.push({ id: connector.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (dirty) report.persisted = true
  return report
}

/**
 * 启动时把 store 里的行重建进 Loader。
 *
 * - 行已存在（patch 行，或 HMR 重载时还在）→ 只按 store 恢复启停位，不重建。
 * - 行不存在（自定义连接，或用户删过 patch）→ 用存下的 config 重新 create。
 *
 * 返回 `{restored, resumed, failed[]}` 供面板/日志查看。
 */
export async function rehydrate(loader) {
  const report = { restored: [], resumed: [], failed: [] }
  if (!loader) return report
  const store = readStoreRaw()
  let dirty = false
  for (const [entryId, record] of Object.entries(store.entries)) {
    if (!record || record.name !== MCP_CLIENT_NAME) continue
    try {
      // store 里可能还躺着旧版本写进去的错误 command（Electron 的 execPath），先纠正。
      const config = fixNodeCommand(record.config)
      if (config !== record.config) {
        record.config = config
        dirty = true
      }
      if (entryExists(loader, entryId)) {
        const entry = loader.resolve(entryId)
        if (Boolean(entry.options?.disabled) !== Boolean(record.disabled)) {
          await entry.update({ disabled: Boolean(record.disabled) }, false, true)
        }
        report.resumed.push(entryId)
        continue
      }
      if (!config || typeof config !== 'object') continue
      await loader.create({ id: entryId, name: MCP_CLIENT_NAME, config, disabled: Boolean(record.disabled) })
      report.restored.push(entryId)
    } catch (error) {
      report.failed.push({ entryId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (dirty) {
    try {
      writeStoreRaw(store)
      report.repaired = true
    } catch {
      /* 写不进去不影响本次重建 */
    }
  }
  return report
}

/**
 * 只把「存在行的启停位」按 store 恢复一遍，不 create 任何东西。
 *
 * 为什么 rehydrate 之外还要这一层：bundle 的 `cordis.patch.yml` 里有内置三条的原文，
 * dsh 在 `app-boot/config-reload` 时会把 patch **重新应用**到 include 上 ——
 * 那一轮会拿 patch 里的原文覆盖整份 options，`disabled` 就回到 patch 的默认值（没有 = 启用）。
 * 我们的 apply() 比这次 reload 早，所以刚设好的 disabled 会被抹掉。
 *
 * 实测证据：重启后 `rehydrate` 报告 `resumed: ['include:chatops-mcp-dingtalk']`、
 * store 里 `disabled: true`，但面板显示 `enabled: true / tools: 47` —— 就是被 reload 盖回去了。
 * 所以这个函数要挂在 `app-boot/config-reload` 上再跑一次。
 */
export async function applyStoredFlags(loader) {
  const fixed = []
  if (!loader) return fixed
  const store = readStoreRaw()
  for (const [entryId, record] of Object.entries(store.entries)) {
    if (!record || record.name !== MCP_CLIENT_NAME) continue
    try {
      if (!entryExists(loader, entryId)) continue
      const entry = loader.resolve(entryId)
      if (Boolean(entry.options?.disabled) === Boolean(record.disabled)) continue
      await entry.update({ disabled: Boolean(record.disabled) }, false, true)
      fixed.push(entryId)
    } catch {
      /* 单行失败不影响其他行；下次 reload 还会再试 */
    }
  }
  return fixed
}

export { MCP_CLIENT_NAME, HERE as PACKAGE_DIR }
