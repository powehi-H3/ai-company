#!/usr/bin/env python3
# ROOTD_MANAGED —— 本文件由 rootd 模块守护自动安装/更新。
# 删除这一行会让守护认为它是用户自有文件，从而不再覆盖。
#
# rootc.py —— 真机 root 通道客户端（v9.3-multi）
#
# 通道：~/.dsh/rootd/{req,res}
#   与真机侧 CE 目录 /data/user/<id>/<pkg>/files/runtime/rootfs/root/.dsh/rootd
#   是同一 inode，守护以 root 读写，这里以 app uid 读写。
#
# 主体 / 分身：
#   守护在 ~/.dsh/rootd/instance.json 写入本实例的身份卡
#   {"role":"primary|clone","userId":..,"uid":..,"appId":..,"pkg":..}
#   userId=0 → 主体(primary)；userId 非 0 → 分身(clone)。
#   `rootc.py --info` 打印身份；`--role` 只打印角色名；均不发送命令。
#   命令执行时守护会注入 ROOTD_ROLE / ROOTD_USER_ID / ROOTD_UID 环境变量。
#
# 用法：
#   rootc.py 'id'                          # 执行 root 命令（协议与 v9.2 完全相同）
#   rootc.py ls -la /data/adb/modules     # 多参数自动拼接
#   rootc.py --info                       # 只显示本实例身份，不连通道
#   rootc.py --role                       # 只打印 primary / clone
#   rootc.py --off                        # 关闭「本实例」（不影响其他实例）
#   rootc.py --on                         # 开启「本实例」
#   rootc.py --scan                       # 看守护扫到了哪些实例（排查用）
#   rootc.py --doctor                     # 一键体检：逐项检查 + 说清卡在哪（v9.22）
#   ROOTC_TIMEOUT=300 rootc.py 'sleep 200'
#
# 退出码：命令自身的退出码；125=请求过期；124=超时；126=通道不可用

import base64
import json
import os
import stat
import sys
import time
import uuid

HOME = os.path.expanduser("~")
BASE = os.path.join(HOME, ".dsh", "rootd")
REQ = os.path.join(BASE, "req")
RES = os.path.join(BASE, "res")
OFF = os.path.join(BASE, "off")
INFO = os.path.join(BASE, "instance.json")

# 守护默认 TMO=120，客户端留 10s 余量，避免「假超时」
DEFAULT_TIMEOUT = int(os.environ.get("ROOTC_TIMEOUT", "130"))


def b64d(s):
    if not s:
        return b""
    s = s.strip()
    pad = (-len(s)) % 4
    if pad:
        s += "=" * pad
    try:
        return base64.b64decode(s)
    except Exception:
        return b""


def die(msg, code=126):
    sys.stderr.write("rootc: %s\n" % msg)
    sys.exit(code)


def load_info():
    """读守护写的实例身份卡；旧版守护不写这个文件，返回 None。"""
    try:
        with open(INFO, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def role_label(info):
    if not info:
        return "unknown"
    r = info.get("role")
    if r in ("primary", "clone"):
        return r
    # 兼容：没有 role 字段时按 userId 兜底
    uid = info.get("userId")
    if uid == 0:
        return "primary"
    if isinstance(uid, int) and uid > 0:
        return "clone"
    return "unknown"


def set_switch(on):
    """v9.5：只操作「本实例」的开关，绝不碰别的实例。

    开关就是 <本通道>/off 这一个文件：
      存在 = 本实例关闭；不存在 = 本实例开启。
    主体和分身的通道在不同 userId 下，因此天然互不可见、互不影响。
    """
    info = load_info()
    role = role_label(info)
    zh = {"primary": "主体（用户 0）", "clone": "分身", "unknown": "未知"}[role]
    if not os.path.isdir(BASE):
        die("channel not ready: %s missing (module not installed or daemon not up)" % BASE)
    if on:
        try:
            os.unlink(OFF)
        except FileNotFoundError:
            pass
        except Exception as e:
            die("cannot enable: %s" % e)
        print("%s：已开启（仅本实例）" % zh)
    else:
        try:
            with open(OFF, "w") as f:
                f.write(str(int(time.time())))
        except Exception as e:
            die("cannot disable: %s" % e)
        print("%s：已关闭（仅本实例，不影响其他实例）" % zh)
        print("  重新开启：rootc.py --on")
    # 触发一次重扫，让守护尽快感知开关变化
    try:
        with open(os.path.join(BASE, ".rescan"), "w") as f:
            f.write(str(int(time.time())))
    except Exception:
        pass
    return 0


def show_scan():
    """显示守护的扫描快照（公开可读），用于排查「为什么没有实例」。

    分身看不到 /data，也看不到模块 700 私有目录，所以守护把扫描结果
    同步一份到 /sdcard/rootd-out/scan.txt 供这里读取。
    """
    for p in ("/storage/emulated/0/rootd-out/scan.txt",
              "/sdcard/rootd-out/scan.txt"):
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    print(f.read().rstrip())
                return 0
            except Exception as e:
                print("读取失败: %s" % e)
                return 1
    print("找不到扫描快照（守护可能没在跑，或版本低于 v9.7）")
    return 1


def show_info(only_role=False):
    info = load_info()
    if only_role:
        print(role_label(info))
        return 0
    if not info:
        print("rootd 实例: 未知（未发现 instance.json，可能是 v9.2 旧守护或未就绪）")
        print("通道: %s" % BASE)
        return 0
    zh = {"primary": "主体（用户 0）", "clone": "分身（多用户）", "unknown": "未知"}
    role = role_label(info)
    print("rootd 实例身份")
    print("  角色    : %s  [%s]" % (role, zh.get(role, "?")))
    print("  userId  : %s" % info.get("userId"))
    print("  uid     : %s" % info.get("uid"))
    print("  appId   : %s" % info.get("appId"))
    print("  pkg     : %s" % info.get("pkg"))
    print("  owner   : %s" % info.get("owner"))
    print("  version : %s" % info.get("version"))
    print("  channel : %s" % info.get("channel"))
    print("  off     : %s" % ("是（本实例已单独关闭）" if os.path.exists(OFF) else "否"))
    return 0


HB_PATHS = (
    "/storage/emulated/0/rootd-out/heartbeat",
    "/sdcard/rootd-out/heartbeat",
)

# v9.22：唤醒 FIFO。守护阻塞读它，客户端投完请求写 1 字节，守护立刻被唤醒。
#
# v9.24：唤醒 FIFO 已放弃（/data/adb 客户端看不到、/sdcard 不支持 mkfifo、
# 多实例又受 toybox 单数字 fd 限制）。守护改回 sleep 2 轮询，实测 220~372ms。
# 这里保留空元组，旧函数调用不会报错。
WAKE_PATHS = ()
PID_PATHS = (
    "/storage/emulated/0/rootd-out/rootd.pid",
    "/sdcard/rootd-out/rootd.pid",
)


def _daemon_alive(max_age=20):
    """判断守护是否在跑：读心跳文件，不往命令队列里塞任何东西。

    v9.19 修复（审查 P0）：
      原实现往 req/ 投一个探测文件，等它被取走。
      守护正忙（PER_INST_MAX=1）时探测文件排不上队 → 误判「守护没跑」。
      更糟的是探测本身占用了配额，把真实请求又往后推。

      新实现完全不碰命令队列：只读 /sdcard/rootd-out/heartbeat。
      守护每 2 秒更新一次这个文件，超过 max_age 秒没更新才算真的挂了。

      注意：这里只做「明显没跑」的快速失败（省得用户白等 130 秒），
      不做「一定在跑」的保证。心跳新鲜但实例被 off 时，
      守护会立刻返回 "instance disabled"，客户端能马上看到原因。
    """
    hb = None
    for p in HB_PATHS:
        try:
            with open(p, "r") as f:
                t = f.read().strip()
            if t.isdigit():
                hb = int(t)
                break
        except Exception:
            continue

    if hb is None:
        # 连心跳文件都读不到：守护从未启动过，或控制面不可达
        return False

    age = int(time.time()) - hb
    # 时钟回退（age 为负很多）时按「可能活着」处理，避免误杀
    if age < 0:
        return True
    return age <= max_age


def _wake_daemon():
    """占位：v9.24 已放弃 FIFO 唤醒，守护用 sleep 2 轮询。

    实测代价：响应 220~372ms、CPU 2.16% 单核（整机约 0.27%），用户感知不到。
    FIFO 方案撞了三堵墙（路径不可见 / FUSE 不支持 / toybox fd 限制），
    收益只是把最坏 2 秒压到毫秒级，不值得。
    """
    return False

def run_once(cmdtxt, timeout=DEFAULT_TIMEOUT):
    if not os.path.isdir(REQ):
        die("channel not ready: %s missing (module not installed or daemon not up)" % REQ)

    if os.path.exists(OFF):
        die(
            "本实例已关闭（%s）。\n"
            "  重新开启：rootc.py --on\n"
            "  （只影响本实例，其他实例不受影响）" % OFF
        )

    # v9.4 [P2]：请求守护重扫实例（新装分身 / CE 刚解锁时用得上）。
    #
    # v9.22：不再每条命令都写。原来无条件写，等于每条命令都可能触发一次重扫；
    #        守护侧的重扫即使只做常规探测也要遍历候选目录，纯属浪费。
    #        现在只在本实例的身份卡缺失或不一致时才写 —— 那种情况才真的需要重扫。
    try:
        info = load_info()
        need = (not info) or (info.get("role") not in ("primary", "clone"))
        if need:
            with open(os.path.join(BASE, ".rescan"), "w") as f:
                f.write(str(int(time.time())))
    except Exception:
        pass

    # v9.19：守护没跑时快速失败，避免空等 130 秒。
    # 判定方式改为「读心跳文件」，不再往命令队列投探测文件
    # （那会和真实请求抢 PER_INST_MAX 配额，导致误判「没运行」）。
    if not _daemon_alive(20):
        die(
            "守护进程没有在运行（心跳超过 20 秒未更新）。\n"
            "  先启动守护：在模块 WebUI 点「启动守护进程」，\n"
            "  或点模块卡片的「执行」按钮（action.sh）。\n"
            "  通道: %s" % BASE
        )

    rid = uuid.uuid4().hex
    req = os.path.join(REQ, rid + ".sh")
    res = os.path.join(RES, rid + ".out")

    # 原子落盘：先写临时文件再 rename，守护不会读到半截
    tmp = req + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(cmdtxt)
        os.replace(tmp, req)
    except Exception as e:
        die("cannot submit request: %s" % e)

    # v9.22：立刻叫醒守护（写失败不影响流程，守护有 2 秒兜底）
    _wake_daemon()

    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(res):
            try:
                raw = open(res, "rb").read(1 << 20)  # 上限 1MB
            except Exception:
                time.sleep(0.05)
                continue
            if not raw.endswith(b"}"):
                time.sleep(0.05)   # 半写，等下一轮
                continue
            try:
                j = json.loads(raw.decode("utf-8", "replace"))
            except Exception:
                time.sleep(0.05)
                continue
            if "exit" not in j:
                time.sleep(0.05)
                continue
            try:
                os.unlink(res)
            except Exception:
                pass
            return int(j.get("exit", 1)), b64d(j.get("stdout", "")), b64d(j.get("stderr", ""))
        time.sleep(0.05)

    # 超时：尽力撤回请求（守护可能已取走，删不到也无妨）
    try:
        os.unlink(req)
    except Exception:
        pass
    return 124, b"", b"timeout waiting for rootd"




# ── v9.22：一键体检 ─────────────────────────────────────────────────────
# 借鉴 dsh-rootd-v4.9.3 的 rootd-ctl doctor：逐项检查、能修就修、直接说卡在哪。
# 不引外部依赖，只用标准库；每项输出 ok / miss / FAIL / skip + 一句人话。

def _rd(path, default=""):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(4096).strip()
    except Exception:
        return default


def _age(path):
    """文件距今秒数；不存在返回 None。"""
    try:
        return int(time.time() - os.path.getmtime(path))
    except Exception:
        return None


def run_doctor():
    fails = 0
    warns = 0
    print("=== rootc doctor ===")
    print("实例: %s" % BASE)

    # 1. 通道目录
    print("--- 1. 通道目录 ---")
    if os.path.isdir(REQ) and os.path.isdir(RES):
        print("ok: %s" % BASE)
    else:
        print("FAIL: 缺少 req/ 或 res/（模块没装、没重启，或 App 数据被清）")
        print("  修: 刷模块后重启手机，再点模块卡片的「执行」按钮")
        fails += 1

    # 2. 身份卡
    print("--- 2. 身份卡 ---")
    info = load_info()
    if info:
        print("ok: role=%s userId=%s uid=%s version=%s"
              % (info.get("role"), info.get("userId"), info.get("uid"), info.get("version")))
    else:
        print("miss: 没有 instance.json（守护从没认到本实例，或版本低于 v9.2）")
        fails += 1

    # 3. 守护存活
    print("--- 3. 守护存活 ---")
    alive = _daemon_alive(20)
    hb_age = None
    for p in HB_PATHS:
        a = _age(p)
        if a is not None:
            hb_age = a
            break
    if hb_age is None:
        print("FAIL: 读不到心跳文件（守护从未启动，或 /sdcard 不可读）")
        print("  修: 点模块卡片的「执行」按钮")
        fails += 1
    elif alive:
        print("ok: 心跳 %ss 前" % hb_age)
    else:
        print("FAIL: 心跳 %ss 没更新（超过 20 秒 = 守护没在跑）" % hb_age)
        print("  修: 点模块卡片的「执行」按钮")
        fails += 1

    # 4. 守护 pid 与实际进程
    print("--- 4. 守护进程 ---")
    pid = ""
    for p in PID_PATHS:
        v = _rd(p)
        if v.isdigit():
            pid = v
            break
    if pid:
        # v9.22：不能只用 os.kill(pid,0) 判活 —— 客户端跑在 proot 里，
        # 看不到宿主进程表的完整视图，会误报「僵尸 pid」（实测踩到）。
        # 三条证据合起来才算活：kill(0) 成功 / /proc/<pid> 存在 / 心跳新鲜。
        alive_pid = False
        try:
            os.kill(int(pid), 0)
            alive_pid = True
        except Exception:
            pass
        if not alive_pid:
            try:
                alive_pid = os.path.isdir("/proc/%s" % pid)
            except Exception:
                pass
        if not alive_pid and alive:
            # 心跳新鲜 = 守护确实在写文件，那条 pid 大概率是活的
            alive_pid = True
        if alive_pid:
            print("ok: pid=%s" % pid)
        else:
            print("warn: pid 文件写的是 %s，但三条证据（kill/proc/心跳）都不支持它活着" % pid)
            print("  修: 点「执行」按钮，守护会清掉僵尸 pid 重启")
            warns += 1
    else:
        print("warn: 没有 pid 文件（守护可能刚起，或版本较老）")
        warns += 1

    # 5. 响应方式（v9.24：FIFO 已放弃，改为说明轮询状态）
    print("--- 5. 响应方式 ---")
    print("ok: 轮询模式（守护每 2 秒查一次请求）")
    print("     实测响应 220~372ms，CPU 约 2.16% 单核（整机约 0.27%）")

    # 6. 本实例开关
    print("--- 6. 开关状态 ---")
    if os.path.exists(OFF):
        print("warn: 本实例已关闭（%s）" % OFF)
        print("  修: rootc.py --on")
        warns += 1
    else:
        print("ok: 已开启")

    # 7. 实例扫描快照（守护写的）
    print("--- 7. 实例扫描 ---")
    scan = ""
    for p in ("/storage/emulated/0/rootd-out/scan.txt", "/sdcard/rootd-out/scan.txt"):
        scan = _rd(p)
        if scan:
            break
    if scan:
        cnt = ""
        for line in scan.splitlines():
            if line.startswith("count="):
                cnt = line[6:].strip()
        print("ok: count=%s（守护这轮登记到的实例数）" % (cnt or "?"))
        if cnt == "0":
            print("warn: 0 个实例 —— 守护没认到任何通道，看「拒绝原因」段")
            warns += 1
    else:
        print("wait: 没有 scan.txt（守护版本低于 v9.7，或还没扫过）")
        warns += 1

    # 8. 端到端实测
    print("--- 8. 端到端实测 ---")
    if fails:
        print("skip: 前面有 FAIL，先修完再测（避免白等）")
    elif os.path.exists(OFF):
        print("skip: 本实例已关闭")
    else:
        t0 = time.time()
        code, out, err = run_once("id", timeout=15)
        ms = int((time.time() - t0) * 1000)
        txt = (out or b"").decode("utf-8", "replace").strip()
        if code == 0 and "uid=0" in txt:
            ctx = ""
            for part in txt.split():
                if part.startswith("context="):
                    ctx = part[8:]
            print("ok: %dms  uid=0%s" % (ms, ("  context=" + ctx) if ctx else ""))
            if ctx and "ksu" not in ctx and "magisk" not in ctx and "su" not in ctx:
                print("warn: SELinux 上下文是 %s，不像真 root 域" % ctx)
                warns += 1
        elif code == 124:
            print("FAIL: 超时（15 秒没返回）—— 守护可能卡住")
            fails += 1
        else:
            print("FAIL: exit=%s %s" % (code, (err or b"").decode("utf-8", "replace").strip()[:200]))
            fails += 1

    # 结论
    print("")
    if fails:
        print("结论: 有 %d 项 FAIL，%d 项 warn —— 按上面「修」的提示处理" % (fails, warns))
        return 1
    if warns:
        print("结论: 可用，但有 %d 项提醒（不影响当前使用）" % warns)
        return 0
    print("结论: 全部正常")
    return 0

def main():
    if len(sys.argv) < 2:
        sys.stderr.write(
            "usage: rootc.py <command...>\n"
            "       rootc.py --info / --role      # 显示主体/分身身份\n"
            "       rootc.py --on / --off         # 开关本实例（不影响其他）\n"
            "       rootc.py --doctor             # 一键体检，逐项说清哪里卡住\n"
            "       ROOTC_TIMEOUT=300 rootc.py 'long command'\n"
        )
        sys.exit(2)

    # v9.5：开关类参数，只作用于本实例
    if sys.argv[1] == "--on":
        sys.exit(set_switch(True))
    if sys.argv[1] == "--off":
        sys.exit(set_switch(False))

    # v9.3：信息类参数不发送命令、不要求通道就绪
    if sys.argv[1] == "--info":
        sys.exit(show_info(False))
    if sys.argv[1] == "--role":
        sys.exit(show_info(True))
    if sys.argv[1] == "--scan":
        sys.exit(show_scan())
    if sys.argv[1] == "--doctor":
        sys.exit(run_doctor())
    if sys.argv[1] in ("--help", "-h"):
        print(__doc__)
        sys.exit(0)

    # 支持多参数：rootc.py ls -la /data/adb → "ls -la /data/adb"
    cmdtxt = " ".join(sys.argv[1:])
    code, out, err = run_once(cmdtxt)
    try:
        sys.stdout.buffer.write(out)
        sys.stdout.buffer.flush()
    except Exception:
        pass
    try:
        sys.stderr.buffer.write(err)
        sys.stderr.buffer.flush()
    except Exception:
        pass
    sys.exit(code)


if __name__ == "__main__":
    main()
