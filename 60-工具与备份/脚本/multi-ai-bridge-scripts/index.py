#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""建立全文索引：SQLite FTS5，支持中文分词（用 trigram）"""
import os, re, sqlite3, glob, sys

MEMORY = "/root/日常任务区/ai-memory"
DB = os.path.join(MEMORY, "index.db")

def parse_md(path):
    """从导出的 Markdown 里拆出每条消息"""
    src = os.path.basename(os.path.dirname(path))
    txt = open(path, encoding="utf-8").read()
    title = txt.split("\n")[0].lstrip("# ").strip()
    # 拆消息块
    parts = re.split(r'\n## \[([^\]]+)\]\n\n', txt)
    # parts[0]=头部, 之后 role, body 交替
    out = []
    for i in range(1, len(parts) - 1, 2):
        role = parts[i]
        body = parts[i + 1].strip()
        if body:
            out.append((src, title, role, body))
    return out

import unicodedata

def tokenize(text):
    """自定义分词：中文按 2-gram，英文/数字按整词，保留原词"""
    text = str(text)
    toks = []
    # 英文/数字词
    for w in re.findall(r'[A-Za-z][A-Za-z0-9_\-\.]{1,}', text):
        toks.append(w.lower())
    # 中文 2-gram
    for run in re.findall(r'[\u4e00-\u9fff]+', text):
        if len(run) == 1:
            toks.append(run)
        else:
            for i in range(len(run) - 1):
                toks.append(run[i:i+2])
    return " ".join(toks)

def build():
    if os.path.exists(DB):
        os.remove(DB)
    c = sqlite3.connect(DB)
    c.execute("""CREATE VIRTUAL TABLE msg USING fts5(
        app, title, role, body, tok, path UNINDEXED, tokenize='unicode61')""")
    n = 0
    for path in glob.glob(os.path.join(MEMORY, "raw", "*", "*.md")):
        for src, title, role, body in parse_md(path):
            c.execute("INSERT INTO msg(app,title,role,body,tok,path) VALUES(?,?,?,?,?,?)",
                      (src, title, role, body, tokenize(title + " " + body), path))
            n += 1
    c.commit()
    c.execute("INSERT INTO msg(msg) VALUES('optimize')")
    c.commit()
    sz = os.path.getsize(DB)
    c.close()
    print(f"✓ 索引完成: {n:,} 条消息, {sz:,} 字节")
    return n

if __name__ == "__main__":
    build()
