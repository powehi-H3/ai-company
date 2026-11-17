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
import crypto from 'node:crypto'

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
      if (!g.ref && n.ref) g.ref = n.ref          // 合并时保留首个非空 ref（审查 P1-7）
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
const CONSENT_MAX = 5000
export function issueConsent(action, payload, ttlMs = 60000) {
  // 加密随机（审查 P1-2：Math.random 可预测）
  const token = 'consent_' + crypto.randomBytes(16).toString('hex')
  const now = Date.now()
  // 回收：超额或过期即清理（审查 P2-2：Map 只增不减）
  if (CONSENTS.size >= CONSENT_MAX) {
    for (const [k, v] of CONSENTS) if (v.expire < now || v.used) CONSENTS.delete(k)
    if (CONSENTS.size >= CONSENT_MAX) {
      const first = CONSENTS.keys().next().value
      if (first) CONSENTS.delete(first)
    }
  }
  CONSENTS.set(token, { action, payload: JSON.stringify(payload), expire: now + ttlMs, used: false })
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
  const add = (id, label, type, space, ref) => nodes.push({ id, label, type, space, ref })

  const exists = data.existsRel || (() => true)
  // 项目空间 → 穿透到该项目的主文件（按优先级探测，避免"无原文"）
  const firstFileOf = data.firstFileOf || null
  const projects = [...(data.projects?.doing || []), ...(data.projects?.done || [])]
  for (const p of projects) {
    const base = (data.projects?.doing || []).some(x => x.name === p.name)
      ? '20-项目区/进行中' : '20-项目区/已完成'
    const cands = ['00-主线与进度.md', '00-项目说明.md', 'README.md', '00-人员分配表.md', '00-启动检查清单.md']
    let rel = ''
    for (const c of cands) {
      if (exists(`${base}/${p.name}/${c}`)) { rel = `${base}/${p.name}/${c}`; break }
    }
    if (!rel && firstFileOf) rel = firstFileOf(`${base}/${p.name}`) || ''
    add(p.name, p.name, 'project', 'project', rel)
  }
  // 部门/AI 空间 → 穿透到员工档案（名字可能不一致，用候选探测）
  for (const s of data.seats || []) {
    const cands = [`40-档案室/01-员工档案/${s.who}.md`, `40-档案室/01-员工档案/${s.who.trim()}.md`]
    let rel = ''
    for (const c of cands) if (exists(c)) { rel = c; break }
    // 名字对不上时，反向找档案文件名里包含该名字的
    if (!rel) rel = data.findArchive ? (data.findArchive(s.who) || '') : ''
    add(s.who, s.who, 'ai', 'dept', rel)
  }
  // 知识空间：对话/产出 → 穿透到原文
  for (const n of data.graphNodes || []) {
    if (n.type === 'chat' || n.type === 'artifact') add(n.id, n.label, n.type, 'knowledge', n.ref)
  }
  // 公司空间 → 穿透到对应总文件（不再是无处可去的数字）
  add('rules', `${data.ruleTotal} 条规矩`, 'metric', 'company', '00-公司规则.md')
  add('docs', `${data.docs?.length || 0} 份文档`, 'metric', 'company', 'SKILLS.md')

  // 修正不存在的穿透目标（避免点了没东西）
  for (const n of nodes) {
    if (n.ref && !exists(n.ref)) n.ref = ''
  }

  const federated = dedupe(federate(nodes))
  const layers = SPACES.map(s => ({
    ...s,
    count: federated.filter(n => n.spaces.includes(s.id)).length,
  }))
  return { spaces: federated, layers, stats: { total: federated.length, layers: layers.length } }
}

// ══════ ⑤ 真实干预引擎（借鉴 agentguard 风险分级+审计）══════

// 动作风险分级（来自第2搜：Permission Firewall 的 read_file vs delete_database）
export const ACTIONS = {
  setStatus: { risk: 'low',    zh: '改状态', desc: '把问题条目从待处理改为处理中/已完成' },
  // 以下留接口不开放（高风险，授权闸门先于 I/O）
  moveFile:  { risk: 'high',   zh: '移动文件', desc: '跨空间迁移（暂不开放）' },
  deleteItem:{ risk: 'critical',zh: '删除条目', desc: '删除问题条目（暂不开放）' },
}
export function riskOf(action) {
  const a = ACTIONS[action]
  if (!a) return { risk: 'unknown', allowed: false }
  return { ...a, allowed: a.risk === 'low' }  // 当前只开放低风险
}

// 生成审计记录（append-only，host 负责落盘）
// 借鉴 Permission Firewall 的 ALLOWED/BLOCKED/PENDING_APPROVAL + UTC 时间戳
export function auditRecord(action, payload, outcome, detail = '') {
  // target 优先取条目编号；payload 里没有 target 字段时（干预场景）用 id
  const target = payload?.target || payload?.id || ''
  return {
    at: new Date().toISOString(),   // UTC 时间戳
    action,
    target,
    file: payload?.file || '',
    toStatus: payload?.toStatus || '',
    risk: riskOf(action).risk,
    outcome,                        // PENDING_APPROVAL | ALLOWED | BLOCKED
    detail,
  }
}

// 预览：把"改状态"这个动作渲染成人类可读的两段式说明（dry-run）
// fromStatus 必须由调用方从实际文件探测后传入，否则会误导（默认值仅兜底）
export function previewAction(action, payload) {
  if (action === 'setStatus') {
    const from = payload.fromStatus || '（未探测）'
    return {
      action, risk: 'low',
      title: `将「${payload.title || payload.id || '?'}」的状态改为 ${payload.toStatus}`,
      lines: [
        `文件：${payload.file || '(未提供)'}`,
        `编号：${payload.id || '?'}`,
        `当前 → 目标：${from} → ${payload.toStatus}`,
      ],
      reversible: true,
    }
  }
  return { action, risk: riskOf(action).risk, title: '不支持的动作', lines: [], reversible: false }
}

// 区块标题表（单一来源，detectSection 与 applyStatusChange 共用 —— 审查 P2-6）
export const SECTION_HEADS = {
  '待处理': ['## 待处理', '## 一、待处理'],
  '处理中': ['## 处理中', '## 二、处理中'],
  '已完成': ['## 已完成', '## 三、已完成', '## 三、已完成（留痕，不删除）'],
}
// 判断一行是否属于某区块标题（精确匹配标题，忽略尾部空白）
function matchSection(line) {
  const t = line.trim()
  for (const [name, heads] of Object.entries(SECTION_HEADS)) {
    if (heads.some(h => t === h || t.startsWith(h + '（') || t.startsWith(h + '('))) return name
  }
  return null
}
// 探测某编号当前所在区块（供预览显示真实 fromStatus）
export function detectSection(text, id) {
  const lines = text.split('\n')
  let cur = ''
  for (const l of lines) {
    const m = matchSection(l)
    if (m) { cur = m; continue }
    // 遇到其它 ## 标题 → 未知区块，重置（审查 P2-10）
    if (/^##\s+/.test(l.trim())) { cur = '未知'; continue }
    // 锚定行首条目（审查 P1-3：避免正文引用误命中）
    if (l.trim().startsWith(`- [${id}]`)) return cur || '未知'
  }
  return '未找到'
}

// 纯函数：在一段问题池 md 文本里，把指定编号条目的状态区块移动（待处理↔处理中↔已完成）
// 返回新文本；不改原文本。host 拿到新文本后原子写回。
export function applyStatusChange(text, id, toStatus) {
  const lines = text.split('\n')
  const findSection = (name) => {
    for (let i = 0; i < lines.length; i++) if (matchSection(lines[i]) === name) return i
    return -1
  }
  // 锚定行首条目，避免正文引用误命中（审查 P1-3）
  const hits = []
  for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith(`- [${id}]`)) hits.push(i)
  if (hits.length === 0) return { ok: false, reason: '找不到条目 ' + id }
  if (hits.length > 1) return { ok: false, reason: `编号 ${id} 在文件中出现 ${hits.length} 次，请先人工去重` }
  const idx = hits[0]
  const line = lines[idx]
  const rest = line.trim().replace(/^-\s+/, '')   // 只剥行首 "- "，保留其余内容
  lines.splice(idx, 1)
  let toIdx = findSection(toStatus)
  const hadSection = toIdx >= 0
  if (!hadSection) {
    const header = (SECTION_HEADS[toStatus] || [`## ${toStatus}`])[0]
    let lastH = -1
    for (let i = 0; i < lines.length; i++) if (/^##\s+/.test(lines[i])) lastH = i
    const insertAt = lastH >= 0 ? lastH + 1 : lines.length
    lines.splice(insertAt, 0, '', header, '')
    toIdx = findSection(toStatus)
    if (toIdx < 0) return { ok: false, reason: '无法创建目标区块 ' + toStatus }
  }
  lines.splice(toIdx + 1, 0, '- ' + rest)
  return { ok: true, text: lines.join('\n'), movedLine: line.trim(), createdSection: !hadSection }
}
