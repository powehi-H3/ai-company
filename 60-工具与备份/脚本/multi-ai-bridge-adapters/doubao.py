# -*- coding: utf-8 -*-
"""豆包 (Android) 适配器
数据库: /data/data/com.larus.nova/databases/
关键: 对话存在 _encrypted_bear.db / _encrypted_benefit.db（加密），
     也有未加密的 feature_engineering.db / bd_tea_agent.db（但可能不是对话）。
结论: 对话数据库加密，无法读取明文。诚实标 unreadable，但不放弃探测未加密库。
"""
from base import AppAgent, root_cmd

class DoubaoAdapter(AppAgent):
    name = "doubao"
    display_name = "豆包"
    pkg = "com.larus.nova"
    app_key = "db"

    def locate(self):
        # 优先找未加密的、可能含对话的库
        rc, out, err = root_cmd(
            'find /data/data/com.larus.nova/databases -name "*feature_engineering*.db" 2>/dev/null | head -1')
        p = out.strip().splitlines()[-1] if out.strip() else ""
        if p.startswith("/"):
            return p
        # 兜底：bd_tea_agent.db
        rc, out, err = root_cmd(
            'find /data/data/com.larus.nova/databases -name "*bd_tea_agent*.db" 2>/dev/null | head -1')
        p = out.strip().splitlines()[-1] if out.strip() else ""
        return p if p.startswith("/") else None

    def health(self):
        # 诚实报告：对话数据库加密读不到明文，未加密库不是对话
        h = super().health()
        h["readable"] = False  # 明确：对话不可读
        h["reason"] = "对话数据库加密（_encrypted_bear.db），未加密库不含对话"
        return h

    def list_sessions(self, db_path):
        # 未加密库大概率不是对话，返回空
        return []

    def read_session(self, db_path, session_id):
        return []
