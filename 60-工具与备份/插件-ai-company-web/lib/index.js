/** AI 公司 · Cordis 插件宿主半侧（Node）
 *  提供公司目录读取能力，供浏览器半侧通过 HTTP 调用。
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { SPACES, buildOverview, routeSpace, issueConsent, checkConsent,
         riskOf, auditRecord, previewAction, applyStatusChange, detectSection } from './spaces.js'

// 同文件写锁：把并发 apply 串行化，避免互相覆盖（审查 P1-5）
const FILE_LOCKS = new Map()

const CANDIDATES = [
  '/storage/emulated/0/AI专用文件夹/AI公司',
  '/sdcard/AI专用文件夹/AI公司',
]

function companyRoot() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p
  return null
}

async function ls(d) { try { return await fsp.readdir(d) } catch { return [] } }
async function lsDirs(d) {
  const out = []
  for (const n of await ls(d)) {
    try { if ((await fsp.stat(path.join(d, n))).isDirectory()) out.push(n) } catch {}
  }
  return out.sort()
}
async function readText(p, max = 200000) {
  try {
    const s = await fsp.readFile(p, 'utf8')
    return s.length > max ? s.slice(0, max) : s
  } catch { return '' }
}
// 不截断读（写回场景必须用这个，否则会截断丢数据 —— 见审查报告 P0-2）
async function readTextFull(p) {
  return await fsp.readFile(p, 'utf8')
}

// 解析问题需求池 md：抓 `- [编号] 标题 —— 说明（来源）`
// 返回 { type, id, title, detail, section } 数组
function parseIssues(text, file) {
  const out = []
  if (!text) return out
  let section = ''
  for (const line of text.split('\n')) {
    const sh = line.match(/^##\s+(.+)$/)
    if (sh) {
      section = sh[1].replace(/^[一二三四五六七八九十]+、/, '').replace(/[（(].*$/, '').trim()
      continue
    }
    const m = line.match(/^-\s*\[([^\]]+)\]\s*(.+)$/)
    if (!m) continue
    const id = m[1].trim()
    const rest = m[2].trim()
    const parts = rest.split(/\s+——\s+|——/)
    const title = (parts[0] || '').trim()
    const detail = (parts.slice(1).join('——') || '').trim()
    // 精确前缀判定（审查 P2-10：/REQ/ 先判会把 BUG-REQ-xxx 误判成 suggest）
    let type = 'other'
    if (/BUG/.test(id)) type = 'bug'
    else if (/OPT/.test(id)) type = 'opt'
    else if (/REQ|建议/.test(id)) type = 'suggest'
    out.push({ id, type, title, detail, section, file: file || '' })
  }
  return out
}
async function countFiles(d) {
  let n = 0
  const walk = async (dir, depth) => {
    if (depth > 6) return
    for (const e of await ls(dir)) {
      try {
        const st = await fsp.stat(path.join(dir, e))
        if (st.isDirectory()) await walk(path.join(dir, e), depth + 1)
        else n++
      } catch {}
    }
  }
  await walk(d, 0)
  return n
}

const RULES = [
  { n: 1, t: '一个项目一个文件夹', auto: true },
  { n: 2, t: '会分类', auto: true },
  { n: 3, t: '资料归档不靠记忆', auto: false },
  { n: 4, t: '房间不能乱用', auto: true },
  { n: 5, t: '命名要能看懂', auto: false },
  { n: 6, t: '每个项目必须有 ZIP', auto: true },
  { n: 7, t: '改动要留痕', auto: false },
  { n: 8, t: 'DSH 读对话后记录+更新', auto: true },
  { n: 9, t: '汇总前必须先同步', auto: false },
  { n: 10, t: '区分原话/判断/待确认', auto: false },
  { n: 11, t: '矛盾要上报', auto: false },
  { n: 12, t: '只出建议不拍板', auto: false },
  { n: 13, t: '员工用「结论：」', auto: false },
  { n: 14, t: '新 AI 入职 7 步', auto: false },
  { n: 15, t: '开工前必读岗位知识', auto: false },
  { n: 16, t: '分活四步', auto: false },
  { n: 17, t: '通用修复不打补丁', auto: false },
  { n: 18, t: '一次性同步更新', auto: false },
  { n: 19, t: '归档成 ZIP 清外围', auto: true },
  { n: 20, t: '工位回到空座位', auto: false },
  { n: 21, t: '非作者交叉验收', auto: false },
]

const EMPLOYEE_CAPS = {
  'YG':       { role: '董事长兼秘书', can: '定方向、拍板、传话', cant: '—', bench: '人类', dot: 'good' },
  'DSH':      { role: '总经理', can: '读全部对话、写全部文件、root、ACP', cant: '给其他 AI 发消息', bench: '实测可用', dot: 'good' },
  'DSH分身':  { role: '分身部', can: '执行命令、独立工位', cant: '看不到主体对话', bench: '实测可用', dot: 'good' },
  'ChatGPT':  { role: '分析部主管', can: '深度分析、审计挑错', cant: '看不到公司文件', bench: '9 会话可读·可发', dot: 'good' },
  '千问':     { role: '文档部主管', can: '中文文档撰写', cant: '动手执行', bench: '2 会话可读·可发', dot: 'good' },
  '通义千问': { role: '文档部主管', can: '中文文档撰写', cant: '动手执行', bench: '2 会话可读·可发', dot: 'good' },
  '大肥鱼':   { role: '技术部', can: '工程实现', cant: '—', bench: '82 会话可读·可发', dot: 'good' },
  '豆包':     { role: '视觉部', can: '视觉、素材、发送', cant: '对话加密读不到', bench: '对话不可读·可发', dot: 'bad' },
  'Grok':     { role: '情报部', can: '情报检索、发送', cant: '对话位置未确认', bench: '对话不可读·可发', dot: 'warn' },
}

// 进程内缓存：60 秒内不重复扫盘（公司目录不会每秒变）
let COLLECT_CACHE = null
let COLLECT_AT = 0
let COLLECT_PENDING = null
const CACHE_TTL = 60 * 1000

async function collectCached(force = false) {
  const now = Date.now()
  if (!force && COLLECT_CACHE && now - COLLECT_AT < CACHE_TTL) return COLLECT_CACHE
  if (COLLECT_PENDING) return COLLECT_PENDING
  COLLECT_PENDING = (async () => {
    try {
      const d = await collect()
      COLLECT_CACHE = d
      COLLECT_AT = Date.now()
      return d
    } finally { COLLECT_PENDING = null }
  })()
  return COLLECT_PENDING
}

async function collect() {
  const root = companyRoot()
  if (!root) return { ok: false, reason: '找不到 AI公司 目录' }

  const ROOMS = [
    { key: 'office',   dir: '10-办公区',     label: '办公区' },
    { key: 'projects', dir: '20-项目区',     label: '项目区' },
    { key: 'meeting',  dir: '30-会议室',     label: '会议室' },
    { key: 'archive',  dir: '40-档案室',     label: '档案室' },
    { key: 'tools',    dir: '60-工具与备份', label: '工具库' },
    { key: 'spec',     dir: '02-制度与模板', label: '制度区' },
  ]
  const rooms = []
  for (const r of ROOMS) {
    const d = path.join(root, r.dir)
    rooms.push({ ...r, files: fs.existsSync(d) ? await countFiles(d) : 0, exists: fs.existsSync(d) })
  }

  const officeDir = path.join(root, '10-办公区')
  const seats = []
  for (const s of await lsDirs(officeDir)) {
    const parts = s.split('-')
    const who = parts.length >= 3 ? parts.slice(2).join('-') : parts[parts.length - 1]
    const dept = parts.length >= 3 ? parts[1] : ''
    const cap = EMPLOYEE_CAPS[who] ?? { role: dept || '未知', can: '—', cant: '—', bench: '未登记', dot: 'warn' }
    seats.push({ dir: s, who, dept, files: await countFiles(path.join(officeDir, s)), ...cap })
  }

  const pjDir = path.join(root, '20-项目区')
  const readProjects = async (sub) => {
    const d = path.join(pjDir, sub)
    if (!fs.existsSync(d)) return []
    const out = []
    for (const name of await lsDirs(d)) {
      const pd = path.join(d, name)
      const mdFiles = (await ls(pd)).filter((f) => f.endsWith('.md'))
      const zips = (await ls(pd)).filter((f) => f.endsWith('.zip'))

      // 进度解析：只认「主线与进度」这类真正的进度文件
      let pct = null, note = '', pctSrc = '', nextStep = ''
      const PRI = [
        '00-主线与进度.md',
        '01-项目进度报告.md',
        '00-进度.md',
        '00-项目说明.md',
        'README.md',
      ]
      const EXCLUDE = /人员分配|启动检查|通用开场白|任务话术|接手必读|CHANGELOG/
      for (const f of PRI) {
        if (!mdFiles.includes(f)) continue
        if (EXCLUDE.test(f)) continue
        const t = await readText(path.join(pd, f), 12000)
        const m1 = t.match(/(\d{1,3})\s*\/\s*(\d{1,3})/)
        if (m1) {
          const a = +m1[1], b = +m1[2]
          if (b > 0 && a <= b) { pct = Math.round((a / b) * 100); note = `${a}/${b}`; pctSrc = f }
        }
        if (pct === null) {
          const m2 = t.match(/(\d{1,3})\s*%/)
          if (m2) { pct = +m2[1]; pctSrc = f }
        }
        if (pct === null) {
          const rows = t.split('\n').filter((l) => l.trim().startsWith('|'))
          const ok = rows.filter((l) => l.includes('✅')).length
          const todo = rows.filter((l) => l.includes('⬜')).length
          if (ok + todo >= 2) { pct = Math.round((ok / (ok + todo)) * 100); note = `${ok}/${ok + todo}`; pctSrc = f }
        }

        // 「下一步」：找 ⬜ 标记行，取最有描述性的单元格
        if (!nextStep) {
          const pending = t.split('\n')
            .filter((l) => l.includes('⬜'))
            .map((l) => {
              const cells = l.split('|').map((c) => c.trim()).filter(Boolean)
              if (cells.length >= 2) {
                // 候选：去掉含 ⬜ 的列，去掉纯编号列（T-01、②、G-04）
                const cands = cells
                  .filter((c) => !c.includes('⬜'))
                  .map((c) => c.replace(/\*\*/g, '').trim())
                  .filter((c) => c.length >= 3 && !/^[A-Z]?-\d+$/.test(c) && !/^[①②③④⑤⑥⑦⑧⑨⑩]$/.test(c))
                // 取最长的（通常最具体）
                if (cands.length) return cands.sort((a, b) => b.length - a.length)[0]
                return ''
              }
              const m = l.match(/⬜\s*\*{0,2}(.{3,60})/)
              return m ? m[1].replace(/\*{0,2}.*$/, '').trim() : ''
            })
            .filter((s) => s && s.length >= 3 && s.length < 60)
          if (pending.length) nextStep = pending[0]
        }
        if (pct !== null && nextStep) break
      }

      // 分类：按项目名关键词归类
      const CAT = [
        { key: 'product', zh: '产品研发', en: 'Product', re: /软件化|控制台|重构|视图|UI/i },
        { key: 'ops', zh: '公司运营', en: 'Ops', re: /运转|公司|组织|制度/i },
        { key: 'review', zh: '评审交付', en: 'Review', re: /评审|推介|交付|验收/i },
        { key: 'infra', zh: '基础设施', en: 'Infra', re: /root|通道|模块|桥接|适配/i },
      ]
      const cat = CAT.find((c) => c.re.test(name)) ?? { key: 'other', zh: '其他', en: 'Other' }

      // 文档构成：材料本体 / 各方意见 / 产出
      const subDirs = await lsDirs(pd)
      const parts = []
      for (const sd of subDirs) {
        const n = await countFiles(path.join(pd, sd))
        if (n > 0) parts.push({ name: sd.replace(/^\d+-/, ''), n })
      }

      // 项目自己的问题需求池（跟项目走）
      let issues = []
      if (mdFiles.includes('00-问题需求池.md')) {
        issues = parseIssues(await readText(path.join(pd, '00-问题需求池.md')),
                             path.relative(root, path.join(pd, '00-问题需求池.md')))
      }

      out.push({
        name,
        files: await countFiles(pd),
        zips: zips.length,
        md: mdFiles.length,
        pct, note, pctSrc, nextStep,
        cat: cat.key, catZh: cat.zh, catEn: cat.en,
        parts,
        issues,
        hasZip: zips.length > 0,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
  const doing = await readProjects('进行中')
  const doneDirs = await readProjects('已完成')
  const looseZips = (await ls(path.join(pjDir, '已完成')))
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const name = f.replace(/\.zip$/, '')
      const CAT = [
        { key: 'product', zh: '产品研发', re: /软件化|控制台|重构|视图|UI/i },
        { key: 'ops', zh: '公司运营', re: /运转|公司|组织|制度/i },
        { key: 'review', zh: '评审交付', re: /评审|推介|交付|验收/i },
        { key: 'infra', zh: '基础设施', re: /root|通道|模块|桥接|适配/i },
      ]
      const cat = CAT.find((c) => c.re.test(name)) ?? { key: 'other', zh: '其他' }
      return {
        name, files: 0, zips: 1, md: 0, pct: 100, note: '已归档',
        pctSrc: '', nextStep: '', cat: cat.key, catZh: cat.zh, parts: [], hasZip: true,
      }
    })
  const done = [...doneDirs, ...looseZips]

  const arcDir = path.join(root, '40-档案室')
  const cabinets = []
  for (const c of await lsDirs(arcDir)) {
    cabinets.push({ name: c, files: await countFiles(path.join(arcDir, c)) })
  }

  const docs = []
  const scanDocs = async (dir, depth, project) => {
    if (depth > 3) return
    for (const e of await ls(dir)) {
      const fp = path.join(dir, e)
      try {
        const st = await fsp.stat(fp)
        if (st.isDirectory()) await scanDocs(fp, depth + 1, project)
        else if (e.endsWith('.md') && !e.startsWith('.')) {
          const raw = e.replace(/\.md$/, '')
          // 类型识别（按文件名规律）
          const KINDS = [
            { key: 'suggest',zh: '建议',     re: /建议|REQ/ },
            { key: 'bug',    zh: '问题',     re: /问题|BUG/ },
            { key: 'opt',    zh: '优化',     re: /优化|OPT/ },
            { key: 'book',   zh: '项目书',   re: /项目书|计划书|方案|总纲|产品定义/ },
            { key: 'report', zh: '报告',     re: /报告|验证|测试|诊断|记录|清单/ },
            { key: 'main',   zh: '进度',     re: /主线|进度|CHANGELOG/ },
            { key: 'assign', zh: '分配',     re: /分配|人员|职责/ },
            { key: 'brief',  zh: '必读',     re: /必读|说明|开场白|README|使用/ },
            { key: 'tech',   zh: '技术',     re: /适配器|桥接|技术设计|指南|调研|框架/ },
          ]
          const kind = KINDS.find(k => k.re.test(raw)) ?? { key: 'other', zh: '文档' }
          // 清洗文件名：去数字前缀、去 .md
          const clean = raw.replace(/^\d+-/, '').replace(/^\d{8}-\d{4}-/, '')
          docs.push({
            name: clean, file: e, raw,
            kind: kind.key, kindZh: kind.zh,
            project: project ?? '(根)', bytes: st.size, path: fp,
            mtime: st.mtimeMs,
          })
        }
      } catch {}
    }
  }
  for (const sub of ['进行中', '已完成']) {
    const base = path.join(pjDir, sub)
    if (!fs.existsSync(base)) continue
    for (const pn of await lsDirs(base)) await scanDocs(path.join(base, pn), 1, pn)
  }
  for (const er of [
    { dir: '10-办公区', project: '办公区' },
    { dir: '40-档案室', project: '档案室' },
    { dir: '11-公司建议问题优化', project: '公司建议问题优化' },
  ]) {
    const base = path.join(root, er.dir)
    if (fs.existsSync(base)) await scanDocs(base, 0, er.project)
  }
  // 根目录只扫直属文件：写一个不递归的版本，避免把 20-/40- 里的文件重复扫成"(根)"
  for (const e of await ls(root)) {
    if (!e.endsWith('.md') || e.startsWith('.')) continue
    try {
      const fp = path.join(root, e)
      const st = await fsp.stat(fp)
      if (!st.isFile()) continue
      const raw = e.replace(/\.md$/, '')
      const clean = raw.replace(/^\d+-/, '')
      docs.push({
        name: clean, file: e, raw,
        kind: 'report', kindZh: '公司文档',
        project: '公司级', bytes: st.size, path: fp, mtime: st.mtimeMs,
      })
    } catch {}
  }

  // 公司级建议/问题/优化（11-公司建议问题优化/）
  let companyIssues = []
  const ciDir = path.join(root, '11-公司建议问题优化')
  if (fs.existsSync(ciDir)) {
    for (const f of ['01-建议.md', '02-问题.md', '03-优化.md']) {
      const p = path.join(ciDir, f)
      if (fs.existsSync(p)) companyIssues.push(...parseIssues(await readText(p), path.relative(root, p)))
    }
  }

  const checks = []
  const ruleStatus = (n, ok, detail) => checks.push({ n, ok, detail })
  ruleStatus(1, doing.every((p) => p.files > 0), `${doing.length} 个项目各自成夹`)
  ruleStatus(4, rooms.every((r) => r.exists), `${rooms.filter(r => r.exists).length}/${rooms.length} 个房间就位`)
  const noZip = doing.filter((p) => p.zips === 0).map((p) => p.name)
  ruleStatus(6, noZip.length === 0, noZip.length ? `缺 ZIP：${noZip.join('、')}` : `${doing.length} 个项目都有 ZIP`)
  ruleStatus(19, done.length > 0, `已完成 ${done.length} 个`)
  const chg = path.join(root, 'CHANGELOG.md')
  let chgOk = false
  if (fs.existsSync(chg)) chgOk = Date.now() - (await fsp.stat(chg)).mtimeMs < 86400000
  ruleStatus(8, chgOk, chgOk ? 'CHANGELOG 24h 内有更新' : 'CHANGELOG 超过 24h 未更新')

  // ④空间引擎：读关系图节点 → 构建多维俯瞰
  let graphNodes = []
  const gnodePath = path.join(root, '20-项目区/进行中/AI公司软件化重构/关系图-节点.jsonl')
  if (fs.existsSync(gnodePath)) {
    for (const line of (await readText(gnodePath)).split('\n')) {
      if (!line.trim()) continue
      try {
        const n = JSON.parse(line)
        graphNodes.push({ id: n.id, label: n.label, type: n.type, ref: n.ref })
      } catch {}
    }
  }
  const overview = buildOverview({
    projects: { doing, done }, seats, docs, ruleTotal: RULES.length, graphNodes,
  })

  const autoRules = RULES.filter((r) => r.auto)
  return {
    ok: true, root, rooms, seats,
    graphNodes, overview,
    projects: { doing, done, held: [] },
    cabinets, checks, docs, companyIssues,
    ruleTotal: RULES.length,
    autoTotal: autoRules.length,
    autoPassed: checks.filter((c) => c.ok).length,
    at: Date.now(),
  }
}

// 统一路径安全解析（审查 P0-1/P2-1：所有读路径必须走这里）
// 返回 root 内的绝对路径，越界返回 null
function resolveInsideRoot(root, rel, { exts = null, names = null } = {}) {
  if (!rel || typeof rel !== 'string') return null
  if (rel.includes('\0')) return null
  if (path.isAbsolute(rel)) return null
  const abs = path.resolve(root, rel)
  // 必须在 root 之内（含 root 本身）
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  if (exts && !exts.some(e => abs.toLowerCase().endsWith(e))) return null
  if (names && !names.includes(path.basename(abs))) return null
  return abs
}

async function listFiles(dirRel) {
  const root = companyRoot()
  if (!root) return []
  const base = path.join(root, dirRel)
  if (!fs.existsSync(base)) return []
  const out = []
  const walk = async (d, depth, rel) => {
    if (depth > 5) return
    for (const e of await ls(d)) {
      const fp = path.join(d, e)
      try {
        const st = await fsp.stat(fp)
        if (st.isDirectory()) await walk(fp, depth + 1, rel ? rel + '/' + e : e)
        else if (e.endsWith('.md')) {
          out.push({ name: e, rel: rel ? rel + '/' + e : e, path: fp, bytes: st.size })
        }
      } catch {}
    }
  }
  await walk(base, 0, '')
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** 宿主半侧：注册 HTTP 路由供浏览器调用 */
export function apply(ctx) {
  const routes = {
    '/collect': async (q) => collectCached(q?.force === '1'),
    '/file': async (q) => {
      const root = companyRoot()
      if (!root) return { ok: false, reason: '找不到公司目录' }
      // 只接受 root 内的相对路径；越界/绝对路径一律拒绝（审查 P0-1）
      const abs = resolveInsideRoot(root, q?.path, { exts: ['.md', '.jsonl', '.txt', '.json'] })
      if (!abs) return { ok: false, reason: 'path rejected（只允许公司目录内的相对路径）' }
      try {
        const text = await readTextFull(abs)
        return { ok: true, path: path.relative(root, abs), text: text.slice(0, 60000) }
      } catch (e) { return { ok: false, reason: '读取失败：' + String(e.message || e) } }
    },
    '/list': async (q) => {
      const root = companyRoot()
      if (!root) return { ok: false, reason: '找不到公司目录' }
      const dirRel = q?.dir ?? ''
      if (dirRel && !resolveInsideRoot(root, dirRel)) return { ok: false, reason: 'dir rejected' }
      return { ok: true, files: await listFiles(dirRel) }
    },
    // ④空间引擎：空间路由 + 俯瞰（干涉前只读，不需授权）
    '/spaces': async (q) => {
      const root = companyRoot()
      if (!root) return { ok: false, reason: '找不到公司目录' }
      try {
        const s = q?.space ? routeSpace(q.space, root) : null
        const d = await collectCached(q?.force === '1')
        return { ok: true, space: s ? { id: s.id, zh: s.zh, icon: s.icon, dir: s.dir } : null,
                 spaces: SPACES.map(x => ({ id: x.id, zh: x.zh, icon: x.icon, view: x.view })),
                 overview: d.overview }
      } catch (e) { return { ok: false, code: e.code, reason: String(e.message || e) } }
    },
    // 说明：原独立 /consent 路由已删除（审查 P1-4：无条件签发授权令牌 = 闸门形同虚设）
    // 授权签发只保留在 /intervene 的 preview 内，绑定完整 payload。

    // ⑤真实干预：preview（预览/申请授权）→ apply（校验+原子写+审计）
    '/intervene': async (q) => {
      const root = companyRoot()
      if (!root) return { ok: false, reason: '找不到公司目录' }
      const action = q?.action || 'setStatus'
      const risk = riskOf(action)
      if (!risk.allowed) {
        return { ok: false, code: 'ORCH_E_RISK_BLOCKED', reason: `动作 ${action} 风险=${risk.risk}，当前不开放` }
      }

      // 审计日志路径（append-only）
      const auditPath = path.join(root, '20-项目区/进行中/AI公司软件化重构/06-功能测试区/干预审计日志.jsonl')
      const writeAudit = async (rec) => {
        try {
          await fsp.appendFile(auditPath, JSON.stringify(rec) + '\n', 'utf8')
        } catch (e) { /* 审计失败不影响主流程，但会在返回里标注 */ return String(e.message || e) }
        return null
      }

      // 目标文件白名单：只接受公司内、问题池 md（basename 全等，防前缀绕过 P2-8）
      const POOL_NAMES = ['00-问题需求池.md', '01-建议.md', '02-问题.md', '03-优化.md']
      const resolvePoolFile = (rel) => {
        const abs = resolveInsideRoot(root, rel, { exts: ['.md'], names: POOL_NAMES })
        return abs && fs.existsSync(abs) ? abs : null
      }

      if (q?.mode === 'preview') {
        // 两段式第一段：读文件、生成人类可读预览、签发票据（绑定完整 payload）
        if (!q.id || !q.toStatus) return { ok: false, reason: 'preview 需要 id 与 toStatus（票据绑定完整参数）' }
        if (!['待处理', '处理中', '已完成'].includes(q.toStatus))
          return { ok: false, reason: 'toStatus 只允许 待处理/处理中/已完成' }
        const abs = resolvePoolFile(q.file)
        if (!abs) return { ok: false, reason: '目标文件不在白名单或不存在' }
        const text = await readTextFull(abs)             // 全量读，避免末尾条目探测不到（P0-2 同类）
        const fromStatus = detectSection(text, q.id)     // 真实探测当前区块
        if (fromStatus === '未找到') return { ok: false, reason: `文件里找不到编号 ${q.id}` }
        if (fromStatus === q.toStatus) return { ok: false, reason: `该条目已在「${q.toStatus}」，无需变更` }
        // 票据只绑定三要素（id/file/toStatus），避免展示字段变化导致校验脆弱
        const bind = { id: q.id, file: q.file, toStatus: q.toStatus }
        const preview = previewAction(action, { ...bind, fromStatus, title: q.title || q.id })
        const token = issueConsent(action, bind)
        const auditErr = await writeAudit(auditRecord(action, { ...bind, fromStatus }, 'PENDING_APPROVAL', q.id || ''))
        return { ok: true, preview, token, expiresInSec: 60, auditErr }
      }

      if (q?.mode === 'apply') {
        // 两段式第二段：校验票据（单次消费）→ 改内容 → 原子写 → 审计
        const bind = { id: q.id, file: q.file, toStatus: q.toStatus }
        const gate = checkConsent(q.token, action, bind)
        if (!gate.ok) {
          await writeAudit(auditRecord(action, bind, 'BLOCKED', gate.reason))
          return { ok: false, code: gate.code, reason: gate.reason }
        }
        const abs = resolvePoolFile(q.file)
        if (!abs) {
          await writeAudit(auditRecord(action, bind, 'BLOCKED', '目标文件不在白名单'))
          return { ok: false, reason: '目标文件不在白名单或不存在' }
        }
        // 同一文件串行化，避免两个 apply 并发写丢改动（P1-5）
        const prev = FILE_LOCKS.get(abs) || Promise.resolve()
        const task = prev.then(async () => {
          // 全量读（不截断），否则写回会丢文件尾部（P0-2）
          const text = await readTextFull(abs)
          // 重探当前区块，与 preview 时的 fromStatus 比对（P2-4）
          const nowStatus = detectSection(text, q.id)
          if (nowStatus === '未找到') return { ok: false, reason: `文件里已找不到编号 ${q.id}（可能被改动）` }
          if (nowStatus === q.toStatus) return { ok: false, reason: `该条目已在「${q.toStatus}」，无需变更` }
          if (q.fromStatus && nowStatus !== q.fromStatus)
            return { ok: false, reason: `状态已变化（现为「${nowStatus}」），请重新预览` }

          const r = applyStatusChange(text, q.id, q.toStatus)
          if (!r.ok) return { ok: false, reason: r.reason }

          // 审计先写：写失败即拒绝执行（P1-6）
          const auditErr = await writeAudit(auditRecord(action, { ...bind, fromStatus: nowStatus }, 'ALLOWED', r.movedLine))
          if (auditErr) return { ok: false, reason: '审计写入失败，已拒绝执行：' + auditErr }

          // 原子写：唯一 tmp 名 + finally 清理
          const tmp = abs + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
          try {
            await fsp.writeFile(tmp, r.text, 'utf8')
            await fsp.rename(tmp, abs)
          } catch (e) {
            try { await fsp.unlink(tmp) } catch {}
            return { ok: false, reason: '写入失败：' + String(e.message || e) }
          }
          return { ok: true, movedLine: r.movedLine, file: q.file, createdSection: r.createdSection,
                   hint: '状态已更新，可点刷新查看' }
        })
        FILE_LOCKS.set(abs, task.catch(() => {}))
        try { return await task } finally {
          if (FILE_LOCKS.get(abs) === task || FILE_LOCKS.get(abs) === task.catch(() => {})) FILE_LOCKS.delete(abs)
        }
      }

      return { ok: false, reason: '需 mode=preview 或 mode=apply' }
    },

    // 读干预审计日志（上帝视角可查看）
    '/audit': async () => {
      const root = companyRoot()
      if (!root) return { ok: false, reason: '找不到公司目录' }
      const p = path.join(root, '20-项目区/进行中/AI公司软件化重构/06-功能测试区/干预审计日志.jsonl')
      if (!fs.existsSync(p)) return { ok: true, records: [] }
      // 读尾部（审查 P2-9：readText 截头留尾，日志超限后看不到最新）
      const st = await fsp.stat(p)
      const TAIL = 256 * 1024
      const start = Math.max(0, st.size - TAIL)
      const fh = await fsp.open(p, 'r')
      let buf
      try {
        buf = Buffer.alloc(st.size - start)
        await fh.read(buf, 0, buf.length, start)
      } finally { await fh.close() }
      let text = buf.toString('utf8')
      if (start > 0) text = text.slice(text.indexOf('\n') + 1)   // 丢掉被截断的首行
      const lines = text.split('\n').filter(Boolean)
      let bad = 0
      const recs = lines.slice(-50).map(l => { try { return JSON.parse(l) } catch { bad++; return null } }).filter(Boolean)
      return { ok: true, records: recs, parseFailed: bad }
    },

    '/timeline': async (q) => {
      const root = companyRoot()
      const base = `${root}/20-项目区/进行中/AI公司软件化重构`
      // kind=auto → 机器生成版；默认 → 人工策展版
      const file = q?.kind === 'auto'
        ? `${base}/事件流-机器生成.md`
        : `${base}/事件流.md`
      if (fs.existsSync(file)) {
        return { ok: true, path: file, text: await readText(file, 60000) }
      }
      return { ok: false, reason: '还没有事件流文件' }
    },
  }

  // 启动预热：引擎加载插件时就扫一次，用户点开时数据已在内存
  collectCached().catch(() => {})

  // webServer 服务的注册 API：register({ kind, path, handler })
  ctx.inject(['webServer'], (c) => {
    const ws = c.webServer
    if (typeof ws?.register !== 'function') return

    for (const [p, fn] of Object.entries(routes)) {
      c.effect(() => ws.register({
        kind: 'exact',
        path: `/ai-company${p}`,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://x')
            const q = Object.fromEntries(url.searchParams)
            const r = await fn(q)
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(r))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, reason: String(e?.message || e) }))
          }
        },
      }), `ai-company route ${p}`)
    }
  })
}

export { collect, collectCached, listFiles, companyRoot, readText }
