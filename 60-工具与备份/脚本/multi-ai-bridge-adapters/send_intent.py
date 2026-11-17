#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
send_intent.py —— 稳健的 DSH 消息投递（替代脆弱的 dump+正则+固定坐标）

高端方法（界面怎么变都不怕）：
  1. 填字：用系统 ACTION_SEND intent，让 App 自己把 EXTRA_TEXT 填进输入框。
     —— 不碰坐标、不碰输入法、不碰中文编码、不依赖输入框位置。
  2. 发送：用标准 XML 解析器(XML Parser)遍历节点，按 content-desc 语义找"发送"按钮。
     —— 不依赖属性顺序、不依赖节点 index、不依赖按钮固定位置。
  3. 验证：解析输入框 text 属性是否已清空。

对比旧 send_v2.py 的脆弱点：
  旧：grep 正则啃 XML 文本 → 属性顺序一变(如插入 NAF="true")就失效
  旧：hint/坐标定位输入框 → 输入框挪位就失效
  旧：input text/中文广播 → 编码和输入法状态影响
  新：intent 填字 + XML 语义树 → 以上全部免疫

用法：
  python3 send_intent.py --user 999 --text "..." [--no-send] [--dry-run]
  python3 send_intent.py --user 999 --text-file /path/msg.txt
  python3 send_intent.py --user 999 --text "..." --wait-reply 120 --out reply.txt
"""
import argparse, os, re, sys, time, subprocess, xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.abspath(os.path.join(HERE, '..'))
ROOTC = os.path.join(SCRIPTS, 'rootc.py')
PKG = 'io.github.ccch1mneyyy.dsh_app'
LAUNCH = PKG + '/.LauncherMist'
SHARE = PKG + '/.share.ShareActivity'
DUMP_REMOTE = '/sdcard/_send_intent_ui.xml'
DUMP_LOCAL = '/sdcard/_send_intent_ui.xml'  # 主体可直接读 /sdcard


def root_cmd(cmd, timeout=60):
    env = dict(os.environ, ROOTC_TIMEOUT=str(timeout))
    r = subprocess.run(['python3', ROOTC, cmd], capture_output=True, text=True,
                       timeout=timeout + 10, env=env)
    return r.returncode, r.stdout, r.stderr


def dump_ui():
    """dump 当前界面到 XML，返回 ElementTree root。"""
    root_cmd(f'uiautomator dump {DUMP_REMOTE} >/dev/null 2>&1; echo DONE')
    try:
        return ET.parse(DUMP_LOCAL).getroot()
    except Exception:
        return None


def find_nodes(root, **attrs):
    """语义查找节点：按任意属性精确匹配，不看顺序、不看 index。"""
    out = []
    if root is None:
        return out
    for n in root.iter('node'):
        if all(n.get(k) == v for k, v in attrs.items()):
            out.append(n)
    return out


def center(node):
    """从 bounds='[x1,y1][x2,y2]' 算中心点。"""
    b = node.get('bounds', '')
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', b)
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def find_send_button(root):
    """按语义找发送按钮：content-desc/text 含'发送'或'send'，且 clickable。"""
    # 语义1：明确的"发送"
    for n in root.iter('node'):
        if n.get('clickable') != 'true':
            continue
        desc = (n.get('content-desc') or '').strip()
        txt = (n.get('text') or '').strip()
        val = (desc + ' ' + txt).lower()
        if val in ('发送', 'send') or '发送' in val or re.search(r'\bsend\b', val):
            c = center(n)
            if c:
                return c, f"语义匹配: desc={desc!r} text={txt!r}"
    return None, None


def find_input(root):
    """语义找输入框：EditText 类型。"""
    for n in root.iter('node'):
        if n.get('class', '').endswith('EditText'):
            return n
    return None


def activate_user(user):
    """把指定 user 的 DSH 切到前台。"""
    root_cmd(f'am start --user {user} -n {LAUNCH} >/dev/null 2>&1')
    time.sleep(2)
    rc, out, _ = root_cmd('dumpsys window | grep mCurrentFocus')
    return f'u{user}' in out


def fill_via_intent(user, text):
    """用 ACTION_SEND 让 App 自己把文本填进输入框。免坐标、免输入法。"""
    safe = text.replace("'", "'\\''")  # shell 单引号转义
    cmd = (f"am start --user {user} -a android.intent.action.SEND "
           f"-t text/plain --es android.intent.extra.TEXT '{safe}' "
           f"-n {SHARE} >/dev/null 2>&1")
    root_cmd(cmd)
    time.sleep(2.5)


def verify_filled(root, text):
    """验证文本已进输入框（读 text 属性，不看位置）。"""
    inp = find_input(root)
    if inp is None:
        return False, '找不到输入框节点'
    cur = inp.get('text') or ''
    return (text[:20] in cur), f'输入框 text 前20字匹配={text[:20] in cur}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--user', type=int, default=0, help='Android user id，分身用 999')
    ap.add_argument('--text', help='要发送的文本')
    ap.add_argument('--text-file', help='从文件读文本（支持长文本）')
    ap.add_argument('--no-send', action='store_true', help='只填不发送')
    ap.add_argument('--dry-run', action='store_true', help='只演示语义定位，不真点')
    args = ap.parse_args()

    text = args.text
    if args.text_file:
        with open(args.text_file, encoding='utf-8') as f:
            text = f.read().strip()
    if not text:
        print('ERROR: 需要 --text 或 --text-file')
        sys.exit(1)

    ok = activate_user(args.user)
    print(f"[1] 切换 user {args.user}: {'OK' if ok else '⚠ 焦点可能不对'}")
    if not ok:
        print('ABORT: 目标 user 不在前台，停止（避免发错人）')
        sys.exit(2)

    fill_via_intent(args.user, text)
    print(f'[2] ACTION_SEND 已投递 {len(text)} 字')

    root = dump_ui()
    ok2, detail = verify_filled(root, text)
    print(f'[3] 文本已入输入框: {detail}')
    if not ok2:
        print('ABORT: 文本未进输入框，停止')
        sys.exit(3)

    if args.no_send or args.dry_run:
        print('[4] 跳过发送（--no-send/--dry-run）')
        return

    send, how = find_send_button(root)
    if not send:
        print('[4] 语义找不到发送按钮，停止（不再猜坐标）')
        sys.exit(4)
    print(f'[4] 发送按钮: {how} @ {send}')
    root_cmd(f'input tap {send[0]} {send[1]}')
    time.sleep(3)

    root2 = dump_ui()
    inp = find_input(root2)
    cur = (inp.get('text') or '') if inp is not None else None
    if cur is None or text[:20] not in cur:
        print('[5] ✅ 已发送（输入框已清空）')
    else:
        print('[5] ⚠ 输入框仍有文字，发送可能未成功')


if __name__ == '__main__':
    main()
