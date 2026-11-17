#!/usr/bin/env node
/**
 * 心跳 Worker · 把队列里的任务真正执行掉
 *
 * 设计依据（见 06-功能测试区/已查清单-心跳派活.md）：
 *  - Paperclip: agents stay dormant until real work arrives（无事不唤醒）
 *  - Paperclip: Atomic checkout（in_progress 只能一个持有）
 *  - Paperclip: 失败重试 + 超限 blocked 等人介入
 *
 * 链路：
 *   队列领取（原子锁） → 组装 prompt → acpx 调 DSH（WorkBuddy 模型）→ 回写状态 → 归档
 *
 * 关键约束（实测）：
 *  - 必须用 `prompt`（持久会话）而非 `exec`（一次性会话会重置成默认模型）
 *  - 必须指定 `model` 为 workbuddy/* 否则报 no API key
 *
 * 用法：
 *   node heartbeat-worker.js run [--worker DSH] [--model "workbuddy","glm-5.3"] [--dry-run]
 *   node heartbeat-worker.js once [--worker DSH]     # 只跑一个任务
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const COMPANY = '/storage/emulated/0/AI专用文件夹/AI公司'
const SCRIPTS = path.join(COMPANY, '60-工具与备份/脚本')
const HB = path.join(SCRIPTS, 'heartbeat.js')
const CWD = '/root/日常任务区'
const SESSION_NAME = 'ai-company-worker'      // 固定命名会话
const DEFAULT_MODEL = '["workbuddy","glm-5.3"]'  // 走 WorkBuddy 积分
const TIMEOUT_MS = 5 * 60 * 1000              // 单任务最长 5 分钟

function hb(cmd, args = []) {
  const out = execFileSync('node', [HB, cmd, ...args], {
    encoding: 'utf8', timeout: 30000,
  })
  const j = JSON.parse(out)
  return j
}

function log(msg) { console.log(`[worker ${new Date().toISOString().slice(11, 19)}] ${msg}`) }

// ── 确保 acpx 会话存在且模型正确（只在启动时做一次）──
function ensureSession(model) {
  const env = { ...process.env, DSH_HOME: '/root/.dsh' }
  try {
    execFileSync('acpx', ['deepseek-harness', 'sessions', 'ensure', '-s', SESSION_NAME], {
      cwd: CWD, encoding: 'utf8', timeout: 60000, env,
    })
  } catch (e) { /* 已存在会报错，忽略 */ }
  try {
    const r = execFileSync('acpx', ['deepseek-harness', 'set', 'model', model, '-s', SESSION_NAME], {
      cwd: CWD, encoding: 'utf8', timeout: 60000, env,
    })
    log(`模型设置: ${r.trim()}`)
    return true
  } catch (e) {
    log(`⚠ 模型设置失败: ${String(e.message || e).slice(0, 200)}`)
    return false
  }
}

// ── 归档：把任务结果写进事件流 ──
function appendToTimeline(task, output) {
  const LOG = path.join(COMPANY, '20-项目区/进行中/AI公司软件化重构/事件流-日志.jsonl')
  const id = crypto.createHash('sha256')
    .update(`heartbeat|${task.id}|${Date.now()}`)
    .digest('hex').slice(0, 16)
  const now = new Date()
  const at = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
  const ev = {
    id, type: 'task',
    at,
    title: task.title,
    source: `心跳派活 · ${task.assignee}`,
    detail: `任务 ${task.id} 完成（第 ${task.attempts} 次尝试）`,
    ref: '',
    output: output.slice(0, 500),
  }
  fs.appendFileSync(LOG, JSON.stringify(ev) + '\n', 'utf8')
  log(`  → 已归档进事件流`)
}

// ── 执行一个任务：调 acpx ──
function runTask(task, model) {
  const env = { ...process.env, DSH_HOME: '/root/.dsh' }
  // 任务上下文：让 AI 知道这是公司派活
  const prompt = [
    `【AI公司派活】任务编号 ${task.id}`,
    `标题：${task.title}`,
    task.project ? `项目：${task.project}` : '',
    task.fromIssue ? `来源问题：${task.fromIssue}` : '',
    '',
    '请直接完成这个任务，用简洁的中文回复结果。',
    '如果你需要人工介入才能继续，请在回复开头写「BLOCKED:」并说明原因。',
  ].filter(Boolean).join('\n')

  const started = Date.now()
  try {
    const out = execFileSync('acpx', [
      'deepseek-harness', 'prompt', prompt, '-s', SESSION_NAME,
    ], {
      cwd: CWD, encoding: 'utf8', timeout: TIMEOUT_MS, env,
      maxBuffer: 8 * 1024 * 1024,
    })
    // 去掉 acpx 的运行噪音行
    const clean = out.split('\n')
      .filter(l => {
        const t = l.trim()
        if (!t) return false
        if (t.startsWith('[client]') || t.startsWith('[acpx]') || t.startsWith('[done]')) return false
        if (t.startsWith('[thinking]') || t.startsWith('[tool]')) return false   // 去掉思考/工具噪音
        return true
      })
      .join('\n').trim()
    return { ok: true, output: clean, ms: Date.now() - started }
  } catch (e) {
    const msg = String(e.stderr || e.message || e)
    return { ok: false, error: msg.slice(0, 500), ms: Date.now() - started }
  }
}

// ── 主循环：领取 → 执行 → 回写 ──
function processOne(worker, model, dryRun) {
  const claim = hb('claim', ['--worker', worker])
  if (!claim.claimed) return { ran: false, reason: claim.reason }

  const task = claim.claimed
  log(`领取任务 ${task.id}「${task.title}」（第 ${task.attempts} 次）`)

  if (dryRun) {
    log('  [dry-run] 只领取不执行')
    hb('release', ['--id', task.id])
    return { ran: false, dryRun: true, task }
  }

  const r = runTask(task, model)

  if (!r.ok) {
    log(`  ✗ 执行失败（${r.ms}ms）: ${r.error.slice(0, 120)}`)
    const f = hb('fail', ['--id', task.id, '--reason', r.error.slice(0, 200)])
    log(`  → 状态: ${f.state}${f.maxed ? ' (已达上限，需人工介入)' : ' (将重试)'}`)
    return { ran: true, task, ok: false, state: f.state }
  }

  // BLOCKED 标记 → 标记阻塞
  if (/^\s*BLOCKED:/im.test(r.output)) {
    log(`  ⚠ AI 报告阻塞`)
    hb('block', ['--id', task.id, '--reason', r.output.slice(0, 200)])
    return { ran: true, task, ok: true, state: 'blocked', output: r.output }
  }

  const d = hb('done', ['--id', task.id, '--note', r.output.slice(0, 300)])
  log(`  ✓ 完成（${r.ms}ms）: ${r.output.slice(0, 80)}`)
  // 归档：写进事件流（失败不影响主流程）
  try {
    appendToTimeline(task, r.output)
  } catch (e) { log(`  ⚠ 事件流写入失败: ${String(e.message||e).slice(0,100)}`) }
  return { ran: true, task, ok: true, state: 'done', output: r.output }
}

function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] || 'run'
  const get = (k, def) => {
    const i = argv.indexOf('--' + k)
    return i >= 0 ? argv[i + 1] : def
  }
  const worker = get('worker', 'DSH')
  const model = get('model', DEFAULT_MODEL)
  const dryRun = argv.includes('--dry-run')

  if (cmd === 'once') {
    const r = processOne(worker, model, dryRun)
    console.log(JSON.stringify(r, null, 2))
    return
  }

  // run：循环处理直到队列空
  log(`启动 worker=${worker} model=${model}${dryRun ? ' (dry-run)' : ''}`)
  if (!dryRun) ensureSession(model)

  let n = 0
  for (;;) {
    const r = processOne(worker, model, dryRun)
    if (!r.ran) { log(`队列空/无任务可领：${r.reason || ''}`); break }
    n++
    if (n >= 20) { log('本轮已处理 20 个，停止'); break }
  }
  const stats = hb('stats')
  log(`结束。本次处理 ${n} 个。当前：${JSON.stringify(stats.byState)}`)
  if (stats.blocked?.length) {
    log(`⚠ 阻塞任务 ${stats.blocked.length} 个，需人工介入：`)
    for (const b of stats.blocked) log(`   ${b.id} ${b.title} — ${b.reason || ''}`)
  }
}

main()
