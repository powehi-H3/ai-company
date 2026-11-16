#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""知识库检索"""
import sys, os, sqlite3, argparse, re

MEMORY = "/root/日常任务区/ai-memory"

def tokenize(text):
    text = str(text)
    toks = []
    for w in re.findall(r'[A-Za-z][A-Za-z0-9_\-\.]{1,}', text):
        toks.append(w.lower())
    for run in re.findall(r'[\u4e00-\u9fff]+', text):
        if len(run) == 1:
            toks.append(run)
        else:
            for i in range(len(run) - 1):
                toks.append(run[i:i+2])
    return " ".join(toks)
DB = os.path.join(MEMORY, "index.db")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="+")
    ap.add_argument("--app", help="限定来源 chatgpt/qwen")
    ap.add_argument("--role", help="限定角色 User/Assistant")
    ap.add_argument("-n", "--limit", type=int, default=10)
    ap.add_argument("--full", action="store_true", help="显示完整内容")
    a = ap.parse_args()

    q = " ".join(a.query)
    if not os.path.exists(DB):
        print("索引不存在，请先运行 scripts/index.py"); sys.exit(1)

    c = sqlite3.connect(DB)
    sql = "SELECT app,title,role,body,path FROM msg WHERE tok MATCH ?"
    toks = tokenize(q).split()
    if not toks:
        print("查询为空"); sys.exit(1)
    # 每个 token 加引号，避免 - 被当成 FTS 语法
    params = [" AND ".join(f'"{t}"' for t in toks)]
    if a.app:
        sql += " AND app=?"; params.append(a.app)
    if a.role:
        sql += " AND role=?"; params.append(a.role)
    sql += " LIMIT ?"; params.append(a.limit)

    try:
        rows = list(c.execute(sql, params))
    except sqlite3.OperationalError as e:
        print(f"查询失败: {e}"); sys.exit(1)

    if not rows:
        print(f"未找到「{q}」")
        return

    print(f"找到 {len(rows)} 条（最多显示 {a.limit}）\n" + "="*60)
    for app, title, role, body, path in rows:
        print(f"\n[{app}] {title}  [{role}]")
        if a.full:
            print(body)
        else:
            print(body[:400].replace("\n", " "))
            if len(body) > 400:
                print(f"  ...（共 {len(body)} 字）")
        print("-"*60)
    c.close()

if __name__ == "__main__":
    main()
