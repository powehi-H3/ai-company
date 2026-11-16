#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
find_input.py —— 从 uiautomator dump 的 XML 里定位输入框坐标。

用法：python3 find_input.py <xml路径>

策略（按优先级）：
  1. EditText class（传统 App）
  2. 提示文字 text/hint/content-desc（千问等）
  3. Compose 兜底：底部（y1 > 屏高*0.7）+ 宽度 > 屏宽*0.5 的 View

输出：x1 y1 x2 y2（空格分隔），找不到输出空并返回非0。
"""
import sys, re

def find(xml):
    with open(xml, encoding='utf-8', errors='ignore') as f:
        content = f.read()

    # 1. EditText
    m = re.search(r'<node[^>]*class="android\.widget\.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', content)
    if m:
        return tuple(map(int, m.groups()))

    # 2. 提示文字（text 或 hint 或 content-desc）
    for hint in ["发消息", "输入", "询问", "问一问", "有什么可以帮", "Message", "message"]:
        m = re.search(r'<node[^>]*(?:text|hint|content-desc)="[^"]*%s[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"' % hint, content)
        if m:
            return tuple(map(int, m.groups()))

    # 3. Compose 兜底：底部宽 View
    # 先取屏幕尺寸（最大的 bounds）
    bounds = re.findall(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', content)
    if not bounds:
        return None
    nums = [tuple(map(int, b)) for b in bounds]
    max_w = max(x2 for x1,y1,x2,y2 in nums)
    max_h = max(y2 for x1,y1,x2,y2 in nums)

    # 找底部输入框：宽 0.5~0.98 屏宽，高度 80~260px（输入框高度特征），
    # y1 在底部区域（0.68 屏高以上）
    candidates = [(x1,y1,x2,y2) for x1,y1,x2,y2 in nums
                  if 0.5*max_w <= (x2-x1) <= 0.98*max_w
                  and 80 <= (y2-y1) <= 260
                  and y1 >= 0.68*max_h]
    if candidates:
        # 取宽度最接近 0.9 屏宽的那个（输入框通常接近全宽但留边距）
        return min(candidates, key=lambda b: abs((b[2]-b[0]) - 0.9*max_w))

    return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)
    r = find(sys.argv[1])
    if r:
        print(" ".join(map(str, r)))
        sys.exit(0)
    sys.exit(1)
