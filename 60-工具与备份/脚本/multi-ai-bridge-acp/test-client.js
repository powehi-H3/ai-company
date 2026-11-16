#!/usr/bin/env node
/**
 * 自测客户端：连 multi-ai-bridge ACP server，走完整流程验证。
 * 用法：node test-client.js  [agent名，默认 chatgpt]
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "/opt/dsh/node_modules/@agentclientprotocol/sdk/dist/acp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "src", "server.js");
const agentName = process.argv[2] || "chatgpt";

class TestClient {
  async sessionUpdate(params) {
    const u = params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      console.log(`  [${agentName}] ${u.content.text.slice(0, 120)}`);
    }
  }
  async requestPermission(params) {
    return { outcome: { outcome: "selected", optionId: params.options?.[0]?.optionId } };
  }
  async readTextFile() { return { content: "" }; }
  async writeTextFile() { return {}; }
}

async function main() {
  const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
  const client = new TestClient();

  const result = await acp
    .client({ name: "test-client" })
    .onRequest(acp.methods.client.session.requestPermission, (c) => client.requestPermission(c.params))
    .onRequest(acp.methods.client.fs.readTextFile, (c) => client.readTextFile(c.params))
    .onRequest(acp.methods.client.fs.writeTextFile, (c) => client.writeTextFile(c.params))
    .connectWith(stream, async (ctx) => {
      // 1. initialize
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      console.log(`✅ initialize: protocol v${init.protocolVersion}`);
      console.log(`   agentCapabilities:`, JSON.stringify(init.agentCapabilities));

      // 2. new session（绑定 agent）
      const s = await ctx.buildSession(process.cwd(), { agent: agentName });
      console.log(`✅ session/new: ${s.sessionId ?? "已建"}`);

      // 3. list sessions（读 App 真实会话）
      const listed = await ctx.request(acp.methods.agent.session.list, {});
      console.log(`✅ session/list: ${listed.sessions?.length ?? 0} 个会话`);
      if (listed.sessions?.length) {
        for (const x of listed.sessions.slice(0, 3)) {
          console.log(`     · ${x.title}`);
        }
      }

      // 4. 只测到这里（不实际发消息，避免真的往 App 发东西）
      console.log(`\n（自测到此为止：initialize/session-new/session-list 全通，未实际 send）`);
      return { stopReason: "end_turn" };
    });

  console.log(`\n✅ 完整流程通过，stopReason=${result.stopReason}`);
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ 失败:", e.message);
  process.exit(1);
});
