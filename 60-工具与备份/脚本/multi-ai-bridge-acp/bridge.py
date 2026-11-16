# -*- coding: utf-8 -*-
"""
bridge.py —— AppAgent 的 JSON-RPC 桥接层。

Node 端的 ACP server 通过 subprocess 调用本脚本，用 JSON-RPC over stdio
与 Python 侧的 AppAgent 通信。

协议：每行一个 JSON，形如：
  {"jsonrpc":"2.0","id":1,"method":"list_sessions","params":{"agent":"chatgpt"}}
  {"jsonrpc":"2.0","id":1,"result":{...}}
  {"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"..."}}

支持的方法：
  list_agents()        → 列出所有 agent + health
  health(agent)        → 单个 agent 健康
  list_sessions(agent) → 列会话
  read_session(agent, session_id) → 读会话
  send_message(agent, text) → 发消息
  poll_reply(agent, session_id, since) → 检测新消息
"""
import sys, os, json

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "multi-ai-bridge-adapters"))

from appagents import get_agent, list_agents as _list_agents, REGISTRY

def _respond(req, result=None, error=None):
    resp = {"jsonrpc": "2.0", "id": req.get("id")}
    if error:
        resp["error"] = error
    else:
        resp["result"] = result
    sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _handle(req):
    method = req.get("method", "")
    params = req.get("params", {}) or {}

    try:
        if method == "list_agents":
            return _respond(req, result={"agents": _list_agents()})

        if method == "health":
            a = get_agent(params["agent"])
            return _respond(req, result=a.health())

        if method == "list_sessions":
            a = get_agent(params["agent"])
            return _respond(req, result={"sessions": a.snapshot()})

        if method == "read_session":
            a = get_agent(params["agent"])
            import tempfile
            with tempfile.TemporaryDirectory() as td:
                db = a.copy_db(td)
                if not db:
                    return _respond(req, error={"code": -2, "message": "数据库拷贝失败"})
                msgs = a.read_session(db, params["session_id"])
            return _respond(req, result={"messages": msgs})

        if method == "send_message":
            a = get_agent(params["agent"])
            return _respond(req, result=a.send_message(params["text"], dry_run=params.get("dry_run", False)))

        if method == "poll_reply":
            a = get_agent(params["agent"])
            import tempfile
            with tempfile.TemporaryDirectory() as td:
                db = a.copy_db(td)
                if not db:
                    return _respond(req, error={"code": -2, "message": "数据库拷贝失败"})
                r = a.poll_reply(db, params["session_id"], params.get("since"))
            return _respond(req, result=r)

        return _respond(req, error={"code": -32601, "message": f"unknown method: {method}"})

    except KeyError as e:
        return _respond(req, error={"code": -32001, "message": f"未知 agent: {e}"})
    except Exception as e:
        return _respond(req, error={"code": -32000, "message": str(e)})

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        _handle(req)

if __name__ == "__main__":
    main()
