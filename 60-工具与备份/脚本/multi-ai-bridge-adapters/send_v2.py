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

    # 7. 发送：优先点发送按钮，回退回车；发送后必须验证输入框已清空
    sent = _tap_send_button(pkg)
    if not sent:
        root_cmd("input keyevent 66 2>&1", timeout=30)
    time.sleep(2.5)

    # 8. 验证：重新 dump，确认输入框已清空
    ok, detail = _verify_sent(pkg, text)
    if not ok:
        return {"ok": False, "code": 11,
                "detail": f"发送未确认：{detail}（发送方式={'按钮' if sent else '回车'}）",
                "input_bounds": bounds}

    return {"ok": True, "code": 0,
            "detail": f"已确认发送（{'按钮' if sent else '回车'}）：输入框已清空",
            "input_bounds": bounds}


def _dump_ui():
    """dump 当前界面到 /sdcard，返回 xml 文本。"""
    root_cmd("uiautomator dump /sdcard/_sv2_verify.xml >/dev/null 2>&1; echo DONE", timeout=60)
    try:
        return open("/sdcard/_sv2_verify.xml", encoding="utf-8", errors="ignore").read()
    except Exception:
        return ""


def _input_text_of(xml):
    """取输入框里的文字（text 属性），找不到返回 None。"""
    for m in re.finditer(r'<node[^>]*class="android\.widget\.EditText"[^>]*>', xml):
        t = re.search(r'\btext="([^"]*)"', m.group(0))
        return t.group(1) if t else ""
    return None


def _tap_send_button(pkg):
    """
    找并点击发送按钮。策略：
      1. 找 content-desc 含「发送/send」的节点
      2. 找输入框右侧、同高度的可点节点（宽高比接近 1 的方形按钮）
    成功点中返回 True，否则 False（调用方回退回车）。
    """
    xml = _dump_ui()
    if not xml:
        return False

    # 策略1：content-desc / text 明确是发送
    for m in re.finditer(r'<node[^>]*>', xml):
        s = m.group(0)
        desc = re.search(r'content-desc="([^"]*)"', s)
        txt = re.search(r'\btext="([^"]*)"', s)
        val = ((desc.group(1) if desc else "") + (txt.group(1) if txt else "")).lower()
        if any(k in val for k in ("发送", "send", "提交")):
            b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', s)
            if b:
                x1, y1, x2, y2 = map(int, b.groups())
                if x2 > x1 and y2 > y1:
                    root_cmd(f"input tap {(x1+x2)//2} {(y1+y2)//2} 2>&1", timeout=30)
                    return True

    # 策略2：输入框右侧同高的方形可点节点
    inp = None
    for m in re.finditer(r'<node[^>]*class="android\.widget\.EditText"[^>]*>', xml):
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', m.group(0))
        if b:
            inp = tuple(map(int, b.groups()))
            break
    if not inp:
        return False
    ix1, iy1, ix2, iy2 = inp
    icx, icy = (ix1 + ix2) // 2, (iy1 + iy2) // 2

    best = None
    for m in re.finditer(r'<node[^>]*>', xml):
        s = m.group(0)
        if 'clickable="true"' not in s:
            continue
        b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', s)
        if not b:
            continue
        x1, y1, x2, y2 = map(int, b.groups())
        w, h = x2 - x1, y2 - y1
        if w <= 0 or h <= 0 or w > 200 or h > 200:
            continue
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        # 必须在输入框中心右侧（不是 x2 右侧：按钮可能压在输入框范围内）
        if cx <= icx:
            continue
        # 纵向必须和输入框重叠（同一条工具栏）
        if abs(cy - icy) > max(h, 120):
            continue
        # 方形优先，越靠右越好（发送键通常在最右）
        score = abs(w - h) + abs(cy - icy) - (cx - icx) * 0.5
        if best is None or score < best[0]:
            best = (score, cx, cy)

    if best:
        _, cx, cy = best
        root_cmd(f"input tap {cx} {cy} 2>&1", timeout=30)
        return True
    return False


def _verify_sent(pkg, text):
    """
    发送后验证：输入框必须已清空（或不再是我们的文字）。
    返回 (ok, detail)。
    """
    for attempt in range(3):
        time.sleep(1.5)
        xml = _dump_ui()
        if not xml:
            continue
        # package 必须还在目标 App
        pm = re.search(r'package="([^"]+)"', xml)
        if pm and pm.group(1) != pkg:
            return False, f"界面已切走（{pm.group(1)}）"
        cur = _input_text_of(xml)
        if cur is None:
            return True, "输入框已不存在（已发送）"
        # 输入框里还是我们的文字（取前 30 字比对）
        probe = text[:30]
        if cur.strip() and probe and probe in cur:
            if attempt < 2:
                continue
            return False, "输入框内容仍在，未发送成功"
        return True, "输入框已清空"
    return False, "无法确认（dump 失败）"


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
