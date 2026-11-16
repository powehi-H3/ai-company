# -*- coding: utf-8 -*-
"""大肥鱼(DeepSeek) 适配器
数据库: /data/data/com.deepseek.chat/databases/deepseek_chat_<uuid>.db
结构: chat_session_list + chat_session_messages_<session_id> 每会话一张表
内容: fragments 是 JSON 数组，含 REQUEST/RESPONSE/THINK
"""
import sqlite3, json
from base import AppAgent, root_cmd

class DeepSeekAdapter(AppAgent):
    name = "deepseek"
    display_name = "大肥鱼(DeepSeek)"
    pkg = "com.deepseek.chat"
    app_key = "ds"

    def locate(self):
        rc, out, err = root_cmd(
            'find /data/data/com.deepseek.chat/databases -name "deepseek_chat_*.db" -size +100k 2>/dev/null | head -1'
        )
        p = out.strip().splitlines()[-1] if out.strip() else ""
        return p if p.startswith("/") else None

    def list_sessions(self, db_path):
        """会话列表可能被 App 清空，此时退化为扫描消息表"""
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        out = []
        titles = {}
        try:
            for sid, title, upd in c.execute(
                "SELECT id, title, updated_at FROM chat_session_list ORDER BY updated_at DESC"):
                titles[sid] = title
                out.append(dict(id=sid, title=title or "(无标题)", created=None, updated=upd, leaf=None))
        except sqlite3.OperationalError:
            pass
        # 兜底：扫所有消息表，补上会话列表里没有的
        seen = {x["id"] for x in out}
        for (t,) in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'chat_session_messages_%'"):
            sid = t.replace("chat_session_messages_", "")
            if sid in seen:
                continue
            try:
                n = c.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
            except Exception:
                continue
            if n == 0:
                continue
            out.append(dict(id=sid, title=titles.get(sid) or f"会话{sid[:8]}",
                            created=None, updated=None, leaf=None))
        c.close()
        return out

    def read_session(self, db_path, session_id):
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        t = f"chat_session_messages_{session_id}"
        rows = []
        try:
            for role, frag in c.execute(f'SELECT role, fragments FROM "{t}" ORDER BY rowid'):
                try:
                    arr = json.loads(frag) if isinstance(frag, str) else frag
                except Exception:
                    continue
                if not isinstance(arr, list):
                    continue
                # 只取 REQUEST(用户) 和 RESPONSE(回答)，跳过 THINK(思考过程)
                for item in arr:
                    typ = item.get("type")
                    content = item.get("content") or ""
                    if not content.strip():
                        continue
                    if typ == "REQUEST":
                        rows.append(dict(id=None, parent=None, role="User", text=content, ts=None))
                    elif typ == "RESPONSE":
                        rows.append(dict(id=None, parent=None, role="Assistant", text=content, ts=None))
        except sqlite3.OperationalError as e:
            print(f"[deepseek] 会话 {session_id[:8]} 读取失败: {e}")
        c.close()
        return rows


    def poll_reply(self, db_path, session_id, since=None):
        """DeepSeek 每会话一张消息表，用 rowid 检测新消息。"""
        import sqlite3
        c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        t = f"chat_session_messages_{session_id}"
        new = []
        try:
            where = "WHERE rowid > ?" if since is not None else ""
            args = (since,) if since is not None else ()
            rows = c.execute(f"SELECT rowid FROM \"{t}\" {where} ORDER BY rowid", args).fetchall()
            new = [r[0] for r in rows]
        except Exception:
            pass
        c.close()
        latest = new[-1] if new else (since or 0)
        return {"has_new": bool(new), "new_count": len(new), "latest_pointer": latest}
