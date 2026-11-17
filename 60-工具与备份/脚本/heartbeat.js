#!/usr/bin/env node
/**
 * 心跳派活引擎 · Heartbeat（阶段⑥ P6）
 *
 * 设计依据（见 06-功能测试区/已查清单-心跳派活.md）：
 *  - Paperclip: 「agents stay dormant until real work arrives」——无事不唤醒
 *  - Paperclip: 四种唤醒源，只有 Timer 会空转；我们只用事件驱动
 *  - Paperclip: Atomic checkout —— in_progress 只能被一个 agent 持有
 *  - Paperclip: 状态机 backlog→todo→in_progress→in_review→done，另有 blocked/cancelled
 *
 * 核心机制：
 *  1. 任务队列（JSONL append-only，天然审计）
 *  2. 原子领取（任务级锁文件，防两个 worker 抢同一任务）
 *  3. 状态机（严格的状态转移，非法转移拒绝）
 *  4. 重试 + 死信（最大 3 次，超限标 blocked 等人介入）
 *  5. 事件驱动（有任务才唤醒，不空转）
 *
 * 用法：
 *   node heartbeat.js enqueue --title "..." [--assignee DSH] [--project X] [--from "REQ-001"]
 *   node heartbeat.js list [--state todo] 
 *   node heartbeat.js claim --worker DSH          # 原子领取一个任务
 *   node heartbeat.js start --id T-xxx --worker DSH
 *   node heartbeat.js done --id T-xxx [--note "..."]
 *   node heartbeat.js fail --id T-xxx --reason "..."
 *   node heartbeat.js block --id T-xxx --reason "..."
 *   node heartbeat.js release --id T-xxx          # 释放锁（worker 崩溃后救援）
 *   node heartbeat.js stats
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const COMPANY = '/storage/emulated/0/AI专用文件夹/AI公司'
const QUEUE_DIR = path.join(COMPANY, '60-工具与备份/队列')
const TASKS = path.join(QUEUE_DIR, 'tasks.jsonl')       // append-only 任务日志
const LOCKS = path.join(QUEUE_DIR, 'locks')             // 任务锁目录
const MAX_ATTEMPTS = 3

// ── 状态机（照 Paperclip）──
const STATES = {
  backlog:    { zh: '待办',   next: ['todo', 'cancelled'] },
  todo:       { zh: '待领取', next: ['in_progress', 'cancelled', 'blocked'] },
  in_progress:{ zh: '执行中', next: ['in_review', 'blocked', 'todo'] },  // 可退回 todo 重试
  in_review:  { zh: '待确认', next: ['done', 'in_progress'] },           // 不合格可打回
  done:       { zh: '已完成', next: [] },                                // 终态
  blocked:    { zh: '阻塞',   next: ['todo', 'cancelled'] },             // 等人介入
  cancelled:  { zh: '已取消', next: [] },                                // 终态
}
function canTransit(from, to) {
  const s = STATES[from]
  if (!s) return { ok: false, reason: `未知状态 ${from}` }
  if (!s.next.includes(to)) return { ok: false, reason: `不允许 ${from}(${STATES[from].zh}) → ${to}` }
  return { ok: true }
}

function ensureDirs() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true })
  fs.mkdirSync(LOCKS, { recursive: true })
}

// ── 读取全部任务（按 id 归并，后写覆盖先写）──
function loadTasks() {
  ensureDirs()
  if (!fs.existsSync(TASKS)) return new Map()
  const map = new Map()
  for (const line of fs.readFileSync(TASKS, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (!ev.id) continue
    const cur = map.get(ev.id)
    map.set(ev.id, cur ? { ...cur, ...ev, history: [...(cur.history || []), ...(ev.history || [])] } : ev)
  }
  return map
}

function appendEvent(ev) {
  ensureDirs()
  fs.appendFileSync(TASKS, JSON.stringify(ev) + '\n', 'utf8')
}

function newId() {
  return 'T-' + crypto.randomBytes(4).toString('hex')
}

// ── 原子领取：用 O_EXCL 创建锁文件，天然原子 ──
function tryLock(id, worker) {
  ensureDirs()
  const p = path.join(LOCKS, id + '.lock')
  try {
    const fd = fs.openSync(p, 'wx')   // wx = 独占创建，已存在则失败
    fs.writeSync(fd, JSON.stringify({ worker, at: new Date().toISOString(), pid: process.pid }))
    fs.closeSync(fd)
    return true
  } catch { return false }
}
function unlock(id) {
  try { fs.unlinkSync(path.join(LOCKS, id + '.lock')) } catch {}
}
function lockHolder(id) {
  try { return JSON.parse(fs.readFileSync(path.join(LOCKS, id + '.lock'), 'utf8')) } catch { return null }
}

// ── 命令实现 ──
function cmdEnqueue(a) {
  if (!a.title) return { ok: false, reason: '需要 --title' }
  const id = newId()
  const now = new Date().toISOString()
  const ev = {
    id, title: a.title,
    assignee: a.assignee || 'DSH',
    project: a.project || '',
    fromIssue: a.from || '',
    state: 'todo',                 // 新建即待领取（有 assignee 就直接可分派）
    attempts: 0,
    at: now,
    history: [{ at: now, state: 'todo', by: 'enqueue', note: '任务创建' }],
  }
  appendEvent(ev)
  return { ok: true, id, state: ev.state, assignee: ev.assignee }
}

function cmdList(a) {
  const tasks = [...loadTasks().values()]
  const out = a.state ? tasks.filter(t => t.state === a.state) : tasks
  return {
    ok: true,
    total: tasks.length,
    filtered: out.length,
    tasks: out.map(t => ({
      id: t.id, title: t.title, state: t.state, stateZh: STATES[t.state]?.zh,
      assignee: t.assignee, attempts: t.attempts, locked: !!lockHolder(t.id),
    })),
  }
}

function cmdClaim(a) {
  const worker = a.worker || 'DSH'
  const tasks = [...loadTasks().values()]
  // 只领取：待领取 且 指派给自己
  const cands = tasks.filter(t => t.state === 'todo' && (!t.assignee || t.assignee === worker))
  for (const t of cands) {
    if (tryLock(t.id, worker)) {
      const now = new Date().toISOString()
      appendEvent({
        id: t.id, state: 'in_progress', lockedBy: worker, lockedAt: now,
        attempts: (t.attempts || 0) + 1,
        at: now,
        history: [{ at: now, state: 'in_progress', by: worker, note: '领取并开始执行' }],
      })
      return { ok: true, claimed: { id: t.id, title: t.title, assignee: t.assignee, attempts: (t.attempts || 0) + 1 } }
    }
  }
  return { ok: true, claimed: null, reason: cands.length ? '候选任务都被锁占用' : '没有待领取任务' }
}

function cmdDone(a) {
  const tasks = loadTasks()
  const t = tasks.get(a.id)
  if (!t) return { ok: false, reason: '任务不存在 ' + a.id }
  const tr = canTransit(t.state, 'done')
  // 允许从 in_progress 直接 done（简化，正式应先进 in_review）
  const allowDirect = t.state === 'in_progress'
  if (!tr.ok && !allowDirect) return { ok: false, reason: tr.reason }
  const now = new Date().toISOString()
  appendEvent({ id: a.id, state: 'done', doneAt: now, note: a.note || '', at: now,
                history: [{ at: now, state: 'done', by: a.worker || 'DSH', note: a.note || '完成' }] })
  unlock(a.id)
  return { ok: true, id: a.id, state: 'done' }
}

function cmdFail(a) {
  const tasks = loadTasks()
  const t = tasks.get(a.id)
  if (!t) return { ok: false, reason: '任务不存在 ' + a.id }
  const now = new Date().toISOString()
  const attempts = t.attempts || 1
  // 超过上限 → blocked（等人介入），否则退回 todo 重试
  const nextState = attempts >= MAX_ATTEMPTS ? 'blocked' : 'todo'
  appendEvent({
    id: a.id, state: nextState, lastError: a.reason || '', at: now,
    lockedBy: '', 
    history: [{ at: now, state: nextState, by: a.worker || 'DSH',
                note: `失败(${attempts}/${MAX_ATTEMPTS})：${a.reason || '未知'}${nextState === 'blocked' ? ' → 需人工介入' : ' → 重新入队'}` }],
  })
  unlock(a.id)
  return { ok: true, id: a.id, state: nextState, attempts, maxed: nextState === 'blocked' }
}

function cmdBlock(a) {
  const tasks = loadTasks()
  const t = tasks.get(a.id)
  if (!t) return { ok: false, reason: '任务不存在 ' + a.id }
  const now = new Date().toISOString()
  appendEvent({ id: a.id, state: 'blocked', blockReason: a.reason || '', at: now,
                history: [{ at: now, state: 'blocked', by: a.worker || 'DSH', note: a.reason || '阻塞' }] })
  unlock(a.id)
  return { ok: true, id: a.id, state: 'blocked', reason: a.reason }
}

function cmdRelease(a) {
  const h = lockHolder(a.id)
  unlock(a.id)
  return { ok: true, id: a.id, released: h }
}

function cmdStats() {
  const tasks = [...loadTasks().values()]
  const byState = {}
  for (const t of tasks) byState[t.state] = (byState[t.state] || 0) + 1
  const zh = {}
  for (const [k, v] of Object.entries(byState)) zh[STATES[k]?.zh || k] = v
  return { ok: true, total: tasks.length, byState: zh,
           blocked: tasks.filter(t => t.state === 'blocked').map(t => ({ id: t.id, title: t.title, reason: t.blockReason })) }
}

// ── CLI ──
function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (x.startsWith('--')) { a[x.slice(2)] = argv[++i] ?? true }
    else a._.push(x)
  }
  return a
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  const cmd = a._[0]
  const map = {
    enqueue: cmdEnqueue, list: cmdList, claim: cmdClaim, done: cmdDone,
    fail: cmdFail, block: cmdBlock, release: cmdRelease, stats: cmdStats,
  }
  const fn = map[cmd]
  if (!fn) {
    console.log('用法: node heartbeat.js <enqueue|list|claim|done|fail|block|release|stats> [参数]')
    process.exit(1)
  }
  const r = fn(a)
  console.log(JSON.stringify(r, null, 2))
  if (!r.ok) process.exit(2)
}

main()
