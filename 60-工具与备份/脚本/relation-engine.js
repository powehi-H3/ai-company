#!/usr/bin/env node
/**
 * 关系引擎 · 阶段③（P3 关系引擎）
 *
 * 依据（见 06-功能测试区/已查清单-关系引擎.md）：
 *  - 第1搜·知识：Entity/Relation Extraction → 三元组(实体-关系-实体)；
 *    CQRS：write side(append-only 事件日志) 与 read side(可重建物化视图) 分离；
 *    稳定 id 保证幂等与可重放。
 *  - 第2搜·轮子：obsidian wikilink / backlinks / get_note_neighbors；
 *    enquire-mcp「graph as typed graph」；aul-local-folder-index「索引外部文件不搬移」。
 *    反向查询 = 邻接表 backlinks，不搬动原始文件。
 *
 * 事实源（write side）：
 *   1. 10-办公区/<部门-部门AI>/<项目名>/   → ai -[参与]-> project
 *   2. 各项目/事件流-日志.jsonl             → chat -[属于/产出]-> project
 *   3. 60-工具与备份/知识库/对话原文/<ai>/  → chat -[由]-> ai
 *
 * 产物（read side，可整体重建）：
 *   关系图-节点.jsonl / 关系图-边.jsonl / 关系图-视图.md / 关系查询-10秒接上.md
 *
 * 用法：
 *   node relation-engine.js --project AI公司软件化重构 [--dry-run] [--stats]
 *   node relation-engine.js --project AI公司软件化重构 --who 大肥鱼
 *   node relation-engine.js --project AI公司软件化重构 --project-query AI公司软件化重构
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const COMPANY = '/storage/emulated/0/AI专用文件夹/AI公司'
const OFFICE = path.join(COMPANY, '10-办公区')
const CORPUS = path.join(COMPANY, '60-工具与备份/知识库/对话原文')
const PROJ_ROOTS = ['20-项目区/进行中', '20-项目区/已完成', '20-项目区/已搁置']
const OUT_DIR = path.join(COMPANY, '20-项目区/进行中/AI公司软件化重构')

// AI 名称归一化（别名 → 规范名）
const AI_ALIASES = {
  'yg': 'YG', '董事长': 'YG', '秘书': 'YG',
  'dsh': 'DSH', '总经理': 'DSH', 'dsh-go': 'DSH',
  'chatgpt': 'ChatGPT', 'gpt': 'ChatGPT',
  'qwen': '通义千问', '千问': '通义千问', '通义千问': '通义千问',
  '大肥鱼': '大肥鱼', 'deepseek': '大肥鱼', 'ds': '大肥鱼',
  '豆包': '豆包', 'doubao': '豆包',
  'grok': 'Grok',
  'dsh分身': 'DSH分身', '分身': 'DSH分身',
}
function normAi(s) {
  const v = String(s || '').trim()
  return AI_ALIASES[v.toLowerCase()] || AI_ALIASES[v] || v
}
function stableId(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}
function exists(p) { try { fs.accessSync(p); return true } catch { return false } }

function args() {
  const a = process.argv.slice(2)
  const o = { project: 'AI公司软件化重构', dryRun: false, stats: false,
              who: null, projectQuery: null }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--project') o.project = a[++i]
    else if (a[i] === '--dry-run') o.dryRun = true
    else if (a[i] === '--stats') o.stats = true
    else if (a[i] === '--who') o.who = a[++i]
    else if (a[i] === '--project-query') o.projectQuery = a[++i]
  }
  return o
}

// ── 事实源 1：办公区 → ai 参与 project ──
function collectOfficeEdges() {
  const edges = []
  if (!exists(OFFICE)) return edges
  for (const dept of fs.readdirSync(OFFICE)) {
    const deptDir = path.join(OFFICE, dept)
    if (!fs.statSync(deptDir).isDirectory()) continue
    const ai = normAi(dept.split('-').pop())
    if (!ai) continue
    for (const proj of fs.readdirSync(deptDir)) {
      const pj = path.join(deptDir, proj)
      if (!fs.statSync(pj).isDirectory()) continue
      // 工位是预置模板（每 AI×每项目 1 个 README），只代表组织编制，不代表真实参与
      edges.push({
        id: stableId('ai', ai, 'staffed', 'proj', proj),
        from: `ai:${ai}`, rel: '工位编制', to: `proj:${proj}`,
        evidence: `办公区/${dept}/${proj}（预置工位，非参与证据）`,
      })
    }
  }
  return edges
}

// ── 找所有项目目录（用于扫描事件日志）──
function allProjects() {
  const out = []
  for (const rel of PROJ_ROOTS) {
    const root = path.join(COMPANY, rel)
    if (!exists(root)) continue
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name)
      if (fs.statSync(p).isDirectory()) out.push({ name, path: p })
    }
  }
  return out
}

// ── 事实源 2：事件日志 → chat/artifact 归属 project ──
function collectLogEdges(projects) {
  const edges = []
  const nodes = []
  for (const proj of projects) {
    const logPath = path.join(proj.path, '事件流-日志.jsonl')
    if (!exists(logPath)) continue
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'chat') {
        // ref: 对话原文/<ai>/<sid>，脱敏且非绝对路径
        const m = (ev.ref || '').match(/^对话原文\/([^/]+)\/([^/]+)$/)
        const ai = normAi(m ? m[1] : '')
        const sid = m ? m[2] : (ev.id || '')
        const cid = `chat:${sid.slice(0, 8)}`
        nodes.push({ id: cid, type: 'chat', label: ev.title || ('会话' + sid.slice(0, 8)), ref: ev.ref })
        edges.push({ id: stableId(cid, 'in_project', `proj:${proj.name}`),
                     from: cid, rel: '属于项目', to: `proj:${proj.name}`,
                     evidence: `事件日志/${proj.name}` })
        if (ai) {
          edges.push({ id: stableId(cid, 'by_ai', `ai:${ai}`),
                       from: cid, rel: '由AI产生', to: `ai:${ai}`,
                       evidence: `对话原文/${ai}` })
          // 真实参与：该 AI 的对话出现在该项目事件日志 = 有共现证据
          edges.push({ id: stableId('ai', ai, 'actual', 'proj', proj.name),
                       from: `ai:${ai}`, rel: '实际参与', to: `proj:${proj.name}`,
                       evidence: `事件日志/${proj.name} 中 ${ev.ref}` })
        }
      } else if (ev.type === 'artifact') {
        const aid = 'art:' + stableId(ev.ref || ev.title || ev.id)
        nodes.push({ id: aid, type: 'artifact', label: ev.title || ev.id, ref: ev.ref })
        edges.push({ id: stableId(aid, 'in_project', `proj:${proj.name}`),
                     from: aid, rel: '属于项目', to: `proj:${proj.name}`,
                     evidence: `事件日志/${proj.name}` })
      }
    }
  }
  return { edges, nodes }
}

// ── 事实源 3：对话框元数据 → chat 由 ai 产生（补充无事件日志的项目）──
function collectCorpusEdges() {
  const edges = []
  if (!exists(CORPUS)) return edges
  for (const aiDir of fs.readdirSync(CORPUS)) {
    const dir = path.join(CORPUS, aiDir)
    if (!fs.statSync(dir).isDirectory()) continue
    const ai = normAi(aiDir)
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const sid = f.replace(/\.md$/, '').split('__').pop().slice(0, 8)
      const cid = `chat:${sid}`
      edges.push({ id: stableId(cid, 'by_ai', `ai:${ai}`),
                   from: cid, rel: '由AI产生', to: `ai:${ai}`,
                   evidence: `对话原文/${aiDir}/${f}` })
    }
  }
  return edges
}

// ── 构建图（去重）──
function buildGraph() {
  const edgeMap = new Map()
  const nodeMap = new Map()
  const addEdge = (e) => { if (!edgeMap.has(e.id)) edgeMap.set(e.id, e) }
  const addNode = (n) => { if (!nodeMap.has(n.id)) nodeMap.set(n.id, n) }

  for (const e of collectOfficeEdges()) {
    addEdge(e)
    addNode({ id: e.from, type: e.from.split(':')[0], label: e.from.split(':')[1] })
    addNode({ id: e.to, type: e.to.split(':')[0], label: e.to.split(':')[1] })
  }
  const { edges, nodes } = collectLogEdges(allProjects())
  for (const n of nodes) addNode(n)
  for (const e of edges) {
    addEdge(e)
    addNode({ id: e.from, type: e.from.split(':')[0], label: e.from.split(':')[1] })
    addNode({ id: e.to, type: e.to.split(':')[0], label: e.to.split(':')[1] })
  }
  for (const e of collectCorpusEdges()) {
    addEdge(e)
    addNode({ id: e.from, type: 'chat', label: e.from.split(':')[1] })
    addNode({ id: e.to, type: 'ai', label: e.to.split(':')[1] })
  }
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] }
}

// ── 邻接表反向查询（backlinks 思路）──
function neighbors(graph, nodeId) {
  const out = []
  for (const e of graph.edges) {
    if (e.from === nodeId) out.push({ dir: '出', rel: e.rel, other: e.to })
    if (e.to === nodeId) out.push({ dir: '入', rel: e.rel, other: e.from })
  }
  return out
}
function answerWho(graph, aiName) {
  const ai = normAi(aiName)
  const id = `ai:${ai}`
  const ns = neighbors(graph, id)
  // neighbors() 不返回 rel，直接从边里取
  const actual = graph.edges.filter(e => e.from === id && e.rel === '实际参与')
                            .map(e => e.to.slice(5))
  const staffed = graph.edges.filter(e => e.from === id && e.rel === '工位编制')
                             .map(e => e.to.slice(5))
  const chats = graph.edges.filter(e => e.to === id && e.rel === '由AI产生')
                           .map(e => e.from.slice(5))
  return { ai, actualProjects: [...new Set(actual)], staffedProjects: [...new Set(staffed)],
           chatCount: new Set(chats).size }
}
function answerProject(graph, projName) {
  const id = `proj:${projName}`
  const actual = graph.edges.filter(e => e.to === id && e.rel === '实际参与')
                            .map(e => e.from.slice(3))
  const staffed = graph.edges.filter(e => e.to === id && e.rel === '工位编制')
                             .map(e => e.from.slice(3))
  const chats = graph.edges.filter(e => e.to === id && e.rel === '属于项目' && e.from.startsWith('chat:'))
                           .map(e => e.from.slice(5))
  const arts = graph.edges.filter(e => e.to === id && e.rel === '属于项目' && e.from.startsWith('art:'))
                          .map(e => e.from)
  return { project: projName, actualAis: [...new Set(actual)], staffedAis: [...new Set(staffed)],
           chatCount: new Set(chats).size, artifactCount: new Set(arts).size }
}

// ── 输出物化视图 ──
function writeView(graph) {
  const lines = ['# 关系图 · 视图（机器生成，可重建）', '',
    '> 事实源：办公区目录 + 事件日志 + 对话元数据。本文件是 read model，删了可重跑 relation-engine.js 重建。', '',
    `节点数：${graph.nodes.length}　边数：${graph.edges.length}`, '']
  const byType = {}
  for (const n of graph.nodes) byType[n.type] = (byType[n.type] || 0) + 1
  lines.push('## 节点分布', '')
  for (const [t, c] of Object.entries(byType)) lines.push(`- ${t}: ${c}`)
  lines.push('', '## 边清单', '', '| 主体 | 关系 | 客体 | 证据 |', '|---|---|---|---|')
  for (const e of graph.edges) {
    lines.push(`| ${e.from} | ${e.rel} | ${e.to} | ${e.evidence} |`)
  }
  fs.writeFileSync(path.join(OUT_DIR, '关系图-视图.md'), lines.join('\n') + '\n')

  const q = ['# 关系查询 · 10 秒接上', '',
    '> 断上下文、换 AI，从这里一秒看清「谁参与了什么」。', '',
    '## 问题一：某 AI 参与过哪些项目？', '']
  for (const ai of ['DSH', 'ChatGPT', '通义千问', '大肥鱼', '豆包', 'Grok', 'DSH分身', 'YG']) {
    const a = answerWho(graph, ai)
    const real = a.actualProjects.length ? a.actualProjects.join('、') : '（暂无对话证据）'
    q.push(`- **${a.ai}**：实际参与 ${real}；关联对话 ${a.chatCount} 个；工位编制 ${a.staffedProjects.length} 项（模板，非证据）`)
  }
  q.push('', '## 问题二：某项目有哪些 AI / 对话 / 产出？', '')
  for (const p of allProjects()) {
    const a = answerProject(graph, p.name)
    if (a.actualAis.length || a.chatCount || a.artifactCount)
      q.push(`- **${a.project}**：实际参与 AI ${a.actualAis.join('、') || '—'}；对话 ${a.chatCount}；产出 ${a.artifactCount}`)
  }
  q.push('', '## 手查命令', '',
    '```bash',
    'node relation-engine.js --project AI公司软件化重构 --who 大肥鱼',
    'node relation-engine.js --project AI公司软件化重构 --project-query AI公司软件化重构',
    '```', '')
  fs.writeFileSync(path.join(OUT_DIR, '关系查询-10秒接上.md'), q.join('\n') + '\n')
}

function main() {
  const o = args()
  const graph = buildGraph()

  // 查询模式
  if (o.who) { console.log(JSON.stringify(answerWho(graph, o.who), null, 2)); return }
  if (o.projectQuery) { console.log(JSON.stringify(answerProject(graph, o.projectQuery), null, 2)); return }

  if (o.stats) {
    const bt = {}
    for (const n of graph.nodes) bt[n.type] = (bt[n.type] || 0) + 1
    console.log('节点:', graph.nodes.length, bt, '边:', graph.edges.length)
    return
  }
  if (o.dryRun) {
    console.log('[dry-run] 将写入节点', graph.nodes.length, '边', graph.edges.length)
    console.log('AI 参与示例:', JSON.stringify(answerWho(graph, '大肥鱼').actualProjects))
    return
  }

  // 写入物化视图（read side 整体重建；事实源 append-only 不变）
  fs.writeFileSync(path.join(OUT_DIR, '关系图-节点.jsonl'),
    graph.nodes.map(n => JSON.stringify(n)).join('\n') + '\n')
  fs.writeFileSync(path.join(OUT_DIR, '关系图-边.jsonl'),
    graph.edges.map(e => JSON.stringify(e)).join('\n') + '\n')
  writeView(graph)
  console.log('✅ 关系图重建完成：节点', graph.nodes.length, '边', graph.edges.length)
  console.log('   产物在:', path.relative(COMPANY, OUT_DIR))
  console.log('   10秒接上(大肥鱼实际参与):', answerWho(graph, '大肥鱼').actualProjects.join('、'))
}
main()
