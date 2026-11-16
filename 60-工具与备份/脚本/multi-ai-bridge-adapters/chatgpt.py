# -*- coding: utf-8 -*-
"""ChatGPT (Android) 适配器
数据库: /data/data/com.openai.chatgpt/files/sessions/<uid>/<did>/databases/*_conversations.db
难点: 消息分片存储(DBMessageChunk) + parent_id 链还原顺序
"""
import sqlite3, json
from base import AppAgent, root_cmd

class ChatGPTAdapter(AppAgent):
    name = "chatgpt"
    display_name = "ChatGPT"
    pkg = "com.openai.chatgpt"
    app_key = "gpt"

    def locate(self):
        rc, out, err = root_cmd(
            'find /data/data/com.openai.chatgpt/files/sessions -name "*_conversations.db" 2>/dev/null | head -1'
        )
        p = out.strip().splitlines()[-1] if out.strip() else ""
        return p if p.startswith("/") else None

    def list_sessions(self, db_path):
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        out = []
        for cid, conv in c.execute("SELECT id, conversation FROM DBConversation"):
            try:
                j = json.loads(conv) if isinstance(conv, (str, bytes)) else conv
            except Exception:
                j = {}
            out.append(dict(id=cid, title=j.get("title") or "(无标题)",
                            created=j.get("create_time"), updated=j.get("update_time"),
                            leaf=j.get("current_leaf_node_id")))
        c.close()
        return out

    def read_session(self, db_path, session_id):
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        # 1. 取所有消息原始 chunk 拼接
        msgs = {}
        for mid, in c.execute("SELECT id FROM DBMessage WHERE conversationId=?", (session_id,)):
            parts = []
            for (ch,) in c.execute("SELECT chunk FROM DBMessageChunk WHERE messageId=? ORDER BY chunkIndex", (mid,)):
                if isinstance(ch, bytes):
                    ch = ch.decode("utf-8", "replace")
                parts.append(ch or "")
            raw = "".join(parts)
            if not raw.strip():
                continue
            try:
                j = json.loads(raw)
            except Exception:
                continue
            content = j.get("content") or {}
            txt = content.get("content") or content.get("text") or ""
            if isinstance(txt, list):
                txt = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in txt)
            msgs[mid] = dict(id=mid, parent=j.get("parent_id"), role=j.get("role") or "unknown",
                             text=txt, ts=j.get("create_time"))
        # 2. 沿 leaf -> parent 回溯还原顺序
        leaf = None
        row = c.execute("SELECT conversation FROM DBConversation WHERE id=?", (session_id,)).fetchone()
        if row:
            try:
                leaf = (json.loads(row[0]) if isinstance(row[0], (str, bytes)) else row[0]).get("current_leaf_node_id")
            except Exception:
                pass
        chain, cur, seen = [], leaf, set()
        while cur and cur in msgs and cur not in seen:
            seen.add(cur); chain.append(msgs[cur]); cur = msgs[cur].get("parent")
        chain.reverse()
        c.close()
        return chain if chain else list(msgs.values())


    def poll_reply(self, db_path, session_id, since=None):
        """检测自 since 以来是否有新消息。since 传 None 表示返回最新消息摘要。
        ChatGPT 消息有 create_time（秒级），用 rowid 做可靠递增。"""
        import sqlite3
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        new = []
        try:
            # 用 rowid 做递增指针（比时间戳可靠）
            where = "WHERE conversationId=? AND rowid > ?" if since is not None else "WHERE conversationId=?"
            args = (session_id, since) if since is not None else (session_id,)
            rows = c.execute(f"SELECT rowid, id FROM DBMessage {where} ORDER BY rowid", args).fetchall()
            for rowid, mid in rows:
                new.append({"rowid": rowid, "id": mid})
        except Exception as e:
            pass
        c.close()
        latest = new[-1]["rowid"] if new else (since or 0)
        return {"has_new": bool(new), "new_count": len(new), "latest_pointer": latest}
