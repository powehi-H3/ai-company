# -*- coding: utf-8 -*-
"""通义千问 (Android) 适配器
数据库: /data/data/com.aliyun.tongyi/databases/chat.db
表: chat_session / chat_message_v2 (content 直接存文本，不用拼接)
"""
import sqlite3
from base import AppAgent, root_cmd

class QwenAdapter(AppAgent):
    name = "qwen"
    display_name = "通义千问"
    pkg = "com.aliyun.tongyi"
    app_key = "qwen"

    def locate(self):
        return "/data/data/com.aliyun.tongyi/databases/chat.db"

    def list_sessions(self, db_path):
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        out = []
        try:
            for sid, title in c.execute("SELECT session_id, title FROM chat_session"):
                out.append(dict(id=sid, title=title or "(无标题)", created=None, updated=None, leaf=None))
        except sqlite3.OperationalError:
            pass
        c.close()
        return out

    def read_session(self, db_path, session_id):
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = []
        cols = [d[1] for d in c.execute("PRAGMA table_info(chat_message_v2)")]
        has_role = "role" in cols
        has_ts = "create_time" in cols or "timestamp" in cols
        sql = "SELECT content" + (", role" if has_role else "") + (", create_time" if "create_time" in cols else (", timestamp" if "timestamp" in cols else "")) \
              + " FROM chat_message_v2 WHERE session_id=? ORDER BY m_index"
        try:
            for r in c.execute(sql, (session_id,)):
                txt = r[0] or ""
                role = (r[1] if has_role and len(r) > 1 else None) or "unknown"
                ts = r[-1] if has_ts else None
                if not str(txt).strip():
                    continue
                rows.append(dict(id=None, parent=None, role=str(role), text=str(txt), ts=ts))
        except sqlite3.OperationalError as e:
            print(f"[qwen] 查询失败: {e}")
        c.close()
        return rows


    def poll_reply(self, db_path, session_id, since=None):
        """千问用 m_index 做递增指针。"""
        import sqlite3
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        new = []
        try:
            where = "WHERE session_id=? AND m_index > ?" if since is not None else "WHERE session_id=?"
            args = (session_id, since) if since is not None else (session_id,)
            rows = c.execute(f"SELECT m_index FROM chat_message_v2 {where} ORDER BY m_index", args).fetchall()
            new = [r[0] for r in rows]
        except Exception:
            pass
        c.close()
        latest = new[-1] if new else (since or 0)
        return {"has_new": bool(new), "new_count": len(new), "latest_pointer": latest}
