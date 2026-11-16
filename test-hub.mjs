/**
 * Hub 模板自检：每一项都必须能过 buildCustomConfig 的校验，
 * 否则面板上「安装」按钮点下去会在后端第一步就报错。
 *
 * 跑法：node tools/dsh-chatops-mcp/test-hub.mjs
 */
import { HUB, HUB_CATEGORIES, hubInstallPayload, findHubItem, iconForServer } from './hub.js'
import { buildCustomConfig, CATALOG } from './connectors.js'

const problems = []
const seen = new Set()

for (const item of HUB) {
  if (seen.has(item.id)) problems.push(`重复 id：${item.id}`)
  seen.add(item.id)

  for (const key of ['id', 'name', 'vendor', 'category', 'badge', 'badgeColor', 'summary', 'transport']) {
    if (!item[key]) problems.push(`${item.id} 缺字段 ${key}`)
  }
  if (!HUB_CATEGORIES.includes(item.category)) problems.push(`${item.id} 分类不在 HUB_CATEGORIES：${item.category}`)
  if (!item.icon) problems.push(`${item.id} 缺 icon，面板会回落成两字母块`)

  const payload = hubInstallPayload(item)

  // 内置项（钉钉 / 飞书 / 飞书项目）不是模板：参数由 connectors.js 在运行时现算，
  // 这里只能断言「它没有 install 载荷」+「connectorId 能在 CATALOG 里找到」。
  if (item.builtin) {
    if (payload !== null) problems.push(`${item.id} 是内置项，hubInstallPayload 应返回 null`)
    if (!item.connectorId) problems.push(`${item.id} 是内置项但没有 connectorId`)
    else if (!CATALOG.some((c) => c.id === item.connectorId)) {
      problems.push(`${item.id} 的 connectorId「${item.connectorId}」不在 CATALOG`)
    }
    continue
  }

  if (payload === null) {
    problems.push(`${item.id} 不是内置项，hubInstallPayload 不该返回 null`)
    continue
  }
  try {
    const config = buildCustomConfig(payload)
    if (config.transport === 'streamable-http') {
      if (!/^https?:\/\//.test(config.url)) problems.push(`${item.id} http 配置没有合法 url`)
    } else {
      if (!config.command) problems.push(`${item.id} stdio 配置没有 command`)
    }
    if (payload.env && Object.values(payload.env).some((value) => value !== '')) {
      problems.push(`${item.id} 模板 env 里有非空示例值，会被当真实凭据写进配置`)
    }
    if (payload.headers && Object.values(payload.headers).some((value) => value !== '')) {
      problems.push(`${item.id} 模板 headers 里有非空示例值`)
    }
    if ((item.envKeys || []).length) {
      const declared = new Set((item.envKeys || []).map((f) => f.key))
      const carried = new Set(Object.keys(payload.env || {}))
      for (const key of declared) if (!carried.has(key)) problems.push(`${item.id} envKeys 声明的 ${key} 没进 payload.env`)
    }
  } catch (error) {
    problems.push(`${item.id} buildCustomConfig 失败：${error.message}`)
  }
}

// 边界：未知 id 必须返回 null，面板据此判断「不是 Hub 项」。
if (findHubItem('nope') !== null) problems.push('findHubItem 对未知 id 应返回 null')

// 品牌图标映射：内置三条必须认得出来，未知 serverName 回落到 null（面板用首字母块）。
for (const name of ['dingtalk', 'feishu', 'meego', 'filesystem', 'github']) {
  if (!iconForServer(name)) problems.push(`iconForServer('${name}') 应返回图标 key`)
}
if (iconForServer('someone-custom-server') !== null) problems.push('iconForServer 对未知 serverName 应返回 null')

// 内置三条的图标不能撞车（撞车等于两个服务看起来一样）。
const builtinIcons = HUB.filter((item) => item.builtin).map((item) => item.icon)
if (new Set(builtinIcons).size !== builtinIcons.length) problems.push('内置项的 icon key 有重复')

const byTransport = HUB.reduce((acc, item) => ({ ...acc, [item.transport]: (acc[item.transport] || 0) + 1 }), {})
const builtinCount = HUB.filter((item) => item.builtin).length
console.log(`Hub 项：${HUB.length}（内置 ${builtinCount} + 模板 ${HUB.length - builtinCount}；${Object.entries(byTransport).map(([k, v]) => `${k} ${v}`).join(' / ')}）`)
console.log(`分类：${HUB_CATEGORIES.length}`)
if (problems.length) {
  console.log('\n问题：')
  for (const line of problems) console.log(' - ' + line)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
