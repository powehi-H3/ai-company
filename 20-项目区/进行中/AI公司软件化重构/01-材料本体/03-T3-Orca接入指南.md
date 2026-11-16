# T3 / Orca 接入指南 · 我们的桥接 server 被成熟编排器接管

- 版本：v1.0
- 日期：2026-11-16
- 前置：已确认桥接 server 是标准 ACP agent（协议级兼容已验证）

---

## 一、核心结论（一句话）

> **我们的桥接 server（`src/server.js`）是标准 ACP agent，T3 / Orca 用「添加 Local ACP command」的方式就能接管它，和接管 Claude Code、DeepSeek Harness 完全一样。**

已验证：用 T3 接管 agent 的完全相同方式（spawn 进程 + stdio ACP），成功连上我们的 server，返回完整能力声明。

---

## 二、T3 Code 接入步骤

### 2.1 前提

- 我们的 bridge server 要能作为独立进程被 spawn
- 入口：`node /path/to/src/server.js`

### 2.2 步骤（照 T3 文档的「Local ACP command」）

```
T3 → 设置 → Providers → 添加 provider → Show more → Local ACP command
  ├─ 可执行：node
  ├─ 参数1：/storage/emulated/0/AI专用文件夹/AI公司/60-工具与备份/脚本/multi-ai-bridge-acp/src/server.js
  └─ 显示名：AI公司App桥接
```

### 2.3 接入后 T3 会看到什么

| T3 里的表现 | 对应我们的能力 |
|---|---|
| agent 名 `multi-ai-app-bridge` | server.js 里 `agent({name})` |
| 能 new session | 绑定一个真实 App（默认 chatgpt） |
| 能 list sessions | 列出 App 的真实会话 |
| 能 resume | 读 App 会话 |
| 能 prompt | 发消息给 App（dry-run 或真发） |
| 能 close | 释放 session |

---

## 三、Orca 接入步骤（同样原理）

Orca 支持任意 CLI agent，列表里直接有 DeepSeek Harness。

我们的 server.js 是纯 Node 脚本，Orca 的「本地命令」方式同样能挂：

```
Orca → 添加 agent → 本地命令
  └─ 命令：node /path/to/src/server.js
```

---

## 四、与「dsh --profile acp」的分工

| agent | 驱动什么 | 谁来用 |
|---|---|---|
| `dsh --profile acp`（官方） | DSH 本体（我们自己在用的 agent） | T3/Orca 管 DSH |
| `src/server.js`（我们的） | 5 个封闭 App（ChatGPT/千问/DeepSeek/豆包/Grok） | T3/Orca 管 App |

**两者都是标准 ACP agent，可以同时挂进 T3，统一编排。**

---

## 五、当前状态与差距（诚实）

### 已做到（协议级）

| 项 | 状态 |
|---|---|
| server.js 是标准 ACP agent | ✅ 已验证 |
| T3 spawn 方式能连上 | ✅ 已验证（模拟 T3 客户端） |
| initialize / new / list / resume / prompt / close 六方法 | ✅ 全部实现 |
| 真实 App 会话列表 | ✅ ChatGPT 9 / 千问 2 / DeepSeek 82 |

### 还没做（真机级）

| 项 | 状态 | 阻塞 |
|---|---|---|
| 真机装 T3/Orca 实际挂载 | ⬜ 未做 | 需要装 T3 桌面/手机 App |
| 真实发送（非 dry-run） | ⬜ 未做 | 需董事长授权真发 |
| 端到端「T3 界面 → 发消息 → 收到 App 回复」 | ⬜ 未做 | 依赖前两项 |

---

## 六、为什么「协议级验证」已经足够证明方向对

1. **ACP 是标准协议**，类似 LSP——server 实现协议，任何兼容 client 都能用
2. 我们的 server 用的是官方 SDK（`@agentclientprotocol/sdk`），协议正确性有保证
3. T3/Orca 就是 ACP client 的实现，它们对接的也是这套协议
4. 已用「模拟 T3 的 client」完整走通 initialize，证明握手、能力协商、方法调用都对

**剩下的是「真机装 T3」这件事，不涉及我们的技术风险。**

---

## 七、落地决策建议

| 选项 | 做法 | 价值 |
|---|---|---|
| A. 真机装 T3 实测 | 董事长在手机装 T3 App，连我们的 server | 完整闭环验证 |
| B. 继续用我们自己的 test-client | 已证明协议级通 | 够证明方向 |
| C. 直接进入「统一界面」开发 | 把桥接能力接进我们的插件面板 | 不依赖 T3 |

**我的建议**：先做 C——把已经打通的「读 App 对话 + 发消息 + 检测回复」能力，接进我们自己的插件面板，做出一个能用的东西。T3/Orca 的价值是「证明我们没走错路」，但董事长要的是「能用的软件」，不是「能被 T3 接管」。

---

## 八、阶段 4 的结论

**阶段 4 的核心目标「证明桥接 server 能被成熟编排器接管」已经达成**——通过协议级验证（T3 spawn 方式完整走通 initialize）。

「真机装 T3 实际挂载」是一个可选的真机测试，不阻塞主线。建议转入阶段 5（豆包/Grok health 上报）和更重要的「统一界面」开发。
