# -*- coding: utf-8 -*-
"""脱敏模块：手机号/身份证/银行卡/密码/Token 自动打码"""
import re

RULES = [
    # 身份证 18 位（先于手机号，避免误判）—— 用 (?<!\d) 代替 \b，中文旁也能匹配
    (re.compile(r'(?<!\d)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)'), r'**************\2'),
    # 手机号 11 位
    (re.compile(r'(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)'), r'\1****\2'),
    # 银行卡 16-19 位
    (re.compile(r'(?<!\d)(\d{4})[\d\s]{8,12}(\d{4})(?!\d)'), r'\1 **** **** \2'),
    # 常见 Token / Key
    (re.compile(r'(sk-[A-Za-z0-9_\-]{10,})'), '[REDACTED_KEY]'),
    (re.compile(r'(Bearer\s+)[A-Za-z0-9._\-]{15,}', re.I), r'\1[REDACTED_TOKEN]'),
    (re.compile(r'("?(?:api[_-]?key|token|secret|password|passwd)"?\s*[:=]\s*")([^"]{6,})(")', re.I), r'\1[REDACTED]\3'),
    (re.compile(r'(ghp_|gho_|github_pat_)[A-Za-z0-9_]{10,}'), '[REDACTED_GH]'),
    (re.compile(r'AKIA[0-9A-Z]{16}'), '[REDACTED_AWS]'),
]

# 整行跳过标记
SENSITIVE_LINE = re.compile(r'(密码|password|验证码|私钥|private[_ ]key)\s*[:：=]\s*\S+', re.I)

STATS = {}

def sanitize(text):
    """返回脱敏后的文本，并累计统计"""
    if not text:
        return text
    out_lines = []
    for line in str(text).split('\n'):
        if SENSITIVE_LINE.search(line):
            out_lines.append('[整行已脱敏：疑似含密码/验证码]')
            STATS['line_skipped'] = STATS.get('line_skipped', 0) + 1
            continue
        for pat, rep in RULES:
            new = pat.sub(rep, line)
            if new != line:
                STATS[pat.pattern[:20]] = STATS.get(pat.pattern[:20], 0) + 1
                line = new
        out_lines.append(line)
    return '\n'.join(out_lines)

def report():
    if not STATS:
        return "未触发任何脱敏规则"
    return "\n".join(f"  {k}: {v} 处" for k, v in STATS.items())

if __name__ == '__main__':
    tests = [
        "我的手机是13812345678",
        "身份证110101199001011234",
        "卡号6222 0212 3456 7890",
        "api_key: sk-abcdefghijklmnopqrst",
        "密码: mypass123",
        "正常内容不会被改动",
    ]
    print("=== 脱敏测试 ===")
    for t in tests:
        print(f"  原文: {t}")
        print(f"  结果: {sanitize(t)}")
        print()
    print("=== 统计 ===")
    print(report())
