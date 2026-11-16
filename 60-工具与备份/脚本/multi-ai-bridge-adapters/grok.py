# -*- coding: utf-8 -*-
"""Grok (Android) 适配器
数据库: /data/data/ai.x.grok/databases/
现状: 只有 telemetry/exoplayer/mixpanel，没有对话数据库。
结论: 对话位置未确认，标 unreadable。
"""
from base import AppAgent

class GrokAdapter(AppAgent):
    name = "grok"
    display_name = "Grok"
    pkg = "ai.x.grok"
    app_key = "grok"

    def locate(self):
        # 没有对话数据库，返回 None
        return None

    def health(self):
        h = super().health()
        h["reason"] = "对话位置未确认（databases 下只有 telemetry/exoplayer/mixpanel）"
        return h

    def list_sessions(self, db_path):
        return []

    def read_session(self, db_path, session_id):
        return []
