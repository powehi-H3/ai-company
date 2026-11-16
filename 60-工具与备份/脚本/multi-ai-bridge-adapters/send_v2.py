# -*- coding: utf-8 -*-
"""
send_v2.py —— App 消息投递的 Python 侧编排器。

架构（正确版）：
  proot Python（本文件）负责「解析和编排」
  rootc（Android sh）只负责「执行」：am start / dump / input tap / input text

流程：
  1. am start 启动目标 App
  2. 轮询 dump，校验 package 属于目标 App（防界面不对：用户切屏/加载未完成等）
  3. 用 find_input.py 解析输入框坐标（三层策略：EditText / hint / Compose兜底）
  4. input tap 点击输入框
  5. input text 输入文字
  6. dry-run 时跳过「点发送」，否则点发送

返回 dict：{'ok': bool, 'code': int, 'detail': str, 'input_bounds': (x1,y1,x2,y2)}
"""
import os, sys, re, time, base64

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from base import root_cmd

FIND_INPUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "find_input.py")

# app_key -> (package, 主Activity兜底)
APP_MAP = {
    "qwen": ("com.aliyun.tongyi", "com.aliyun.tongyi/.MainActivity"),
    "ds": ("com.deepseek.chat", "com.deepseek.chat/.MainActivity"),
    "db": ("com.larus.nova", "com.larus.nova/.MainActivity"),
    "gpt": ("com.openai.chatgpt", "com.openai.chatgpt/.MainActivity"),
    "grok": ("ai.x.grok", "ai.x.grok/.MainActivity"),
}

def _dump_and_get_pkg():
    """dump 到 /sdcard，返回 (package, xml路径)。"""
    rc, out, err = root_cmd("uiautomator dump /sdcard/_send_v2.xml >/dev/null 2>&1; echo DONE", timeout=60)
    if "DONE" not in out:
        return None, None
    # 在 proot 侧读 package
    try:
        content = open("/sdcard/_send_v2.xml", encoding="utf-8", errors="ignore").read()
        m = re.search(r'package="([^"]+)"', content)
        return (m.group(1) if m else None), "/sdcard/_send_v2.xml"
    except Exception:
        return None, None

def _parse_input(xml_path):
    """用 find_input.py 解析输入框坐标。返回 (x1,y1,x2,y2) 或 None。"""
    try:
        r = os.popen(f"python3 {FIND_INPUT} {xml_path}").read().strip()
        if r:
            parts = list(map(int, r.split()))
            if len(parts) == 4:
                return tuple(parts)
    except Exception:
        pass
    return None

def send_v2(app_key, text, dry_run=False):
    """
    完整编排：启动→dump→解析→点击→输入→(发送)。
    外层 try-finally 保证无论成败都切回 DSH（修「界面停在目标 App」bug）。
    """
    try:
        return _send_v2_inner(app_key, text, dry_run=dry_run)
    finally:
        # 收尾：切回 DSH（无论成功失败，不让界面停在目标 App）
        root_cmd("am start -n io.github.ccch1mneyyy.dsh_app/.LauncherMist >/dev/null 2>&1", timeout=15)


def _send_v2_inner(app_key, text, dry_run=False):
    if app_key not in APP_MAP:
        return {"ok": False, "code": 1, "detail": f"未知 app_key: {app_key}"}

    pkg, main_act = APP_MAP[app_key]

    # 1. 启动（monkey + am start，确保目标 App 前台）
    root_cmd(f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1", timeout=30)
    root_cmd(f"am start -n {main_act} >/dev/null 2>&1", timeout=30)

    # 2. 轮询 dump，校验 package
    got_pkg = None
    xml_path = None
    for i in range(8):
        time.sleep(1.5)
        got_pkg, xml_path = _dump_and_get_pkg()
        if got_pkg == pkg:
            break

    if got_pkg != pkg:
        return {"ok": False, "code": 3, "detail": f"dump 抓到的 package={got_pkg}，不是 {pkg}（界面被切走或未加载完成）"}

    # 3. 解析输入框坐标
    bounds = _parse_input(xml_path)
    if not bounds:
        return {"ok": False, "code": 5, "detail": f"找不到输入框（find_input.py 未匹配）"}

    x1, y1, x2, y2 = bounds
    cx = (x1 + x2) // 2
    cy = (y1 + y2) // 2

    # 4. 点击输入框
    rc, out, err = root_cmd(f"input tap {cx} {cy} 2>&1", timeout=30)
    time.sleep(1)

    # 5. 输入文字：英文走 input text；中文走 ADBKeyBoard 广播（已验证可行）
    has_cn = any('\u4e00' <= ch <= '\u9fff' for ch in text)
    if has_cn:
        # 中文：切 ADBKeyBoard → base64 广播 → 还原搜狗
        sogou = "com.sohu.inputmethod.sogouoem/.SogouIME"
        adbkb = "com.android.adbkeyboard/.AdbIME"
        root_cmd(f"ime enable {adbkb} 2>/dev/null; ime set {adbkb} 2>/dev/null", timeout=30)
        time.sleep(1)
        b64 = base64.b64encode(text.encode('utf-8')).decode('ascii')
        rc, out, err = root_cmd(f'am broadcast -a ADB_INPUT_B64 --es msg "{b64}" 2>&1', timeout=30)
        time.sleep(1)
        root_cmd(f"ime set {sogou} 2>/dev/null", timeout=30)
        if "result=0" in out or "Broadcast completed" in out:
            pass  # 广播成功
        else:
            return {"ok": False, "code": 10, "detail": f"中文广播失败: {out.strip()[:200]}"}
    else:
        rc, out, err = root_cmd(f'input text "{text}" 2>&1', timeout=30)
    time.sleep(1)

    # 6. dry-run 跳过发送
    if dry_run:
        return {"ok": True, "code": 0, "detail": f"dry-run：文字已进输入框（未发送），bounds={bounds}", "input_bounds": bounds}

    # 7. 点发送（回车）
    rc, out, err = root_cmd("input keyevent 66 2>&1", timeout=30)
    time.sleep(2)

    return {"ok": True, "code": 0, "detail": f"已发送（enter），bounds={bounds}", "input_bounds": bounds}


if __name__ == "__main__":
    # CLI 自测：python3 send_v2.py <app_key> <text> [--dry-run]
    import json
    if len(sys.argv) < 3:
        print("用法: send_v2.py <qwen|ds|db|gpt|grok> <text> [--dry-run]")
        sys.exit(1)
    dry = "--dry-run" in sys.argv
    text = sys.argv[2]
    r = send_v2(sys.argv[1], text, dry_run=dry)
    print(json.dumps(r, ensure_ascii=False))
