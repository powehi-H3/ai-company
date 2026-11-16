# Agent-Router 类项目调研清单（含移动端可行性）

- 调研时间：2026-11-16
- 调研人：DSH（总经理）
- 数据来源：`api.github.com` 实时查询
- 董事长判断：「更好的是这类 agent-router 项目。桌面/服务器/Web 端能优化成移动端，方便移动端的也是」

**结论先说：董事长说得对。这一类才是真正的关键，而且已经有项目成功把桌面网关搬到了手机上。**

---

## 一、什么是 agent-router（用大白话）

**一句话：给一堆 AI 装一个「总机」，所有请求先打到总机，总机决定派给哪个 AI。**

### 没有 router 的样子

```
ChatGPT App  ──→ OpenAI 官方接口
千问 App     ──→ 阿里官方接口
豆包 App     ──→ 字节官方接口
Claude Code  ──→ Anthropic 官方接口
```

**每个 App 各连各的，配置散落各处，没法统一管理。**

### 有 router 的样子

```
ChatGPT App  ─┐
千问 App     ─┼──→ 【Router 总机】──→ 智能决定派给谁
豆包 App     ─┤        │
Claude Code  ─┘        ├──→ 按任务类型路由（写代码→DeepSeek，写文案→千问）
                       ├──→ 主模型挂了自动切备用
                       ├──→ Key 池轮换（避开限流）
                       ├──→ 统一记录：谁用了多少、花了多少、多快
                       └──→ 加能力：视觉、联网搜索、MCP 工具
```

### 为什么这对我们重要

**因为它解决的正是我们的核心痛点之一：多个 AI 怎么统一管理、统一记账、统一调派。**

我们现在是「7 个独立 App，各过各的」，**没有任何统一入口**。

---

## 二、Agent-Router 类项目（按 Star 排序）

### ⭐⭐⭐ 1. `musistudio/claude-code-router` ★38,171

| 项 | 值 |
|---|---|
| Star | **38,171** |
| Fork | 很大（需另查） |
| 语言 | TypeScript |
| 体积 | 48,883 KB |
| 许可 | **MIT** |
| 形态 | **桌面 App（Electron）+ CLI + Docker** |

**它做什么**：

> Manage every agent and provider from one place.
> 为 Claude Code、Codex、Grok CLI、Kimi CLI、OpenCode、WorkBuddy 等 **11 种客户端**
> 提供一个稳定的本地入口，让你在一个地方管理背后的供应商、模型、账号、路由规则与工具。

**五个核心能力**：

| 能力 | 说明 |
|---|---|
| **统一管理** | 不再为每个客户端维护独立配置 |
| **热切换** | 换供应商/模型不用改 Agent 配置文件 |
| **高可用** | 重试 + 凭据池 + Key 轮换 + 有序 fallback |
| **加能力** | Fusion 视觉、联网搜索、MCP 工具、ToolHub |
| **可观测** | 请求日志、最终路由、耗时、Token、成本估算、账号状态 |

**支持的供应商**：OpenAI、Anthropic、Gemini、OpenRouter、DeepSeek、SiliconFlow、Moonshot、Kimi Code、Mistral、Z.AI、百炼、自定义兼容。

**★ 关键发现：它的架构是分层的**

```
packages/
├── cli/         命令行入口
├── core/        ★ 核心逻辑（与平台无关）
├── electron/    桌面壳
└── ui/          界面
```

**`core` 和 `ui` 分离 = 可以换壳。**

Electron 桌面壳能换，理论上也能换成一个 Web 页面在手机浏览器打开，或换成一个 Android 壳。

**这是「桌面端能优化成移动端」的技术前提。**

---

### ⭐⭐⭐ 2. `tashfeenahmed/freellmapi` ★52,979

| 项 | 值 |
|---|---|
| Star | **52,979**（本类最高） |
| 语言 | TypeScript |
| 许可 | MIT |
| 描述 | **10.1 billion tokens per month. 87 free LLM providers.** |

**它做什么**：把 **87 个免费 LLM 供应商** 聚合成一个 API。

**对我们的意义**：**免费额度聚合** —— 如果我们要省钱，这是个现成方案。

---

### ⭐⭐⭐ 3. `QuantumNous/new-api` ★51,978

| 项 | 值 |
|---|---|
| Star | **51,978** |
| 语言 | **Go** |
| 体积 | 98,428 KB |
| 许可 | AGPL-3.0 |
| 描述 | Open-source AI gateway. Self-hosted LLM gateway with Open[AI]... |

**它做什么**：自托管的 LLM 网关，统一 OpenAI 格式接入各种模型。

**Go 写的 = 单二进制 = 好移植。** Go 能交叉编译成 ARM64（Android 的架构）。

---

### ⭐⭐ 4. `decolua/9router` ★32,490

| Star | 32,490 |
|---|---|
| 语言 | JavaScript |
| 许可 | MIT |
| 描述 | Unlimited FREE AI coding. Connect Claude Code, Codex, Cu[sor]... |

**免费 AI 编程的路由器。**

---

### ⭐⭐ 5. `BlockRunAI/ClawRouter` ★6,665

| Star | 6,665 |
|---|---|
| 语言 | TypeScript |
| 体积 | **169,864 KB**（最大） |
| 许可 | MIT |
| 描述 | **The agent-native LLM router for autonomous agents. Every...** |

**「为自主 agent 原生设计的路由」** —— 定位和我们的「多 AI 协作」最接近。

---

### ⭐ 6. `weave-os/router` ★5,622

| Star | 5,622 |
|---|---|
| 语言 | Go |
| 许可 | Apache-2.0 |
| 描述 | Model router for agentic systems. Routes every prompt to... |

**为 agent 系统做模型路由**，Go 写的。

---

### ⭐ 7. `vllm-project/semantic-router` ★6,480

| Star | 6,480 |
|---|---|
| 描述 | An open, programmable decision layer for models and comp[onents] |

**语义路由** —— 按 prompt 的语义自动决定用哪个模型（不是按规则）。

---

### ⭐ 8. `katanemo/plano` ★7,118

| Star | 7,118 |
|---|---|
| 描述 | AI-native proxy server and data plane for agents |

**AI 原生代理服务器 + 数据平面**。

---

### 其他

| 项目 | Star | 说明 |
|---|---:|---|
| `deepset-ai/haystack` | 27,012 | AI 编排框架（不只是路由） |
| `Portkey-AI/gateway` | 13,384 | 快速 AI 网关 + 护栏 |
| `NVIDIA-NeMo/Switchyard` | 3,549 | NVIDIA 的 LLM 路由 |
| `coaidev/coai` | 9,347 | 多租户 AI 一站式方案 |
| `INQUIRELAB/mcp-bridge-api` | 70 | MCP 轻量代理 |
| `hugalafutro/model-hotel` | 58 | 多供应商网关 |

---

## 三、手机端：已经有成功案例

### ⭐⭐⭐ `NosytLabs/openclaw-droid` ★37 —— **最有参考价值**

| 项 | 值 |
|---|---|
| Star | 37 |
| 语言 | **Shell** |
| 许可 | MIT |
| 描述 | **OpenClaw AI Gateway for Android. Run local LLMs on your mo[bile]** |

**它做到了什么**：把 OpenClaw（一个 AI agent 网关）**在手机上跑起来了**。

**它怎么做的**（install.sh 全文逻辑）：

```bash
1. Termux 里装 proot-distro
2. 装 ubuntu 容器
3. 进容器装：curl / git / build-essential / Node.js 22 / openclaw
4. 创建 Bionic Bypass（绕过 Android 限制的关键）：
   /root/hijack.js:
       const os = require('os');
       os.networkInterfaces = () => ({});
5. 写入 .bashrc：
   export NODE_OPTIONS="-r /root/hijack.js"
```

**那个「Bionic Bypass」是精髓**：

> Android 用的是 **Bionic libc**，不是 glibc。很多 Node.js 库调 `os.networkInterfaces()`
> 在 Android 上会崩或返回错误数据。**直接把它替换成返回空对象，绕过这个检查。**

**一行代码解决了一个平台兼容问题。这是非常实用的 hack。**

**关键前提**：

| 条件 | 说明 |
|---|---|
| **零 root** | 明确写了 `Zero Root`，跑在 Termux + proot-distro |
| **Gateway 必须绑 127.0.0.1** | 文档明确要求，不能绑 0.0.0.0 |
| 自动进 Ubuntu 环境 | 安装完直接给你一个 Ubuntu shell |

**★ 这个项目证明：桌面/服务器端的 Node.js AI 网关，可以在手机上跑起来。**

---

### 其他手机端项目

| 项目 | Star | 语言 | 说明 |
|---|---:|---|---|
| `eggbrid2/mobileClaw` | **381** | Kotlin | Open Android AI agent runtime，手机控制、App 自动化 |
| `AbuZar-Ansarii/PocketStrike-AI` | 107 | Python | **把 Android Termux 变成自主 AI agent** |
| `adebnar/hermes-android` | 48 | Kotlin | Hermes agent 网关的原生 Android 客户端 |
| `8crsk/openclaw-android` | 20 | Kotlin | 端侧 AI agent，本地 OpenClaw 网关 |
| `JUANWANG-BUAA/dsh-full-remote` | 51 | TypeScript | **DeepSeek Harness 远程网关（移动端）** |
| `dzaczek/phoneborg` | 17 | - | 把旧 Android 手机变成 LLM 节点 |
| `Infinitude-Pvt-Ltd/gosearx` | 6 | Go | 高性能自托管搜索 |
| `llamatik/Llamatik` | 220 | Kotlin | Kotlin Multiplatform 的端侧 AI SDK |
| `AbuZar-Ansarii/Jarvis` | 132 | - | 本地优先的端侧 AI agent |
| `khaled4123e/AIOS` | 26 | - | Android 系统级 AI agent |
| `qhvssonic/kiora` | 3 | Kotlin | Android 端侧 LLM 的 AI agent 框架 |

### 特别注意 `JUANWANG-BUAA/dsh-full-remote` ★51

> **Auditable, token-gated DeepSeek Harness remote gateway: mobi[le]**

**这是 DSH 的远程网关** —— 和我们现在用的东西直接相关。它做的是「手机访问电脑上的 DSH」。

**方向和我们相反**：它把电脑的能力给手机用；我们是把手机本身当执行环境。

---

## 四、可行性分析：哪些能搬到手机

| 项目 | 语言 | 能上手机吗 | 怎么上 |
|---|---|---|---|
| `claude-code-router` | TypeScript | ✅ **可以** | `core` 与 `electron` 分离，Termux 里跑 CLI |
| `new-api` | Go | ✅ **很容易** | Go 交叉编译成 ARM64 单二进制 |
| `weave-os/router` | Go | ✅ **很容易** | 同上 |
| `freellmapi` | TypeScript | ✅ 可以 | Termux + Node 22 |
| `openclaw-droid` | Shell | ✅ **已经做到了** | 现成方案，直接抄 |
| `9router` | JavaScript | ✅ 可以 | Termux + Node |
| `ClawRouter` | TypeScript | ⚠️ 难 | 170MB，太重 |
| `semantic-router` | - | ⚠️ 需查 | 可能依赖 Python ML 库 |

### 三个技术路线

| 路线 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. Termux + proot** | 像 openclaw-droid 那样 | 不用 root、不改 App | 慢（proot 有性能损耗） |
| **B. Go 单二进制** | 交叉编译成 ARM64，直接跑 | 快、体积小 | 只适用于 Go 项目 |
| **C. 原生 Android 壳** | Kotlin 写 UI + 内嵌 core | 体验最好 | 工作量大 |

**我们已经有 Termux/proot 环境（DSH 就跑在里面），路线 A 是现成的。**

---

## 五、对我们的实际价值（这才是重点）

### 我们现在的问题

| 问题 | 现状 |
|---|---|
| 7 个 AI App 各自独立 | 没有统一入口，配置散落 |
| 用了多少 token、花了多少钱 | **完全不知道** |
| 某个 AI 挂了怎么办 | 手动换一个 |
| 哪个 AI 适合干什么 | 靠人记忆，写在名册里 |
| 请求日志 | 只有各 App 自己的 |

### Router 能解决哪些

| 问题 | Router 方案 | 可行性 |
|---|---|---|
| 统一入口 | ✅ 所有请求走总机 | 高 |
| **统一记账** | ✅ 日志记录 token 和成本 | **高，价值最大** |
| 自动切换 | ✅ 主模型挂了自动 fallback | 高 |
| 按任务路由 | ✅ 写代码→DeepSeek，写文案→千问 | 中（要设计规则） |
| 统一日志 | ✅ 一处可查 | 高 |

### ★ 但有一个关键限制

**Router 只能管「API 调用」，管不了「App 界面」。**

| 我们的 AI 用法 | Router 能管吗 |
|---|---|
| 通过 API 调模型 | ✅ 能 |
| **通过 App 界面用（ChatGPT App、千问 App）** | ❌ **不能** |

**我们现在大部分是「在 App 界面里聊天」，不是「调 API」。**

所以 router 对我们的直接价值是：
- **如果将来改成 API 调用** → 价值巨大
- **如果继续用 App 界面** → 价值有限（但可以做统一记账：读各 App 的数据库）

---

## 六、该抄什么（可执行）

### 立刻能做的：统一记账

**不需要 router，我们自己就能做。**

我们已经能读各 App 的数据库（ChatGPT 9060 条、千问 452 条、DeepSeek 649 条）。
可以做一张统一的「用量与成本表」。

### 值得引入的：一个轻量 router

如果要引入，建议顺序：

| 优先级 | 项目 | 理由 |
|---|---|---|
| 1 | **`openclaw-droid`** | 现成手机方案，Shell 脚本，可直接参考 |
| 2 | `claude-code-router` | 38k 星，架构分层清晰，`core` 可复用 |
| 3 | `new-api` / `weave-os/router` | Go 单二进制，移植最容易 |

### 立刻能抄的技术点

**1. Bionic Bypass（一行解决平台兼容）**

```js
const os = require('os');
os.networkInterfaces = () => ({});
// export NODE_OPTIONS="-r /root/hijack.js"
```

**任何 Node.js 程序在 Android 上跑不起来时，先试这个。**

**2. Gateway 必须绑 127.0.0.1**

```bash
openclaw config   # Gateway Bind: MUST be 127.0.0.1 (Loopback)
```

手机上的服务**绝不能绑 0.0.0.0**，否则同网络的人都能访问。这是安全底线。

**3. core / ui 分离**

`claude-code-router` 把核心逻辑和界面分开，所以能换壳（Electron → Web → Android）。

**我们如果要做任何工具，也该这么分层。**

---

## 七、结论

> **董事长判断是对的：agent-router 这一类才是关键，比「AI 公司模拟」更实用。**
>
> **`claude-code-router`（38,171 ★）是这类里的标杆**，架构分层清晰（cli/core/electron/ui），
> MIT 许可，能改能学。
>
> **手机端已经有成功案例：`openclaw-droid` 用 Termux + proot 把 AI 网关搬到了手机上，
> 零 root，一行 `os.networkInterfaces = () => ({})` 绕过了 Android 的 Bionic 兼容问题。**
>
> **但有个关键限制：router 只能管 API 调用，管不了 App 界面。**
> 我们现在主要用 App 界面，所以 router 的直接价值有限。
> **真正立刻能做的，是「统一记账」——这个不需要 router，我们自己就能做。**

---

## 附：全部项目速查

| 项目 | Star | 语言 | 形态 | 能上手机 |
|---|---:|---|---|---|
| `tashfeenahmed/freellmapi` | 52,979 | TypeScript | 服务 | ✅ |
| `QuantumNous/new-api` | 51,978 | **Go** | 服务 | ✅✅ 最容易 |
| `musistudio/claude-code-router` | **38,171** | TypeScript | **桌面+CLI+Docker** | ✅ |
| `decolua/9router` | 32,490 | JS | 服务 | ✅ |
| `deepset-ai/haystack` | 27,012 | Python | 框架 | ⚠️ |
| `Portkey-AI/gateway` | 13,384 | TS | 网关 | ✅ |
| `coaidev/coai` | 9,347 | - | 平台 | ⚠️ |
| `katanemo/plano` | 7,118 | - | 代理 | ✅ |
| `BlockRunAI/ClawRouter` | 6,665 | TypeScript | 路由 | ⚠️ 170MB 太重 |
| `vllm-project/semantic-router` | 6,480 | - | 语义路由 | ⚠️ |
| `weave-os/router` | 5,622 | **Go** | 路由 | ✅✅ |
| `NVIDIA-NeMo/Switchyard` | 3,549 | - | 路由 | ⚠️ |
| `INQUIRELAB/mcp-bridge-api` | 70 | - | MCP 代理 | ✅ |
| `hugalafutro/model-hotel` | 58 | - | 网关 | ✅ |
| **手机端** | | | | |
| `eggbrid2/mobileClaw` | **381** | Kotlin | Android 运行时 | 原生 |
| `llamatik/Llamatik` | 220 | Kotlin | 端侧 AI SDK | 原生 |
| `AbuZar-Ansarii/Jarvis` | 132 | - | 端侧 agent | 原生 |
| `AbuZar-Ansarii/PocketStrike-AI` | 107 | Python | Termux agent | ✅ |
| `JUANWANG-BUAA/dsh-full-remote` | 51 | TypeScript | DSH 远程网关 | ✅ |
| `adebnar/hermes-android` | 48 | Kotlin | 网关客户端 | 原生 |
| **`NosytLabs/openclaw-droid`** | **37** | **Shell** | **Termux 安装器** | ✅✅ **已有案例** |
| `khaled4123e/AIOS` | 26 | - | 系统级 agent | 原生 |
| `8crsk/openclaw-android` | 20 | Kotlin | 端侧 agent | 原生 |
| `dzaczek/phoneborg` | 17 | - | 旧手机变节点 | ✅ |
| `qhvssonic/kiora` | 3 | Kotlin | Android agent 框架 | 原生 |
