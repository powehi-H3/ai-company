#!/usr/bin/env node
/**
 * multi-ai-bridge ACP server
 * 把封闭手机 App（ChatGPT/千问/DeepSeek）包装成标准 ACP agent。
 *
 * 架构：
 *   ACP 客户端（T3/Orca/自测） ──JSON-RPC stdio──▶ 本文件（Node）
 *        │ subprocess JSON-RPC
 *        ▼
 *   bridge.py ──▶ AppAgent（Python，root 读库 / aidrop 发送）
 *
 * 会话模型：每个「ACP session」绑定一个「真实 App 的会话」。
 *   - session/new 用 mcpServers[].url 或 params 里的 agent 名指定目标 App（默认 chatgpt）
 *   - session/list 列出某 App 的真实会话（通过 session 绑定到 app）
 *   - session/prompt 把文本发给 App（投递成功即返回，异步回复走 session/update）
 */
import * as acp from "/opt/dsh/node_modules/@agentclientprotocol/sdk/dist/acp.js";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// bridge.py 在 src/ 的上级目录（multi-ai-bridge-acp/bridge.py）
const BRIDGE = join(dirname(__dirname), "bridge.py");

// ── Python bridge 子进程封装（JSON-RPC over stdio） ──────────
let pyProc = null;
let pyBuf = "";
let pyPending = new Map();
let pySeq = 0;

function ensurePy() {
  if (pyProc && !pyProc.killed) return pyProc;
  pyProc = spawn("python3", [BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
  pyBuf = "";
  pyProc.stdout.on("data", (chunk) => {
    pyBuf += chunk.toString();
    let idx;
    while ((idx = pyBuf.indexOf("\n")) >= 0) {
      const line = pyBuf.slice(0, idx).trim();
      pyBuf = pyBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const resp = JSON.parse(line);
        const p = pyPending.get(resp.id);
        if (p) {
          pyPending.delete(resp.id);
          if (resp.error) p.reject(new Error(resp.error.message));
          else p.resolve(resp.result);
        }
      } catch {}
    }
  });
  pyProc.stderr.on("data", () => {});
  return pyProc;
}

function pyCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    ensurePy();
    const id = ++pySeq;
    pyPending.set(id, { resolve, reject });
    pyProc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// ── ACP agent 实现 ──────────────────────────────────────────
class AppBridgeAgent {
  constructor() {
    // sessionId -> { agent: "chatgpt", appSessionId: "..." }
    this.sessions = new Map();
    // agent -> 缓存的最新会话列表
    this.cache = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,   // 不支持 load（App 会话只能 list/resume）
        promptCapabilities: {
          text: true,
          image: false,
        },
        sessionCapabilities: {
          list: {},           // 支持列出 App 真实会话
          resume: {},         // 支持恢复
          close: {},          // 支持关闭
        },
      },
    };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    // agent 名优先从 _meta.agent 读，其次 mcpServers，最后默认 chatgpt
    const agent = params._meta?.agent || this.#resolveAgent(params);
    const dryRun = params._meta?.dryRun === true;
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      agent,
      appSessionId: null,
      dryRun,
    });
    return { sessionId };
  }

  async listSessions(params) {
    // ACP session/list 的语义是「列出可恢复的会话」。
    // 我们把它解释为：列出所有已注册的 App 的真实会话（作为可恢复对象）。
    const agent = this.#resolveAgent(params);
    const snap = await pyCall("list_sessions", { agent });
    const sessions = snap.sessions?.sessions || [];
    return {
      sessions: sessions.map((s) => ({
        sessionId: `app:${agent}:${s.id}`,
        cwd: "/",   // zSessionInfo 必需字段
        title: s.title || "(无标题)",
        // 存真实 appSessionId 供 resume 用
        _app: agent,
        _appSessionId: s.id,
      })),
    };
  }

  async resumeSession(params) {
    // sessionId 形如 app:chatgpt:<realId>
    const [app, realId] = this.#parseAppSessionId(params.sessionId);
    const msgs = await pyCall("read_session", { agent: app, session_id: realId });
    const sessionId = params.sessionId;
    this.sessions.set(sessionId, { agent: app, appSessionId: realId });
    // ACP 不支持 transcript 回放，所以只返回确认，消息通过 update 不发（诚实标注）
    return {};
  }

  async prompt(params, cx) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    // 提取文本
    const text = this.#extractText(params.prompt);
    if (!text.trim()) throw new Error("empty prompt");

    // 发消息给 App（dryRun 模式只填不发）
    const r = await pyCall("send_message", {
      agent: session.agent,
      text,
      dry_run: session.dryRun === true,
    });

    // 通知客户端：这是「投递」不是「AI 回复」
    await cx.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: r.ok
            ? `[已投递到 ${session.agent}] ${text}`
            : `[投递失败] ${r.detail}`,
        },
      },
    });

    if (!r.ok) {
      return { stopReason: "end_turn" };
    }

    // 轮询检测回复（最多等 60 秒，异步推送）
    const reply = await this.#pollForReply(session, cx, params.sessionId);
    if (reply) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply },
        },
      });
    }

    return { stopReason: "end_turn" };
  }

  async cancel(params) {
    // App 消息无法撤回，只能标记。空操作。
  }

  async closeSession(params) {
    this.sessions.delete(params.sessionId);
    return {};
  }

  // ── 内部帮助 ────────────────────────────────────────────
  #resolveAgent(params) {
    // 优先从 params 里取，其次 mcpServers 的第一个 url 里带 agent 名
    if (params.agent) return params.agent;
    const mcp = params.mcpServers;
    if (Array.isArray(mcp) && mcp.length) {
      const u = mcp[0].url || "";
      const m = u.match(/agent=(\w+)/);
      if (m) return m[1];
    }
    return "chatgpt";
  }

  #parseAppSessionId(sessionId) {
    const parts = sessionId.split(":");
    if (parts.length >= 3 && parts[0] === "app") {
      return [parts[1], parts.slice(2).join(":")];
    }
    return ["chatgpt", sessionId];
  }

  #extractText(prompt) {
    if (typeof prompt === "string") return prompt;
    if (Array.isArray(prompt)) {
      return prompt
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
    return "";
  }

  async #pollForReply(session, cx, sessionId) {
    // 读最新会话，取最后一条 assistant 消息作为回复
    const since = null;
    // 先用 session.appSessionId，若还没绑定则取最新会话
    let appSessionId = session.appSessionId;
    if (!appSessionId) {
      const snap = await pyCall("list_sessions", { agent: session.agent });
      const list = snap.sessions?.sessions || [];
      if (!list.length) return null;
      appSessionId = list[0].id;
      session.appSessionId = appSessionId;
    }
    // 最多轮询 12 次，每次 5 秒
    let lastCount = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await pyCall("poll_reply", {
        agent: session.agent,
        session_id: appSessionId,
        since: 0,
      });
      const n = poll.new_count || 0;
      if (n > lastCount) {
        // 有新消息，读最后一条
        const msgs = await pyCall("read_session", {
          agent: session.agent,
          session_id: appSessionId,
        });
        const list = msgs.messages || [];
        if (list.length) {
          const last = list[list.length - 1];
          return `[${session.agent} 回复] ${last.text}`;
        }
      }
      lastCount = n;
    }
    return null;
  }
}

// ── 启动 ──────────────────────────────────────────────────
const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);
const agent = new AppBridgeAgent();

acp
  .agent({ name: "multi-ai-app-bridge" })
  .onRequest("initialize", (ctx) => agent.initialize())
  .onRequest("authenticate", (ctx) => agent.authenticate())
  .onRequest("session/new", (ctx) => agent.newSession(ctx.params))
  .onRequest("session/list", (ctx) => agent.listSessions(ctx.params))
  .onRequest("session/resume", (ctx) => agent.resumeSession(ctx.params))
  .onRequest("session/prompt", (ctx) => agent.prompt(ctx.params, ctx.client))
  .onRequest("session/close", (ctx) => agent.closeSession(ctx.params))
  .onNotification("session/cancel", (ctx) => agent.cancel(ctx.params))
  .connect(stream);
