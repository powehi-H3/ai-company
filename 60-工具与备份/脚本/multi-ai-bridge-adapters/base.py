# -*- coding: utf-8 -*-
"""
AppAgent 抽象基类 —— App↔ACP 桥接适配器的统一接口。

这是「阶段 1：统一 AppAgent 接口」的落地。所有 App 适配器继承本类，
实现 6 个方法，就能被上层（ACP server / 编排器）统一调用。

六个方法：
  locate()        找到数据库绝对路径（只读）
  list_sessions() 列会话摘要
  read_session()  读一个会话的消息链
  send_message()  给 App 发消息（调 aidrop.sh，只保证「投递成功」，不保证「AI 已回复」）
  poll_reply()    检测是否有新回复（读库对比时间戳）
  health()        健康检查（读得到 / 读不到 / 发送是否可用）

设计原则：
  1. 只读不写 —— 读库全程 mode=ro
  2. 诚实标注 —— 读不到就报 unreadable，不假装
  3. 发送与回复分离 —— send 是同步投递，reply 是异步事件，语义要分清
"""
import os, shutil, subprocess, tempfile, json

# rootc.py 路径候选：分身和主体都可能用，按优先级找
ROOTC_CANDIDATES = [
    "/storage/emulated/0/AI专用文件夹/AI公司/60-工具与备份/脚本/rootc.py",
    os.path.expanduser("~/tools/rootc.py"),
    "/root/tools/rootc.py",
]

def _resolve_rootc():
    for p in ROOTC_CANDIDATES:
        if os.path.exists(p):
            return p
    return None

ROOTC = _resolve_rootc()

# aidrop.sh 路径
AIDROP_CANDIDATES = [
    "/storage/emulated/0/AI专用文件夹/AI公司/60-工具与备份/脚本/aidrop.sh",
    "/data/local/tmp/aidrop.sh",
]

def _resolve_aidrop():
    for p in AIDROP_CANDIDATES:
        if os.path.exists(p):
            return p
    return None

AIDROP = _resolve_aidrop()


def root_cmd(cmd, timeout=130):
    """通过 rootd 通道执行 root 命令。返回 (returncode, stdout, stderr)。"""
    if not ROOTC:
        return (1, "", "rootc.py not found")
    env = dict(os.environ, ROOTC_TIMEOUT=str(timeout))
    try:
        r = subprocess.run(["python3", ROOTC, cmd],
                           capture_output=True, text=True, timeout=timeout + 10, env=env)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:
        return (1, "", str(e))


class AppAgent:
    """所有 App 适配器的统一抽象基类。"""

    # 子类必须覆盖
    name = "base"          # 适配器名，如 chatgpt
    display_name = "Base"  # 显示名，如 ChatGPT
    pkg = ""               # Android 包名
    app_key = ""           # aidrop.sh 用的 app_key（qwen/ds/db/gpt/grok）

    # ── 读：6 个方法中已实现的 3 个 ──────────────────────

    def locate(self):
        """返回数据库绝对路径（在设备上）。读不到返回 None。"""
        raise NotImplementedError

    def copy_db(self, dest):
        """复制 db + wal + shm 到本地 dest 目录，返回本地 db 路径。"""
        os.makedirs(dest, exist_ok=True)
        path = self.locate()
        if not path:
            return None
        base = os.path.basename(path)
        for suffix in ["", "-wal", "-shm"]:
            src = path + suffix
            rc, out, err = root_cmd(f'cp "{src}" /sdcard/_tmp_db{suffix} 2>&1; echo OK')
            if "OK" not in out:
                continue
            try:
                shutil.copy(f"/sdcard/_tmp_db{suffix}", os.path.join(dest, base + suffix))
            except Exception:
                pass
        return os.path.join(dest, base)

    def list_sessions(self, db_path):
        """返回 [{'id','title','created','updated','leaf'}] 列表。"""
        raise NotImplementedError

    def read_session(self, db_path, session_id):
        """返回 [{'role','text','ts'}] 消息链。"""
        raise NotImplementedError

    # ── 写：阶段 1 要补齐 ────────────────────────────────

    def send_message(self, text, dry_run=False):
        """
        给 App 发消息（调 aidrop.sh）。
        返回 dict：{'ok': bool, 'code': int, 'detail': str}
        语义：ok=True 表示「投递成功」，不表示「AI 已回复」。
        dry_run=True：只填文字进输入框，不点发送（安全验证链路）。
        """
        if not AIDROP:
            return {"ok": False, "code": -1, "detail": "aidrop.sh not found"}
        if not self.app_key:
            return {"ok": False, "code": -1, "detail": f"{self.name} 未配置 app_key"}
        try:
            # 用 root 通道执行 aidrop.sh（它在真机侧运行 input/uiautomator）
            dry = "--dry-run" if dry_run else ""
            rc, out, err = root_cmd(f'sh {AIDROP} {self.app_key} "{text}" {dry} 2>&1')
            # aidrop.sh 退出码：0=成功，其他=失败（1参数/2找不到App/3启动/4超时/5输入框/6键盘/7文字/8发送按钮/9没清空）
            return {"ok": rc == 0, "code": rc, "detail": (out or err).strip()[:500]}
        except Exception as e:
            return {"ok": False, "code": -1, "detail": str(e)}

    def poll_reply(self, db_path, session_id, since):
        """
        检测自 since 以来是否有新回复。
        返回 dict：{'has_new': bool, 'new_messages': [...], 'latest_ts': ...}
        since 和 latest_ts 用时间戳（秒或毫秒，由子类定），传 None 表示要全部。
        """
        raise NotImplementedError

    # ── 状态 ────────────────────────────────────────────

    def health(self):
        """
        健康检查。返回 dict：
        {'readable': bool, 'sendable': bool, 'reason': str}
        """
        readable = self.locate() is not None
        sendable = bool(AIDROP and self.app_key)
        reason = ""
        if not readable:
            reason = "数据库读不到（可能未登录/加密/路径变化）"
        if not sendable:
            reason = (reason + "；" if reason else "") + "发送通道不可用（缺 aidrop.sh 或 app_key）"
        return {"readable": readable, "sendable": sendable, "reason": reason}

    # ── 便捷：一次拿全部 ────────────────────────────────

    def snapshot(self):
        """一次返回 health + 会话列表 + 每个会话消息数。供 ACP initialize/session_list 用。"""
        h = self.health()
        if not h["readable"]:
            return {"health": h, "sessions": []}
        with tempfile.TemporaryDirectory(prefix=f"appagent_{self.name}_") as td:
            db = self.copy_db(td)
            if not db:
                return {"health": h, "sessions": []}
            try:
                sessions = self.list_sessions(db)
            except Exception as e:
                sessions = []
                h["reason"] = (h["reason"] + "；" if h["reason"] else "") + f"列会话失败: {e}"
            return {"health": h, "sessions": sessions}
