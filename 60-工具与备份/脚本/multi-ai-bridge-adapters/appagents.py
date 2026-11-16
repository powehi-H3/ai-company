# -*- coding: utf-8 -*-
"""
appagents.py —— AppAgent 注册表 + 统一入口。

这是「阶段 1」的收口：上层（ACP server / 编排器 / CLI）不用 import 每个 adapter，
只通过本文件拿统一句柄。

用法：
  from appagents import get_agent, list_agents, all_health

  list_agents()          # [{'name','display_name','pkg','readable','sendable'}]
  get_agent('chatgpt')   # ChatGPTAdapter 实例
  all_health()           # 所有 agent 的健康状态

CLI 自测：
  python3 appagents.py          # 打印所有 agent 的健康 + 会话数
  python3 appagents.py chatgpt  # 只测 chatgpt
"""
import sys, os, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from chatgpt import ChatGPTAdapter
from qwen import QwenAdapter
from deepseek import DeepSeekAdapter
from doubao import DoubaoAdapter
from grok import GrokAdapter

REGISTRY = {
    "chatgpt": ChatGPTAdapter,
    "qwen": QwenAdapter,
    "deepseek": DeepSeekAdapter,
    "doubao": DoubaoAdapter,
    "grok": GrokAdapter,
}

def list_agents():
    """列出所有已注册 agent，附 health 摘要。"""
    out = []
    for name, cls in REGISTRY.items():
        a = cls()
        h = a.health()
        out.append({
            "name": name,
            "display_name": a.display_name,
            "pkg": a.pkg,
            "readable": h["readable"],
            "sendable": h["sendable"],
            "reason": h["reason"],
        })
    return out

def get_agent(name):
    """按 name 拿实例，未知则抛 KeyError。"""
    if name not in REGISTRY:
        raise KeyError(f"未知 agent: {name}（可用: {', '.join(REGISTRY)}）")
    return REGISTRY[name]()

def all_health():
    return {a["name"]: {"readable": a["readable"], "sendable": a["sendable"], "reason": a["reason"]}
            for a in list_agents()}


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else None

    if target:
        agents = [target]
    else:
        agents = list(REGISTRY.keys())

    for name in agents:
        try:
            a = get_agent(name)
        except KeyError as e:
            print(f"❌ {e}")
            continue

        print(f"\n{'='*50}\n  {a.display_name} ({name})\n{'='*50}")
        h = a.health()
        print(f"  可读: {'✅' if h['readable'] else '❌'}  可发: {'✅' if h['sendable'] else '❌'}")
        if h["reason"]:
            print(f"  说明: {h['reason']}")

        if not h["readable"]:
            continue

        snap = a.snapshot()
        sessions = snap.get("sessions", [])
        print(f"  会话数: {len(sessions)}")
        for s in sessions[:10]:
            print(f"    · {s.get('title', '(无标题)')}")

    print("\n（提示：阶段1接口已统一。send_message 需真机 aidrop 环境，此处只验证读路径。）")
