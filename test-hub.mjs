/**
 * Hub 模板自检：每一项都必须能过 buildCustomConfig 的校验，
 * 否则面板上「安装」按钮点下去会在后端第一步就报错。
 *
 * 跑法：node tools/dsh-chatops-mcp/test-hub.mjs
 */
import { HUB, HUB_CATEGORIES, hubInstallPayload, findHubItem } from './hub.js'
import { buildCustomConfig } from './connectors.js'

const problems = []
const seen = new Set()

for (const item of HUB) {
  if (seen.has(item.id)) problems.push(`重复 id：${item.id}`)
  seen.add(item.id)

  for (const key of ['id', 'name', 'vendor', 'category', 'badge', 'badgeColor', 'summary', 'transport']) {
    if (!item[key]) problems.push(`${item.id} 缺字段 ${key}`)
  }
  if (!HUB_CATEGORIES.includes(item.category)) problems.push(`${item.id} 分类不在 HUB_CATEGORIES：${item.category}`)

  const payload = hubInstallPayload(item)
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

const byTransport = HUB.reduce((acc, item) => ({ ...acc, [item.transport]: (acc[item.transport] || 0) + 1 }), {})
console.log(`Hub 项：${HUB.length}（${Object.entries(byTransport).map(([k, v]) => `${k} ${v}`).join(' / ')}）`)
console.log(`分类：${HUB_CATEGORIES.length}`)
if (problems.length) {
  console.log('\n问题：')
  for (const line of problems) console.log(' - ' + line)
  process.exitCode = 1
} else {
  console.log('全部通过')
}
