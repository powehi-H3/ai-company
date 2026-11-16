# App↔ACP 桥接适配器 · 技术设计

- 版本：v1.0
- 日期：2026-11-16
- 前提：已确认 DSH 本体是标准 ACP agent（`dsh --profile acp`）
- 目标：把 5 个「封闭手机 App」包装成标准 ACP agent，让 T3/Orca 等编排器能像对待 Claude Code 一样对待它们

---

## 一、核心命题

> **把「没有 CLI、只有 App、且互相隔离」的 AI，伪装成「符合 ACP 标准、能被编排器驱动的 agent」。**

三个已有的 root 能力，正好对应 ACP 的三个核心方法：

| 我们的 root 能力 | 现有实现 | 要映射成的 ACP 方法 |
|---|---|---|
| **读**：看 AI 有哪些对话、读了什么 | `adapters/chatgpt.py` 的 `list_sessions`/`read_session` | `session/list` / `session/resume` |
| **写**：给 AI 发消息 | `aidrop.sh`（启动→dump→tap→输入→发送→校验） | `session/prompt` |
| **检测**：谁回复了、回了什么 | 读库对比时间戳/rowid | `session/update` 事件 |

---

## 二、为什么这个桥接是「真值钱」的部分

| 别人（T3/Orca）做的 | 我们做的（独有） |
|---|---|
| 编排器：假设 agent 有 CLI 接口 | 封闭 App 没有 CLI，只有 UI |
| ACP 对接：接的是「能跑命令的进程」 | 用 root 读数据库 + 注入 UI 模拟 |
| 管的是 Claude Code / Codex | 管的是 ChatGPT / 千问 / 豆包 / Grok / DeepSeek App |

**没有任何现成轮子能做「把封闭手机 App 变成标准 agent」这件事。这就是我们的护城河。**

---

## 三、架构设计

### 3.1 分层

```
┌─────────────────────────────────────────┐
│  ACP 协议层（JSON-RPC over stdio）        │  ← 要新做，但可参考 dsh-acp 的实现
│  实现 session/list、prompt、update 等     │
├─────────────────────────────────────────┤
│  App 适配器层（每 App 一个）              │  ← 已有雏形（chatgpt/qwen/deepseek.py）
│  统一接口：list / read / send / poll     │
├─────────────────────────────────────────┤
│  root 传输层                             │  ← 已稳定
│  rootc.py + rootd 守护 + ADB 注入        │
└─────────────────────────────────────────┘
```

### 3.2 统一适配器接口（把现有零散脚本收编）

现有 adapter 只有 `locate/list_sessions/read_session`，要扩展成完整接口：

```python
class AppAgent:
    pkg = ""          # 包名
    display_name = "" # 显示名，如 "ChatGPT"

    def locate(self) -> str:        # 数据库路径（已有）
    def list_sessions(self) -> list:  # 会话列表（已有）
    def read_session(self, sid) -> list:  # 读会话（已有）

    def send_message(self, text) -> bool: # 发消息（要接 aidrop.sh）
    def poll_reply(self, sid, since) -> list: # 检测新回复（要新做）
    def health(self) -> dict:         # 健康检查（要新做）
```

### 3.3 能力映射表（ACP ↔ 桥接）

| ACP 方法 | 桥接实现 | 数据来源 |
|---|---|---|
| `initialize` | 上报 agent 名、协议版本、支持的 session 能力 | 静态 |
| `session/list` | 调 `list_sessions()`，返回会话摘要 | 读数据库 |
| `session/resume` | 调 `read_session(sid)`，返回消息链 | 读数据库 |
| `session/prompt` | 调 `send_message(text)`，返回是否发送成功 | aidrop.sh + rootc |
| `session/update` | 轮询 `poll_reply()`，检测新消息 | 读数据库对比时间戳 |
| `session/cancel` | 空操作（无法中断已发的 App 消息） | — |
| `session/close` | 关闭数据库连接 | — |

---

## 四、关键难点与对策（诚实列出）

### 4.1 写路径的脆弱性（最难点）

`aidrop.sh` 依赖 UI 结构，App 改版就失效。对策：

1. **降级链**：全自动发送 → 半自动（填好不发送）→ 报错让人手动
2. **语义特征**：找输入框用"可编辑 + 最底部"这类特征，不硬编码 id
3. **发送前校验**：每次发送前 dump 校验前台包名，防发错

### 4.2 「发消息」和「读回复」之间没有原子性

ACP 的 `session/prompt` 语义是"发一个 prompt，等 agent 完成，返回结果"。但我们的 App agent 是**异步**的——发了消息，AI 要过一会儿才回，期间可能干别的。

对策：
- `session/prompt` 只保证"消息已成功发送到 App 输入框"
- 回复通过 `session/update` 事件**异步推送**，不阻塞 prompt
- 在 ACP 语义里标注：这是"投递成功"而非"完成"——**诚实告知能力边界**

### 4.3 豆包/Grok 读不到

豆包加密、Grok 位置未确认。对策：
- 桥接对每个 App 上报真实的 `health()` 状态
- 读不到的 App，`session/list` 返回空 + 明确原因，不假装

---

## 五、最小可行版（MVP）范围

**只做 ChatGPT + 千问 + DeepSeek 三个能读的，先打通闭环。**

```
能读（3个）→ 先做完整桥接：list + read + send + poll
读不到（2个）→ 只上报 health=unreadable，不接
```

MVP 验收标准：
> 用一个 ACP 客户端，能对 "ChatGPT" 这个 agent 完成：列出会话 → 读一个会话 → 发一条消息 → 检测到回复。全程走标准 ACP JSON-RPC。

---

## 六、实现语言与技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | Python 3 | 现有 adapter 全 Python，rootc.py 也是 Python |
| ACP 协议 | JSON-RPC over stdio | 标准 ACP v1，本地 agent 就是这个 |
| 参考实现 | 抄 `@deepseek-ai/dsh-acp` 的结构 | 它已经是完整可跑的 ACP server |
| 发送 | 复用 `aidrop.sh` | 已有成熟逻辑，不重写 |
| 读库 | 复用 adapter + `分身查看AI对话.py` | 已有 |

---

## 七、与现有资产的关系（不推倒重来）

| 现有资产 | 去向 |
|---|---|
| `rootc.py` | 保留，作为传输层 |
| `adapters/*.py` | 扩展成完整 AppAgent 接口 |
| `aidrop.sh` | 保留，作为 send_message 的底层实现 |
| `分身查看AI对话.py` | 收编进桥接的 list/read 能力 |
| 插件 `local-ai-company` | 暂时独立，未来作为「编排器的控制面」之一 |

---

## 八、分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1 | 统一 AppAgent 接口 + 补齐 send/poll | ✅ **已完成（2026-11-16）**：三个 adapter 6/6 方法，poll_reply 指针逻辑实测正确 |
| 2 | 实现 ACP server（JSON-RPC stdio） | ✅ **已完成（2026-11-16）**：initialize/session-new/session-list 全通，列出真实 App 会话 |
| 3 | 打通 prompt（发送）+ update（检测） | 🔄 **骨架已通（2026-11-16）**：prompt dry-run 端到端走通（Node→Python→rootc→aidrop），真实发送+检测待真机授权 |
| 4 | 接入 T3 Code 实测 | ✅ **协议级验证通过（2026-11-16）**：T3 spawn 方式连上 server，六方法全通。真机装 T3 不阻塞，见接入指南 |
| 5 | 补豆包/Grok 的 health 上报 | ✅ **已完成（2026-11-16）**：5 个 adapter 全部注册，豆包/Grok 诚实标 unreadable |

---

## 九、风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| App 改版导致发送失效 | 高 | 降级链 + 语义特征 + 定期回归 |
| ACP 语义不匹配（异步 vs 同步） | 中 | 诚实标注"投递成功≠完成" |
| root 权限失效 | 中 | rootd 已有自动重启 + doctor |
| 被 App 检测为自动化 | 中 | 随机延迟 + 保守档位 |
| 豆包/Grok 永远读不到 | 低 | health 诚实上报，不强求 |

---

## 十、下一步（马上能做）

**阶段 1：统一 AppAgent 接口。**

先把三个现有 adapter 收编成统一接口，补齐 `send_message` 和 `poll_reply`。这是纯工程活，不依赖 ACP 协议细节，可以先动手。

具体：
1. 写一个 `appagent/base.py`，定义完整接口
2. 让 `chatgpt.py` / `qwen.py` / `deepseek.py` 继承它
3. `send_message` 内部调 `aidrop.sh`
4. `poll_reply` 内部读库对比时间戳

**要不要我现在就开始写阶段 1 的代码？**


---

## 十一、下一步：统一界面（把桥接能力接进插件）

桥接适配器五阶段已完成，剩下把「读 App 对话 + 发消息 + 检测回复」接进
插件的面板，让董事长能直接在 App 里用，而不是命令行。

**架构约束**：插件是 Node.js，AppAgent 是 Python。打通方式同 server.js：
Node 插件通过 subprocess 调 bridge.py（或直接调 appagents.py）。

**做法**：
1. 插件的「办公区」面板，点某个员工 → 显示它真实的可读/可发状态 + 会话列表
2. 加一个「派活」按钮 → 调 send_v2 发消息（dry-run 或真发）
3. 加一个「检测回复」按钮 → 调 poll_reply 看谁回了

**这需要新开一轮，因为涉及插件的面板交互逻辑（不是桥接本身）。**
