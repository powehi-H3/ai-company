# -*- coding: utf-8 -*-
"""
flow/runner.py —— 流程执行器：让流程节点驱动桥接适配器。

节点按 executor 分三类：
  - chatgpt/qwen/deepseek → 调 send_v2 发消息（默认 dry-run，真发需显式 --send）
  - dsh → 调内部逻辑（读对话/汇总，这里是占位，接真实逻辑时替换）
  - yg → 秘书手动步骤（流程停在原地，等人做完标记）

用法：
  python3 runner.py <流程json>            # 查看当前状态 + 下一步
  python3 runner.py <流程json> --step     # 执行一步（推进所有可做的节点，dry-run）
  python3 runner.py <流程json> --send     # 同上，但真发送（有副作用，慎用）

返回：执行后的状态 JSON。
"""
import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "multi-ai-bridge-adapters"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from engine import FlowEngine
from send_v2 import send_v2


def execute_node(node, dry_run=True, skip_network_check=False):
    """执行一个节点，返回 (ok, detail)。"""
    executor = node.get("executor")
    action = node.get("action", "")
    name = node.get("name", node["id"])

    # 外网检查：需外网的 AI，当前没连 VPN 时会失败，提前提示
    if node.get("requires_network") and not skip_network_check:
        # 这里不做真检测（无法自动判断 VPN 状态），只做提示
        return False, f"{name} 需要外网节点（{executor}），请确认已连 VPN 后用 --force-network 执行"

    if executor in ("chatgpt", "qwen", "deepseek", "doubao", "grok"):
        # 桥接适配器发送（AI App）
        # 把 app_key 映射：executor 名 -> send_v2 的 app_key
        app_key_map = {
            "chatgpt": "gpt",
            "qwen": "qwen",
            "deepseek": "ds",
            "doubao": "db",
            "grok": "grok",
        }
        app_key = app_key_map.get(executor, executor)
        text = f"[{name}] {action}：请执行此步骤"
        r = send_v2(app_key, text, dry_run=dry_run)
        if r.get("ok"):
            return True, f"已投递到 {executor}（{'dry-run 未发送' if dry_run else '已发送'}）"
        return False, f"{executor} 投递失败: {r.get('detail', '')}"

    elif executor == "dsh":
        # DSH 内部动作（这里占位，接真实逻辑时替换）
        return True, f"DSH 执行 {action}（内部逻辑，当前占位）"

    elif executor == "yg":
        # 秘书手动步骤：流程停在这里，等人标记
        return True, f"秘书手动步骤 {action}（需董事长完成后手动标记）"

    else:
        return False, f"未知 executor: {executor}"


def run(flow_path, do_step=False, dry_run=True, force_network=False, step_all=False):
    eng = FlowEngine.load(flow_path)

    if not do_step:
        # 只查看状态
        return eng.status()

    # 执行一步：默认只推第一个可做的节点（避免连切多个 App）；--all 才推全部
    nexts = eng.next_steps()
    if not step_all and len(nexts) > 1:
        nexts = [nexts[0]]  # 只推第一个

    executed = []
    for nid in nexts:
        node = eng.nodes[nid]
        ok, detail = execute_node(node, dry_run=dry_run, skip_network_check=force_network)
        if ok:
            eng.mark_done(nid)
        executed.append({"node": nid, "name": node["name"], "ok": ok, "detail": detail})

    # 写回状态
    eng.dump(flow_path)
    status = eng.status()
    status["executed"] = executed
    return status


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: runner.py <流程json> [--step] [--send]")
        sys.exit(1)

    flow_path = sys.argv[1]
    do_step = "--step" in sys.argv or "--send" in sys.argv
    dry_run = "--send" not in sys.argv  # 默认 dry-run，只有显式 --send 才真发
    force_network = "--force-network" in sys.argv  # 强制执行需外网的节点
    step_all = "--all" in sys.argv  # 一次推全部可做节点

    result = run(flow_path, do_step=do_step, dry_run=dry_run, force_network=force_network, step_all=step_all)
    print(json.dumps(result, ensure_ascii=False, indent=2))
