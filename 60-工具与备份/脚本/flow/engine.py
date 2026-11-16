# -*- coding: utf-8 -*-
"""
flow/engine.py —— 轻量流程引擎（Node + Edge + State）

核心：把「任务流程」从写死的文档，变成可执行的结构化数据。
不引入 LangGraph/Dify 等重型框架，只实现三要素：
  - Node（节点）：一步工作，有执行者(executor)和动作(action)
  - Edge（边）：节点间的依赖关系，决定执行顺序
  - State（状态）：流程当前进度，哪些完成、哪些可做

支持三种边（覆盖"1→5-7→9"这类流程）：
  1. 顺序边   from→to，A 完成才做 B
  2. 并行边   一个节点多个出边，A 完成后 B、C 同时可做
  3. 汇合边   一个节点多个入边，B 和 C 都完成才做 D

用法：
  from engine import FlowEngine
  eng = FlowEngine.load("flows/xxx.json")
  print(eng.next_steps())     # 当前该做哪些节点
  eng.mark_done("1")          # 标记节点1完成
  print(eng.next_steps())     # 再看接下来该做谁
"""

import json
import os

class FlowEngine:
    def __init__(self, flow):
        self.flow = flow
        self.nodes = {n["id"]: n for n in flow.get("nodes", [])}
        # 前置依赖：节点 id -> 需要先完成的节点 id 集合
        self.deps = {nid: set() for nid in self.nodes}
        # 后继：节点 id -> 它的出边指向的节点 id 集合
        self.out = {nid: set() for nid in self.nodes}
        for e in flow.get("edges", []):
            frm, to = e["from"], e["to"]
            if frm not in self.nodes or to not in self.nodes:
                raise ValueError(f"边引用了不存在的节点: {frm}->{to}")
            self.deps[to].add(frm)
            self.out[frm].add(to)
        # 状态：已完成节点集合
        self.completed = set(flow.get("state", {}).get("completed", []))

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            flow = json.load(f)
        return cls(flow)

    def can_start(self, node_id):
        """某节点能否开始 = 它的所有前置都已完成，且自己没做过。"""
        if node_id in self.completed:
            return False
        return self.deps[node_id].issubset(self.completed)

    def next_steps(self):
        """当前所有可开始的节点（并行时可能返回多个）。"""
        return [nid for nid in self.nodes if self.can_start(nid)]

    def mark_done(self, node_id):
        """标记节点完成，返回是否成功。"""
        if node_id not in self.nodes:
            raise KeyError(f"节点不存在: {node_id}")
        if not self.can_start(node_id):
            raise RuntimeError(f"节点 {node_id} 的前置未完成，不能标记完成")
        self.completed.add(node_id)
        return True

    def is_done(self):
        """整个流程是否完成。"""
        return len(self.completed) == len(self.nodes)

    def status(self):
        """返回当前状态摘要：已完成/进行中/未开始 + 下一步。"""
        done = sorted(self.completed)
        todo = [nid for nid in self.nodes if nid not in self.completed]
        nexts = self.next_steps()
        return {
            "flow_id": self.flow.get("id"),
            "name": self.flow.get("name"),
            "completed": done,
            "remaining": todo,
            "next_steps": nexts,
            "done": self.is_done(),
        }

    def dump(self, path=None):
        """把当前状态写回 JSON（可选路径）。"""
        self.flow["state"] = {"completed": sorted(self.completed)}
        if path:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(self.flow, f, ensure_ascii=False, indent=2)
        return self.flow


# ── 自测：用"1→5-7(并行)→9"验证引擎逻辑 ─────────────────
if __name__ == "__main__":
    test_flow = {
        "id": "task-review",
        "name": "任务评审流程",
        "nodes": [
            {"id": "1", "name": "ChatGPT 分析", "executor": "chatgpt", "action": "analyze"},
            {"id": "5", "name": "千问写文档", "executor": "qwen", "action": "write_doc"},
            {"id": "6", "name": "DeepSeek 技术审查", "executor": "deepseek", "action": "review"},
            {"id": "7", "name": "千问润色", "executor": "qwen", "action": "polish"},
            {"id": "9", "name": "DSH 汇总输出", "executor": "dsh", "action": "summarize"},
        ],
        "edges": [
            {"from": "1", "to": "5"},
            {"from": "1", "to": "6"},
            {"from": "5", "to": "7"},
            {"from": "6", "to": "7"},
            {"from": "7", "to": "9"},
        ],
        "state": {"completed": []},
    }

    eng = FlowEngine(test_flow)
    print("=== 流程推进验证 ===")
    print("初始 next_steps:", eng.next_steps(), "（应为 ['1']）")

    eng.mark_done("1")
    print("1 完成后 next_steps:", eng.next_steps(), "（应为 ['5','6']，并行）")

    # 测试：5、6 没都完成时，7 不能开始
    print("此时 7 能否开始:", eng.can_start("7"), "（应为 False，因为 6 还没做完）")

    eng.mark_done("5")
    print("5 完成后 next_steps:", eng.next_steps(), "（应为 ['6']，因为 7 还在等 6）")

    eng.mark_done("6")
    print("6 完成后 next_steps:", eng.next_steps(), "（应为 ['7']，5和6都完成）")

    eng.mark_done("7")
    print("7 完成后 next_steps:", eng.next_steps(), "（应为 ['9']）")

    eng.mark_done("9")
    print("9 完成后 done:", eng.is_done(), "（应为 True）")
    print()
    print("=== 最终状态 ===")
    print(json.dumps(eng.status(), ensure_ascii=False, indent=2))
