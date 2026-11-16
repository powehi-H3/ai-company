#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 对话同步器 —— 读所有 App 数据库，导出为 Markdown 知识库"""
import sys, os, json, sqlite3, shutil, tempfile, subprocess, datetime, hashlib

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "adapters"))
sys.path.insert(0, os.path.join(BASE, "scripts"))

from sanitize import sanitize, report as san_report

ROOTC = "/root/日常任务区/v9-review/rootc.py"
MEMORY = "/root/日常任务区/ai-memory"

def root_cmd(cmd, timeout=130):
    env = dict(os.environ, ROOTC_TIMEOUT=str(timeout))
    try:
        r = subprocess.run(["python3", ROOTC, cmd], capture_output=True, text=True,
                           timeout=timeout + 10, env=env)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"

def fetch_db(device_path, dest_dir):
    """复制 db + wal + shm 到本地。
    关键：三个文件必须一起复制，缺 shm 会导致 WAL 内容读不到。
    """
    os.makedirs(dest_dir, exist_ok=True)
    base = os.path.basename(device_path)
    stage = f"/sdcard/_syncstage"
    root_cmd(f'rm -rf "{stage}"; mkdir -p "{stage}"')

    # 1. 在 root 侧一次性复制三个文件（保持原名）
    cmds = []
    for suffix in ["", "-wal", "-shm"]:
        cmds.append(f'cp "{device_path}{suffix}" "{stage}/{base}{suffix}" 2>/dev/null')
    root_cmd("; ".join(cmds) + "; chmod 644 " + stage + "/* 2>/dev/null; echo DONE")

    # 2. 确认哪些文件真的存在
    rc, out, err = root_cmd(f'ls -1 "{stage}" 2>/dev/null')
    present = [x.strip() for x in out.splitlines() if x.strip()]
    print(f"  暂存 {len(present)} 个: {', '.join(present)}")

    # 3. 逐个拉到本地
    got = None
    for suffix in ["", "-wal", "-shm"]:
        name = base + suffix
        if name not in present:
            continue
        src = f"{stage}/{name}"
        local = os.path.join(dest_dir, name)
        try:
            shutil.copy(src, local)
            if suffix == "":
                got = local
        except Exception as e:
            print(f"  ! 拉取 {name} 失败: {e}")

    root_cmd(f'rm -rf "{stage}"')
    # 4. 确认本地三个文件都在
    if got:
        for suffix in ["", "-wal", "-shm"]:
            lp = os.path.join(dest_dir, base + suffix)
            if os.path.exists(lp):
                print(f"    本地 {os.path.basename(lp)}: {os.path.getsize(lp):,} B")
    return got

def to_markdown(adapter, sessions, db_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    total_msgs = 0
    written = []
    for s in sessions:
        try:
            msgs = adapter.read_session(db_path, s["id"])
        except Exception as e:
            print(f"  ! 读取会话失败 {s['title'][:20]}: {e}")
            continue
        if not msgs:
            continue
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in str(s["title"]))[:40]
        fn = f"{safe}__{str(s['id'])[:8]}.md"
        path = os.path.join(out_dir, fn)
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"# {s['title']}\n\n")
            f.write(f"- 来源: {adapter.name}\n- 会话ID: `{s['id']}`\n- 消息数: {len(msgs)}\n")
            f.write(f"- 导出时间: {datetime.datetime.now().isoformat(timespec='seconds')}\n\n---\n\n")
            for m in msgs:
                role = m.get("role") or "unknown"
                text = sanitize(m.get("text") or "")
                if not text.strip():
                    continue
                f.write(f"## [{role}]\n\n{text}\n\n")
        written.append(path)
        total_msgs += len(msgs)
        print(f"    {len(msgs):5d} 条  {s['title'][:36]}")
    return written, total_msgs

def sync_one(adapter_cls, label):
    print(f"\n=== {label} ===")
    a = adapter_cls()
    dev_db = a.locate()
    if not dev_db:
        print("  ✗ 找不到数据库，跳过")
        return 0, 0
    print(f"  数据库: {dev_db}")
    work = tempfile.mkdtemp(prefix=f"sync_{a.name}_")
    local_db = fetch_db(dev_db, work)
    if not local_db or not os.path.exists(local_db):
        print("  ✗ 拉取失败，跳过")
        return 0, 0
    print(f"  已拉取: {os.path.getsize(local_db):,} 字节")
    # 强制合并 WAL：否则留在 WAL 里的数据读不到
    try:
        ck = sqlite3.connect(local_db)
        ck.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        ck.commit()
        ck.close()
        print("  已合并 WAL")
    except Exception as e:
        print(f"  ! WAL 合并失败: {e}")
    sessions = a.list_sessions(local_db)
    print(f"  会话数: {len(sessions)}")
    out = os.path.join(MEMORY, "raw", a.name)
    files, n = to_markdown(a, sessions, local_db, out)
    print(f"  ✓ 导出 {len(files)} 个文件，{n} 条消息")
    shutil.rmtree(work, ignore_errors=True)
    return len(files), n

def main():
    targets = []
    try:
        from chatgpt import ChatGPTAdapter
        targets.append((ChatGPTAdapter, "ChatGPT"))
    except Exception as e:
        print(f"ChatGPT 适配器加载失败: {e}")
    try:
        from qwen import QwenAdapter
        targets.append((QwenAdapter, "通义千问"))
    except Exception as e:
        print(f"千问适配器加载失败: {e}")
    try:
        from deepseek import DeepSeekAdapter
        targets.append((DeepSeekAdapter, "大肥鱼"))
    except Exception as e:
        print(f"大肥鱼适配器加载失败: {e}")

    only = sys.argv[1] if len(sys.argv) > 1 else None
    tot_f = tot_m = 0
    for cls, label in targets:
        if only and only.lower() not in cls.name and only.lower() not in label.lower():
            continue
        try:
            f, m = sync_one(cls, label)
            tot_f += f; tot_m += m
        except Exception as e:
            print(f"  ✗ {label} 同步异常: {e}")

    print(f"\n{'='*50}")
    print(f"总计: {tot_f} 个文件, {tot_m} 条消息")
    print(f"位置: {MEMORY}/raw/")
    print(f"\n脱敏统计:\n{san_report()}")

if __name__ == "__main__":
    main()
