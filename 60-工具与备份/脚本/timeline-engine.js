#!/usr/bin/env node
/**
 * 事件流引擎 · 阶段②（记忆自动化）
 *
 * 依据（见 06-功能测试区/已查清单-事件流引擎.md）：
 *  - Event Sourcing: append-only log + state store 分离 + 幂等
 *  - qoli/chatgpt-history: 对话当知识基底，蒸馏成项目记忆（不转储全文）
 *  - tracegram: 零依赖，输出 Markdown timeline
 *
 * 功能：
 *  1. 读对话原文的元数据（标题/来源/会话ID/消息数/导出时间）→ 生成事件
 *  2. 读产出文件的时间戳 → 生成事件
 *  3. append 到 事件流-日志.jsonl（append-only，稳定 id 去重）
 *  4. 输出一个 Markdown 时间线片段（供「当前状态」引用）
 *
 * 用法：
 *   node timeline-engine.js --project <项目名> [--dry-run] [--stats]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const COMPANY = '/storage/emulated/0/AI专用文件夹/AI公司'
const CORPUS = path.join(COMPANY, '60-工具与备份/知识库/对话原文')
const PROJ_ROOT = path.join(COMPANY, '20-项目区/进行中')

function args() {
  const a = process.argv.slice(2)
  const o = { project: null, dryRun: false, stats: false }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--project') o.project = a[++i]
    else if (a[i] === '--dry-run') o.dryRun = true
    else if (a[i] === '--stats') o.stats = true
  }
  return o
}

// 稳定 id：来源+关键字段 hash（幂等的核心）
function eventId(src, key) {
  return crypto.createHash('sha256').update(`${src}|${key}`).digest('hex').slice(0, 16)
}

// 解析对话原文元数据（不读正文，只读头部）
function parseChatMeta(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(4096)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const head = buf.slice(0, n).toString('utf8')
    const title = (head.match(/^#\s+(.+)$/m) || [])[1]
    const source = (head.match(/^-\s*来源:\s*(.+)$/m) || [])[1]
    const sid = (head.match(/^-\s*会话ID:\s*`?([^`\s]+)`?/m) || [])[1]
    const msgs = (head.match(/^-\s*消息数:\s*(\d+)/m) || [])[1]
    const exported = (head.match(/^-\s*导出时间:\s*(.+)$/m) || [])[1]
    if (!title || !exported) return null
    return { title: title.trim(), source: (source || '').trim(), sid: (sid || '').trim(),
             msgs: msgs ? +msgs : 0, exported: exported.trim(), file }
  } catch { return null }
}

// 收集对话事件
function collectChatEvents() {
  const out = []
  if (!fs.existsSync(CORPUS)) return out
  for (const ai of fs.readdirSync(CORPUS)) {
    const dir = path.join(CORPUS, ai)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const m = parseChatMeta(path.join(dir, f))
      if (!m) continue
      const key = m.sid || m.title
      out.push({
        id: eventId('chat', key),
        type: 'chat',
        at: m.exported,
        title: m.title,
        source: `${ai} · ${m.msgs} 条消息`,
        detail: `会话ID ${m.sid || '—'}`,
        ref: `对话原文/${ai}/${m.sid || 'session'}`,  // 脱敏：不留完整路径
      })
    }
  }
  return out
}

// 收集产出文件事件（按 mtime）
function collectArtifactEvents(projDir) {
  const out = []
  if (!fs.existsSync(projDir)) return out
  const walk = (d, depth) => {
    if (depth > 3) return
    for (const e of fs.readdirSync(d)) {
      const fp = path.join(d, e)
      let st
      try { st = fs.statSync(fp) } catch { continue }
      if (st.isDirectory()) walk(fp, depth + 1)
      else if (/\.(md|zip|json|py|js)$/.test(e) && !e.startsWith('事件流')) {
        // 用本地时区（Asia/Shanghai），不用 UTC
        const d = new Date(st.mtimeMs)
        const pad = (n) => String(n).padStart(2, '0')
        const at = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        const key = `${path.basename(fp)}@${st.mtimeMs}`
        out.push({
          id: eventId('artifact', key),
          type: 'artifact',
          at,
          title: e,
          source: path.relative(projDir, fp),
          detail: `${Math.round(st.size / 1024)}K`,
          ref: path.relative(COMPANY, fp),
        })
      }
    }
  }
  walk(projDir, 0)
  return out
}

// 主流程
function main() {
  const o = args()
  const projName = o.project || 'AI公司软件化重构'
  const projDir = path.join(PROJ_ROOT, projName)
  const logPath = path.join(projDir, '事件流-日志.jsonl')

  // 1. 收集
  const events = [...collectChatEvents(), ...collectArtifactEvents(projDir)]
  // 按时间排序
  events.sort((a, b) => String(b.at).localeCompare(String(a.at)))

  // 2. 幂等追加：读已有 id，只追加新的
  let existing = new Set()
  let lines = []
  if (fs.existsSync(logPath)) {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    for (const l of lines) {
      try { existing.add(JSON.parse(l).id) } catch {}
    }
  }
  const fresh = events.filter(e => !existing.has(e.id))

  if (o.stats) {
    console.log(`项目: ${projName}`)
    console.log(`收集到事件: ${events.length}`)
    console.log(`已存在: ${existing.size}`)
    console.log(`新增: ${fresh.length}`)
    return
  }

  if (o.dryRun) {
    console.log(`--- DRY RUN: 将新增 ${fresh.length} 条事件 ---`)
    for (const e of fresh.slice(0, 12)) {
      console.log(`[${e.at}] (${e.type}) ${e.title} — ${e.source}`)
    }
    if (fresh.length > 12) console.log(`...还有 ${fresh.length - 12} 条`)
    return
  }

  // 3. append-only 写入
  if (fresh.length) {
    const block = fresh.map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.appendFileSync(logPath, block, 'utf8')
  }

  // 4. 生成 Markdown 时间线片段
  const all = [...lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean), ...fresh]
  all.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const md = [
    `# ${projName} · 机器生成事件流`,
    '',
    `> 自动生成 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · 共 ${all.length} 条`,
    '> 这是 append-only 日志的物化视图，人工策展版见 事件流.md',
    '',
    ...all.slice(0, 50).map(e => [
      `### [${e.at}] ${e.title}`,
      `- 来源：${e.source}`,
      `- 详情：${e.detail}`,
      `- 引用：\`${e.ref}\``,
      '',
    ].join('\n')),
  ].join('\n')
  const mdPath = path.join(projDir, '事件流-机器生成.md')
  fs.writeFileSync(mdPath, md, 'utf8')

  console.log(`✅ 追加 ${fresh.length} 条新事件`)
  console.log(`   日志: ${path.relative(COMPANY, logPath)} (${all.length} 条总计)`)
  console.log(`   视图: ${path.relative(COMPANY, mdPath)}`)
}

main()
