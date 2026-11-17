/**
 * 空间引擎 · 阶段④ P4（借鉴 dsh-Layers-Orchestrator 设计）
 *
 * 四个核心能力（来自第2搜轮子调研，见 06-功能测试区/已查清单-空间引擎调研.md）：
 *   1. spaceRouter  —— 空间路由：spaceId → 物理目录，懒解析，非法 id fail-fast
 *   2. federation   —— 标签联邦：同名实体跨空间合并为一个全局节点，spaces[] 记来源
 *   3. dedupe       —— 内容去重：content_hash 认领，避免跨空间重复
 *   4. consent      —— 授权闸门：干预/迁移类操作需显式授权（一次性 token、TTL）
 *
 * 与 Layers-Orchestrator 的差异：
 *   它面向"记忆空间联邦"（海马体），本引擎面向"项目多维俯瞰"；
 *   保持零依赖、纯函数、可单测，不依赖任何运行时宿主。
 *
 * 用法（host 端 collect 引入）：
 *   import { SPACES, routeSpace, federate, buildOverview, issueConsent, checkConsent } from './spaces.js'
 */
import path from 'node:path'

// ── 空间定义（B方案：正规多空间，物理复用现有目录）──
// 每个空间是一个"观察维度"，view 决定俯瞰时如何切片
export const SPACES = [
  { id: 'company', zh: '公司',   dir: '.',                          icon: '🏢', view: 'org'     },
  { id: 'dept',    zh: '部门',   dir: '10-办公区',                  icon: '🏛', view: 'org'     },
  { id: 'project', zh: '项目',   dir: '20-项目区',                  icon: '📁', view: 'project' },
  { id: 'task',    zh: '任务',   dir: '30-会议室',                  icon: '📌', view: 'flow'    },
  { id: 'knowledge',zh:'知识',   dir: '60-工具与备份/知识库',        icon: '📚', view: 'graph'   },
  { id: 'temp',    zh: '临时',   dir: '40-档案室',                  icon: '🗂', view: 'archive' },
]

const BY_ID = new Map(SPACES.map(s => [s.id, s]))

// 1. 空间路由：非法 id fail-fast
export function routeSpace(spaceId, root) {
  const s = BY_ID.get(spaceId)
  if (!s) throw Object.assign(new Error(`MEM_E_SPACE_INVALID: ${spaceId}`), { code: 'MEM_E_SPACE_INVALID' })
  return { ...s, abs: path.join(root, s.dir) }
}

// 2. 标签联邦：同一实体跨空间出现多次 → 合并成一个全局节点，spaces[] 记录来源
//    nodes: [{ id, label, type, space }]
export function federate(nodes) {
  const map = new Map()
  for (const n of nodes) {
    const key = `${n.type}:${n.id}`
    if (!map.has(key)) {
      map.set(key, { ...n, spaces: [n.space] })
    } else {
      const g = map.get(key)
      if (!g.spaces.includes(n.space)) g.spaces.push(n.space)
      // 合并来自更多空间的证据：spaces 数多的信息更可信
      g.weight = (g.weight || 1) + 1
    }
  }
  return [...map.values()].map(g => ({ ...g, weight: g.weight || 1 }))
}

// 3. 内容去重：content_hash 认领（同一内容只算一次）
export function dedupe(items) {
  const seen = new Set()
  return items.filter(it => {
    const h = it.contentHash || `${it.type}:${it.id}:${it.title || ''}`
    if (seen.has(h)) return false
    seen.add(h)
    return true
  })
}

// 4. 授权闸门：干预/迁移类操作需一次性 token（TTL 60s，单次消费）
const CONSENTS = new Map()
export function issueConsent(action, payload, ttlMs = 60000) {
  const token = 'consent_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  CONSENTS.set(token, { action, payload: JSON.stringify(payload), expire: Date.now() + ttlMs, used: false })
  return token
}
export function checkConsent(token, action, payload) {
  const c = CONSENTS.get(token)
  if (!c) return { ok: false, code: 'ORCH_E_CONSENT_REQUIRED', reason: '无授权令牌' }
  if (c.expire < Date.now()) { CONSENTS.delete(token); return { ok: false, code: 'ORCH_E_CONSENT_EXPIRED', reason: '授权过期' } }
  if (c.used) return { ok: false, code: 'ORCH_E_CONSENT_CONSUMED', reason: '授权已消费' }
  if (c.action !== action || c.payload !== JSON.stringify(payload))
    return { ok: false, code: 'ORCH_E_CONSENT_MISMATCH', reason: '授权与操作不匹配' }
  c.used = true  // 单次消费
  return { ok: true }
}

// 构建多维俯瞰：把 collect 的数据投影到 6 个空间视角
// data: collect() 的返回；返回 { spaces: [...], layers, stats }
export function buildOverview(data) {
  const nodes = []
  const add = (id, label, type, space) => nodes.push({ id, label, type, space })

  // 项目空间
  const projects = [...(data.projects?.doing || []), ...(data.projects?.done || [])]
  for (const p of projects) add(p.name, p.name, 'project', 'project')
  // 部门/AI 空间
  for (const s of data.seats || []) add(s.who, s.who, 'ai', 'dept')
  // 知识空间：事件流里的对话/产出（从关系图节点取）
  for (const n of data.graphNodes || []) {
    if (n.type === 'chat' || n.type === 'artifact') add(n.id, n.label, n.type, 'knowledge')
  }
  // 公司空间：规矩数、文档数作为节点
  add('rules', `${data.ruleTotal} 条规矩`, 'metric', 'company')
  add('docs', `${data.docs?.length || 0} 份文档`, 'metric', 'company')

  const federated = dedupe(federate(nodes))
  // 叠层：每个空间一层，统计层内节点数
  const layers = SPACES.map(s => ({
    ...s,
    count: federated.filter(n => n.spaces.includes(s.id)).length,
  }))
  return { spaces: federated, layers, stats: { total: federated.length, layers: layers.length } }
}
