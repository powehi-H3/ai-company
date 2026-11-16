#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验收测试：对照计划书 S-01 ~ S-06"""
import os, sys, glob, sqlite3, subprocess, hashlib

M = "/root/日常任务区/ai-memory"
results = []

def chk(sid, desc, cond, evidence):
    results.append((sid, desc, "PASS" if cond else "FAIL", evidence))

# S-01 ChatGPT 会话数
fs = glob.glob(f"{M}/raw/chatgpt/*.md")
chk("S-01", "ChatGPT 全部会话可读", len(fs) == 10, f"{len(fs)}/10 个文件")

# S-02 千问会话数
fq = glob.glob(f"{M}/raw/qwen/*.md")
chk("S-02", "千问全部会话可读", len(fq) == 4, f"{len(fq)}/4 个文件")

# S-03 一键同步
r = subprocess.run(["./sync.sh"], capture_output=True, text=True, timeout=300)
chk("S-03", "一条命令完成同步", r.returncode == 0, f"退出码 {r.returncode}")

# S-04 全文搜索
db = f"{M}/index.db"
n = 0
if os.path.exists(db):
    c = sqlite3.connect(db)
    try:
        n = c.execute("SELECT COUNT(*) FROM msg").fetchone()[0]
    except Exception:
        pass
    c.close()
chk("S-04", "全文索引可用", n > 5000, f"索引 {n} 条")

# S-05 不破坏 App 数据
rc = subprocess.run(["python3", "/root/日常任务区/v9-review/rootc.py",
                     "ls /data/data/com.openai.chatgpt/files/sessions >/dev/null 2>&1 && echo ALIVE"],
                    capture_output=True, text=True, timeout=60)
chk("S-05", "App 数据完好", "ALIVE" in rc.stdout, "App 数据目录可访问")

# S-06 脱敏生效
sample = glob.glob(f"{M}/raw/chatgpt/*.md")
leak = 0
for f in sample:
    t = open(f, encoding="utf-8").read()
    import re
    leak += len(re.findall(r'(?<!\d)1[3-9]\d{9}(?!\d)', t))
chk("S-06", "无手机号明文泄漏", leak == 0, f"检出 {leak} 处")

print("="*58)
print(" 验收测试结果")
print("="*58)
for sid, desc, st, ev in results:
    mark = "✓" if st == "PASS" else "✗"
    print(f" {mark} {sid}  {desc:22s} {st:5s}  {ev}")
print("="*58)
p = sum(1 for r in results if r[2] == "PASS")
print(f" 通过 {p}/{len(results)}")
sys.exit(0 if p == len(results) else 1)
