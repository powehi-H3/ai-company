#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
分身专用 · 查看其他 AI 的对话内容
=====================================
用途：DSH分身通过 root 通道，读取 ChatGPT/千问/DeepSeek 的对话。

为什么需要 rootc.py 而不是普通 su：
  分身（user 999）的 /sdcard 指向 /storage/emulated/999，看不到主体的 App 数据。
  普通 su 在 proot 里读不到 /data/data（实测失败）。
  只有 rootc.py 走 rootd 守护（context=u:r:ksu:s0）才是真 root。

用法（在分身里）：
  python3 <本脚本> --list              列出每个 AI 有哪些会话
  python3 <本脚本> --read chatgpt      读 ChatGPT 全部对话标题
  python3 <本脚本> --read qwen         读千问
  python3 <本脚本> --read deepseek     读 DeepSeek
  python3 <本脚本> --all               列出全部（默认）

路径说明（实测 2026-11-16）：
  ChatGPT : /data/data/com.openai.chatgpt/files/sessions/<uid>/<did>/databases/*_conversations.db
             —— 不在顶层 databases/！消息分片存 DBMessageChunk，要按 parent_id 链还原
  千问     : /data/data/com.aliyun.tongyi/databases/chat.db
  DeepSeek : /data/data/com.deepseek.chat/databases/deepseek_chat.db（有 -wal，要一起拷）

注意：WAL 模式的库必须连 -wal/-shm 一起拷，否则读到旧数据。
"""
import os, sys, json, sqlite3, subprocess, tempfile, shutil

# rootc.py 路径：分身和主体都从公司目录找；找不到再试主体路径
CANDIDATES = [
    "/storage/emulated/0/AI专用文件夹/AI公司/60-工具与备份/脚本/rootc.py",
    os.path.expanduser("~/tools/rootc.py"),
    "/root/tools/rootc.py",
]
ROOTC = next((p for p in CANDIDATES if os.path.exists(p)), None)

def root_cmd(cmd, timeout=130):
    if not ROOTC:
        raise RuntimeError("找不到 rootc.py。请把 rootc.py 放到公司脚本目录。")
    env = dict(os.environ, ROOTC_TIMEOUT=str(timeout))
    r = subprocess.run(["python3", ROOTC, cmd], capture_output=True, text=True,
                       timeout=timeout + 10, env=env)
    return r.returncode, r.stdout, r.stderr

def pull_db(device_path, tag):
    """把设备上的 db 连 wal/shm 一起拷到本地临时目录，返回本地路径。"""
    td = tempfile.mkdtemp(prefix=f"aidb_{tag}_")
    base = os.path.basename(device_path)
    local = os.path.join(td, base)
    for suffix in ["", "-wal", "-shm"]:
        rc, out, err = root_cmd(f'cp "{device_path}{suffix}" /sdcard/_aidb_tmp{suffix} 2>/dev/null; echo DONE')
        if "DONE" not in out:
            continue
        try:
            shutil.copy(f"/sdcard/_aidb_tmp{suffix}", local + suffix)
        except Exception:
            pass
    return local if os.path.exists(local) else None

# ── 各 AI 的定位器 ──────────────────────────────────────
def find_chatgpt():
    rc, out, err = root_cmd(
        'find /data/data/com.openai.chatgpt/files/sessions -name "*_conversations.db" 2>/dev/null | head -1')
    return out.strip().splitlines()[-1] if out.strip().startswith("/") else None

def find_qwen():
    return "/data/data/com.aliyun.tongyi/databases/chat.db"

def find_deepseek():
    return "/data/data/com.deepseek.chat/databases/deepseek_chat.db"

LOCATORS = {"chatgpt": find_chatgpt, "qwen": find_qwen, "deepseek": find_deepseek}

# ── 各 AI 的读会话 ──────────────────────────────────────
def sessions_chatgpt(local_db):
    c = sqlite3.connect(f"file:{local_db}?mode=ro", uri=True)
    out = []
    for cid, conv in c.execute("SELECT id, conversation FROM DBConversation"):
        try:
            j = json.loads(conv) if isinstance(conv, (str, bytes)) else conv
        except Exception:
            j = {}
        out.append((j.get("title") or "(无标题)", cid))
    c.close()
    return out

def sessions_qwen(local_db):
    c = sqlite3.connect(f"file:{local_db}?mode=ro", uri=True)
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    out = []
    # 尝试常见表名
    for t in ["session", "sessions", "conversation", "chat_session", "ChatSession"]:
        if t in tables:
            try:
                cols = [r[1] for r in c.execute(f"PRAGMA table_info({t})")]
                namecol = next((x for x in cols if "title" in x.lower() or "name" in x.lower()), cols[1] if len(cols) > 1 else cols[0])
                idcol = cols[0]
                for row in c.execute(f"SELECT {idcol}, {namecol} FROM {t} LIMIT 100"):
                    out.append((str(row[1]), str(row[0])))
                break
            except Exception:
                pass
    if not out:
        out.append((f"(表: {', '.join(tables[:10])})", ""))
    c.close()
    return out

def sessions_deepseek(local_db):
    c = sqlite3.connect(f"file:{local_db}?mode=ro", uri=True)
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    out = []
    for t in ["session", "sessions", "conversation", "chat_session"]:
        if t in tables:
            try:
                cols = [r[1] for r in c.execute(f"PRAGMA table_info({t})")]
                namecol = next((x for x in cols if "title" in x.lower() or "name" in x.lower()), cols[1] if len(cols) > 1 else cols[0])
                idcol = cols[0]
                for row in c.execute(f"SELECT {idcol}, {namecol} FROM {t} LIMIT 100"):
                    out.append((str(row[1]), str(row[0])))
                break
            except Exception:
                pass
    if not out:
        out.append((f"(表: {', '.join(tables[:10])})", ""))
    c.close()
    return out

SESSION_READERS = {
    "chatgpt": sessions_chatgpt,
    "qwen": sessions_qwen,
    "deepseek": sessions_deepseek,
}

def do_read(ai):
    print(f"\n{'='*50}\n  {ai.upper()}\n{'='*50}")
    dev = LOCATORS[ai]()
    if not dev:
        print("  ❌ 找不到数据库（可能 App 未登录或路径变了）")
        return
    print(f"  设备路径: {dev}")
    local = pull_db(dev, ai)
    if not local:
        print("  ❌ 拷贝数据库失败")
        return
    try:
        ss = SESSION_READERS[ai](local)
        print(f"  会话数: {len(ss)}")
        for title, _ in ss[:30]:
            print(f"    · {title}")
        if len(ss) > 30:
            print(f"    ... 还有 {len(ss)-30} 个")
    except Exception as e:
        print(f"  ❌ 读取失败: {e}")

def main():
    args = sys.argv[1:]
    if not ROOTC:
        print("❌ 找不到 rootc.py，无法走 root 通道")
        print("   请把 rootc.py 放到：/storage/emulated/0/AI专用文件夹/AI公司/60-工具与备份/脚本/")
        sys.exit(1)
    print(f"rootc: {ROOTC}")
    print(f"身份: ", end="")
    rc, out, err = root_cmd("id")
    print(out.strip() or "未知")

    if "--read" in args:
        i = args.index("--read")
        ai = args[i + 1] if i + 1 < len(args) else "all"
        if ai == "all":
            for k in LOCATORS:
                do_read(k)
        elif ai in LOCATORS:
            do_read(ai)
        else:
            print(f"未知 AI: {ai}（可选: {', '.join(LOCATORS)}）")
    else:
        for k in LOCATORS:
            do_read(k)
        print("\n提示：用 --read chatgpt / qwen / deepseek 单独看某一个")

if __name__ == "__main__":
    main()
