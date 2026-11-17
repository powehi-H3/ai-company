# SKILLS.md · AI公司能力索引（动手前先查这里）

> **规矩二十四（配套规矩二十三）**：任何"自动化/派活/读库/发包/审查"任务，动手前**先查本索引**。
> 有轮子 → 直接用，不重造；没有 → 造完必须**登记到本文件**再收尾。
> 目的：断上下文、换 AI、隔一周，不再"重新找重新弄"。

维护人：DSH。最近更新：2026-11-17。

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
| **给另一个 App/分身发消息（稳健）** | `send_intent.py` | `python3 .../send_intent.py --user 999 --text "..."` | ✅ 推荐 |
| 给 App 发消息（旧版/兼容） | `send_v2.py` | 坐标+中文广播，界面变易失效 | ⚠️ 遗留 |
| 读某 AI 的全部会话/导出 md | `sync.py` + adapters | 读库→脱敏→写知识库 | ✅ |
| 在分身里看其他 AI 对话 | `分身查看AI对话.py` | 走 rootc 通道 | ✅ |
| 执行真 root 命令（主体/分身） | `rootc.py` | `python3 rootc.py "命令"` | ✅ 基础设施 |
| 找 App 输入框（底层） | `find_input.py` | 输出坐标，已被 send_intent 取代 | ⚠️ 遗留 |
| 对话/产出 → 事件流 | `timeline-engine.js` | `node timeline-engine.js --project X` | ✅ |
| 实体关系图/反向查询 | `relation-engine.js` | `node relation-engine.js --who 大肥鱼` | ✅ |
| 一键立项 / 打包 / 归档 | `new-project.sh` / `pack-project.sh` / `archive-project.sh` | 见各文件头 | ✅ |
| 流程编排（1→并行→汇合） | `flow/engine.py` | `FlowEngine.load(...)` | ✅ |
| ACP 桥接（对外协议） | `multi-ai-bridge-acp/bridge.py` | JSON-RPC over stdio | ✅ |
| 推 GitHub（网络不稳） | 见能力卡5 | `git -c http.version=HTTP/1.1 ... push` | ✅ |
| 派活给 AI 的验收清单 | `09-协作能力清单.md` | 谁可读/谁跳过 | ✅ |

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
- **用法**：`python3 rootc.py "命令"`（`--role` 看主体/分身身份）
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

---

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
