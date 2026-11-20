# SKILLS.md · AI公司现有工具与能力资产索引（使用前核验）

> **规矩二十四（配套规矩二十三）**：任何"自动化/派活/读库/发包/审查"任务，动手前**先查本索引**。
> 有轮子 → 直接用，不重造；没有 → 造完必须**登记到本文件**再收尾。
> 目的：断上下文、换 AI、隔一周，不再"重新找重新弄"。

维护人：DSH。最近更新：2026-11-17。

> **适用边界（新系统接入必读）**：本文件是既有仓库的工具资产目录与历史使用笔记，不是新多 AI 协作系统的全局执行规范，也不构成任何 AI 的权限授权。表格中的“✅/推荐/已验证”表示记录编写时的状态，不能证明当前设备、账号、App 版本、部署位置或节点仍可用。调用前必须核对源文件、依赖、配置、目标节点、权限和最近一次真实验证证据。GitHub 仓库可读写不等于 Android 设备可操作；主体 DSH 的能力不自动适用于 DSH 分身或其他 AI。旧脚本尤其是归档、删除、覆盖类操作，必须先做静态审查和 dry-run，不得根据本索引直接执行。

---

## 零、怎么用（30 秒）

1. 你要做事 → 先在本文件按关键词找（下面「能力速查表」）
2. 找到 → 读对应「能力卡」的路径和用法，直接调用
3. 没找到 → 确认真没有（看 `60-工具与备份/脚本/` 全目录）→ 造 → **回来登记一张能力卡**
4. 造轮子前仍遵守规矩二十三（2 次搜索），但**先查本索引**能省掉 80% 的重复搜索

---

## 一、能力速查表（关键词 → 轮子）

| 你要做的事 | 现成轮子 | 一句话用法 | 状态 |
|---|---|---|---|
| **给另一个 App/分身发消息（候选）** | `send_intent.py` | dry-run 会切换 user 并填草稿；user ID 子串校验可能误匹配，发送确认也可能误报（S-12/S-37/S-38） | ⛔ 暂停真实投递 |
| 给 App 发消息（旧版/兼容） | `send_v2.py` | 存在 root shell 注入、共享 UI XML 残留和 dry-run 状态污染；真实投递禁用 | ⛔ 禁用 |
| 读某 AI 的全部会话/导出 md | `sync.py` + adapters | 源码候选；安全修复前禁止真实同步 | ⛔ 暂停 |
| 在分身里看其他 AI 对话 | `分身查看AI对话.py` | 走 rootc 通道 | ✅ |
| 执行真 root 命令（主体/分身） | `rootc.py` | 通用高权限入口，仅限授权设备管理节点 | ⛔ 高权限 |
| 找 App 输入框（底层） | `find_input.py` | 输出坐标，已被 send_intent 取代 | ⚠️ 遗留 |
| 对话/产出 → 事件流 | `timeline-engine.js` | 候选资产；部署状态待核验 | ⚠️ 待验证 |
| 实体关系图/反向查询 | `relation-engine.js` | 候选资产；部署状态待核验 | ⚠️ 待验证 |
| 一键立项 / 打包 / 归档 | `new-project.sh` / `pack-project.sh` / `archive-project.sh` | 归档存在 `..` 路径遍历可删除整个项目区风险；复制漏隐藏文件/忽略错误；目标包覆盖/混包风险 | ⛔ 禁止真实归档；禁止覆盖已有包 |
| 流程编排（1→并行→汇合） | `flow/engine.py` / `flow/runner.py` | runner dry-run 会填入草稿并错误推进完成状态；只允许只读查看 | ⛔ 暂停执行 |
| ACP 桥接（对外协议） | `multi-ai-bridge-acp/bridge.py` | 真实发送路径存在 root 命令注入风险；禁用 | ⛔ 禁用发送 |
| 推 GitHub（网络不稳） | 见能力卡5 | `git -c http.version=HTTP/1.1 ... push` | ✅ |
| 派活给 AI 的验收清单 | `09-协作能力清单.md` | 谁可读/谁跳过 | ✅ |
| **心跳派活（队列/状态机/重试）** | `heartbeat.js` | 仅静态审查；生产使用暂停 | ⚠️ 待安全修复 |
| **心跳 worker（真执行）** | `heartbeat-worker.js` | 禁止无人值守运行，先完成权限审计 | ⛔ 暂停 |

---

## 二、能力卡（详细，写清坑和验证）

### 能力 1：跨用户/跨 App 稳健投递 ★重点
- **路径**：`60-工具与备份/脚本/multi-ai-bridge-adapters/send_intent.py`
- **解决**：给 DSH 分身（user 999）或任意 App 发消息，输入框字数有限、界面一变就失效的老问题
- **核心方法**（界面怎么变都不怕）：
  1. **填字用 `ACTION_SEND` intent**：`am start --user N -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT '...' -n 包名/.share.ShareActivity` —— 让 App 自己填输入框，不碰坐标/输入法/编码
  2. **长文本走文件**：把内容写文件放进目标 user 可见目录（如 `/storage/emulated/999/Download/...`），只发一句"读文件执行"，绕开输入框字数限制
  3. **发按钮用 XML 语义树**：`xml.etree.ElementTree` 按 `content-desc="发送"` 找，不靠 grep 属性顺序/固定坐标
  4. **先校验 user**：`am start` 后必查 `dumpsys window | grep mCurrentFocus` 含 `u999`，否则中止（防发错人）
- **用法**：
  ```bash
  python3 send_intent.py --user 999 --text "短指令"
  python3 send_intent.py --user 999 --text-file /path/长文本.txt
  python3 send_intent.py --user 999 --text "..." --dry-run   # 只验证定位不发送
  ```
- **验证**：输出 `[5] ✅ 已发送（输入框已清空）`
- **踩过的坑**：① 主 DSH(u0) 和分身(u999) 界面一样，切 user 后用户可能切回来 → 必须每次校验 mCurrentFocus；② 旧 `send_v2.py` 靠 grep XML 文本，节点插个 `NAF="true"` 就全乱 → 已弃用
- **关联**：`08-项目启动与交付标准流程.md`、审查报告 2026-11-17
- **本机已建自动 skill**：`/root/.dsh/skills/ai-company-dispatch/SKILL.md`（热加载，catalog 里叫 `ai-company-dispatch`）——遇到派活任务 AI 会自动看到并加载，不用再发现。换机/清环境后按此路径重建。

### 能力 2：事件流引擎
- **路径**：`60-工具与备份/脚本/timeline-engine.js`（零依赖 Node ESM）
- **用法**：`node timeline-engine.js --project AI公司软件化重构 [--dry-run] [--stats]`
- **原理**：append-only 日志 + 稳定 id 幂等 + CQRS read model
- **坑**：对话原文对话时间戳用本地时区格式化；隐私 ref 用 `对话原文/<ai>/<sid>` 脱敏，不写绝对路径
- **产物**：`事件流-日志.jsonl`、`事件流-机器生成.md`

### 能力 3：关系引擎
- **路径**：`60-工具与备份/脚本/relation-engine.js`
- **用法**：`node relation-engine.js --who 大肥鱼` / `--project-query X` / 无参数重建
- **原理**：实体(project/ai/chat/artifact)-关系三元组；事实源=办公区+事件日志+语料库；read model 可重建
- **坑**：① 办公区工位是预置模板，不能当"参与证据"→ 只认对话共现；② chat 有双口径（事件日志归档 vs 语料库合计），视图已标注，别再混用 92/94
- **产物**：`关系图-*.jsonl`、`关系查询-10秒接上.md`

### 能力 4：真 root 通道
- **路径**：`60-工具与备份/脚本/rootc.py`
- **用法**：`python3 rootc.py "命令"`（`--role` 看主体/分身身份；通用 root 执行入口，仅限明确授权的设备管理节点）
- **原理**：走 rootd 守护（context=u:r:ksu:s0），proot 里普通 su 读不到 /data/data，这个能
- **坑**：分身 /sdcard = `/storage/emulated/999`，主体 = `/storage/emulated/0`；root 可跨 user 读写两者

### 能力 5：GitHub 推送（网络间歇性中断时）
- **场景**：手机网络对 GitHub 间歇性 TLS 中断（`GnuTLS recv error (-110)` / 443 超时），普通 push 反复失败
- **稳定解法**：强制 HTTP/1.1 + 低速容差
  ```bash
  TOKEN="ghp_..."
  git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
      -c http.extraheader="AUTHORIZATION: basic $(echo -n "x-access-token:$TOKEN" | base64 -w0)" \
      push origin main
  ```
- **探连通**：`curl -s -m 15 -o /dev/null -w "%{http_code}" https://github.com`（多次，200 即通；这次第3次才通）
- **坑**：token 走临时 header，remote URL 保持干净 `https://github.com/powehi-H3/ai-company.git`；别把 token 写进 remote

### 能力 6：定时任务（自动跑引擎/周期活）
- **轮子**：DSH 官方 `schedule_create` / `schedule_list`（不用第三方 dsh-automation，官方已接管）
- **实例**：`schedule-5cc7f73a-...` 每30分钟在独立会话跑 timeline+relation 引擎
- **rrule 格式**：`DTSTART;TZID=Asia/Shanghai:YYYYMMDDTHHMMSS\nRRULE:FREQ=MINUTELY;INTERVAL=30`，或 `FREQ=DAILY;BYHOUR=9;BYMINUTE=0`
- **关键**：target 选 `new_once`（后台任务独立会话，不污染主线）；prompt 写清"只跑指定命令、幂等安全、报错原样报"
- **坑**：定时任务是给 agent 的指令（自然语言），不是直接写 cron；agent 会执行其中命令

---

### 能力 7：心跳派活（Heartbeat）★核心
- **路径**：`60-工具与备份/脚本/heartbeat.js`（队列）+ `heartbeat-worker.js`（执行）
- **解决**：AI 之间发不了消息、必须人传话；任务派下去没人自动接
- **设计依据**：Paperclip（114k★）的 Heartbeat 机制 —— **agents stay dormant until real work arrives**（无事不唤醒，只事件驱动）
- **状态机**：`backlog → todo → in_progress → in_review → done`，另有 `blocked` / `cancelled`
- **用法**：
  ```bash
  # 派活
  node heartbeat.js enqueue --title "任务描述" --assignee DSH --project X
  # 执行（自动领取→调AI→回写→归档）
  # ⚠️ 历史用法示例；worker 当前暂停，不得无人值守运行\n  node heartbeat-worker.js run
  # 查看
  node heartbeat.js list / stats
  ```
- **核心机制**：
  1. **原子领取**：`O_EXCL` 创建锁文件，两个 worker 抢同一任务只有一个成功
  2. **失败重试**：最多 3 次，超限自动转 `blocked` 等人介入
  3. **自动归档**：完成后写入事件流（`事件流-日志.jsonl`）
- **执行层**：走 `acpx deepseek-harness prompt -s ai-company-worker`，模型 `["workbuddy","glm-5.3"]`
  - ⚠️ **必须用 `prompt`（持久会话）**，不能用 `exec`（一次性会话会重置成默认模型，报 no API key）
- **踩过的坑**：
  1. acp profile 默认没有 WorkBuddy 插件 → 需移植 `dsh-connect-workbuddy` + 配置（1309行）
  2. 模型 ID 格式是数组 `["workbuddy","glm-5.3"]`，不是 `workbuddy/glm-5.3`
  3. acpx 输出混入 `[thinking]` / `[tool]` 噪音，需过滤
- **验证**：15 项单测（状态机/并发/重试/死信）+ 3 次真实任务执行（消耗 WorkBuddy 积分）

---

## 高风险工具状态（2026-11-20 审计补充）

以下说明优先于上方历史能力卡中的“推荐/已验证”字样：

- `heartbeat.js`：除状态命令未校验锁所有权、允许跳过 review 直接 done 外，task ID 还被直接拼入锁路径，存在路径穿越删除风险（S-39）；当前不能作为可信任务状态机。
- `heartbeat-worker.js`：会把队列任务直接交给具备工具能力的 ACP 会话，未建立任务级工具权限和高风险审批闸门；禁止无人值守生产运行。
- `flow/runner.py`：`--step` 虽标记为 dry-run，仍会写回节点完成状态；DSH 节点还有占位实现。当前只允许只读查看流程状态。
- `multi-ai-bridge-scripts/sync.py`：固定使用 `/sdcard/_syncstage` 并执行 `rm -rf` 清理；修复临时目录安全前禁止真实同步。
- `multi-ai-bridge-adapters/send_intent.py`：`--dry-run` 会切换 user 并填充 App 输入框，不是无副作用预览。
- `rootc.py`：是通用 root 命令执行入口，不得向普通 AI 或外部 ACP agent 无差别暴露。
- `multi-ai-bridge-adapters/base.py`：`send_message()` 存在双引号 shell 命令注入风险；ACP `send_message` 路径立即禁用。`copy_db()` 还会把私有数据库复制到共享存储固定路径，存在数据泄露/并发覆盖风险。
- `multi-ai-bridge-adapters/deepseek.py`：会话 ID 被拼接进 SQL 表名，必须先做白名单校验；外部 ACP 输入不得直接传入。
- `multi-ai-bridge-acp/src/server.js`：回复轮询未用发送前游标/角色/消息关联，可能把旧消息误判为本次回复；不能作为可靠闭环证据。
- `multi-ai-bridge-scripts/sanitize.py`：脱敏规则不完整；导出对话不得标记为“已充分脱敏”，必须限制访问并做二次扫描。
- `archive-project.sh`：除 S-03/S-04/S-07 外，S-34/S-35/S-36 确认隐藏文件漏包、同日目标包混写及 `P=..` 可将整个项目区当源目录删除；必须保持禁用。
- `pack-project.sh`：存在静默删除同名旧包风险，修复前禁止覆盖已有包。

完整登记见根目录 `AI-规则冲突与兼容表.md` 的 S-01 至 S-39。上述代码本轮仅静态审查，未运行、未修改；当前设备部署状态未验证。
## 三、登记新能力（造完轮子必做）

复制下面模板，追加到「二、能力卡」：

```
### 能力 N：<名字>
- **路径**：<相对公司根的路径>
- **解决**：<什么痛点>
- **用法**：<可直接跑的命令>
- **验证**：<成功判据>
- **踩过的坑**：<避免下次重犯>
```

登记后：更新「一、速查表」一行 + 提交时 message 带"能力登记"。

---

## 四、和规矩的关系

- 规矩二十三：动手前 2 次搜索（学知识+找轮子）
- **规矩二十四（本文件）**：动手前**先查 SKILLS.md**——本公司的轮子优先于全网搜索
- 顺序：查 SKILLS.md → 有轮子直接用（省搜索） → 没有再走规矩二十三 2 搜 → 造完登记回来
