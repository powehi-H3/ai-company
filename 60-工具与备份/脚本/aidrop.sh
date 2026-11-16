#!/system/bin/sh
# aidrop.sh —— 往指定 App 的输入框自动投递文字并发送
#
# 用法：
#   aidrop.sh <app_key> <文字内容>
#   aidrop.sh qwen "你好，这是测试"
#   aidrop.sh ds "写一段 Python"
#
# 支持的 app_key：qwen / ds / db / gpt / grok
#
# 退出码：
#   0  成功（已发送）
#   1  参数错误
#   2  找不到 App
#   3  启动失败
#   4  界面加载超时
#   5  找不到输入框
#   6  点输入框后键盘没弹出
#   7  文字没进去
#   8  找不到发送按钮
#   9  发送后输入框没清空（可能没发出去）

set -u
PATH=/data/adb/ksu/bin:/data/adb/magisk:/system/bin:/system/xbin:/vendor/bin:$PATH
export PATH

# ── 收尾：无论成功失败，都把前台切回 DSH（董事长提出的真问题）──
# 之前脚本干完活，界面一直停在目标 App，得手动返回。
# 这里用 trap 统一在退出前切回 DSH。
cleanup_return() {
  am start -n io.github.ccch1mneyyy.dsh_app/.LauncherMist >/dev/null 2>&1
}
trap cleanup_return EXIT

APP="${1:-}"
TEXT="${2:-}"
DRY="${3:-}"

if [ -z "$APP" ] || [ -z "$TEXT" ]; then
  echo "用法: aidrop.sh <qwen|ds|db|gpt|grok> <文字> [--dry-run]" >&2
  exit 1
fi

# --dry-run：只填文字进输入框，不点发送（用于安全验证链路）
if [ "$DRY" = "--dry-run" ]; then
  DRY_RUN=1
else
  DRY_RUN=0
fi

case "$APP" in
  qwen) PKG=com.aliyun.tongyi ;;
  ds)   PKG=com.deepseek.chat ;;
  db)   PKG=com.larus.nova ;;
  gpt)  PKG=com.openai.chatgpt ;;
  grok) PKG=ai.x.grok ;;
  *) echo "未知 app: $APP（可用 qwen/ds/db/gpt/grok）" >&2; exit 1 ;;
esac

AIDROP_DIR=/data/local/tmp
TMP=/data/local/tmp
UI="$TMP/aidrop_ui.xml"

log() { echo "[aidrop] $*"; }

# ── 1. 检查 App 存在 ──
pm list packages 2>/dev/null | grep -q "^package:$PKG$" || {
  echo "找不到 App: $PKG" >&2; exit 2
}

# ── 2. 启动 ──
# v4 修正（2026-11-16 董事长澄清）：
#   「DSH 抢前台」是误判——真相是董事长手动返回 DSH 看进度。
#   monkey 启动本身是成功的，DeepSeek 确实在前台。
#   真正的缺憾是：脚本结束后没有「返回 DSH」的收尾动作，界面一直留在目标 App。
# 保留 am start 作为标准启动方式（无害），但注释改为正确的原因。
log "启动 $PKG"
monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
MAIN_ACT=$(cmd package resolve-activity --brief "$PKG" 2>/dev/null | tail -1)
if [ -n "$MAIN_ACT" ]; then
  am start -n "$MAIN_ACT" >/dev/null 2>&1
else
  am start -n "$PKG/.MainActivity" >/dev/null 2>&1
fi

# ── 3. 等加载：轮询直到 dump 出足够元素 ──
log "等待界面加载"
LOADED=0
i=0
while [ $i -lt 12 ]; do
  sleep 2
  i=$((i+1))
  uiautomator dump "$UI" >/dev/null 2>&1 || continue
  N=$(grep -o '<node' "$UI" 2>/dev/null | wc -l)
  if [ "$N" -ge 30 ]; then
    LOADED=1
    log "  第${i}次: 元素=$N ✓"
    break
  fi
  log "  第${i}次: 元素=$N（加载中）"
done
[ "$LOADED" = "1" ] || { echo "界面加载超时" >&2; exit 4; }

# ── 4. 校验前台确实是目标 App ──
TOP=$(dumpsys activity activities 2>/dev/null | grep -oE "topResumedActivity=ActivityRecord\{[^}]*\}" | grep -o "$PKG" | head -1)
[ "$TOP" = "$PKG" ] || {
  echo "前台不是 $PKG（实际 topResumedActivity 里没有它）" >&2
  echo "  提示：目标 App 可能已被切走（如用户手动返回）" >&2
  exit 3
}
log "前台确认: $PKG ✓"

# ── 4.5 校验 dump 抓到的是目标 App（v3 新增，防 DSH 抢前台）──
DUMP_PKG=$(grep -oE 'package="[^"]*"' "$UI" 2>/dev/null | head -1 | sed 's/package="//;s/"//')
if [ -n "$DUMP_PKG" ] && [ "$DUMP_PKG" != "$PKG" ]; then
  echo "dump 抓到了 $DUMP_PKG 而不是 $PKG，重试 am start" >&2
  am start -n "$MAIN_ACT" >/dev/null 2>&1
  sleep 3
  uiautomator dump "$UI" >/dev/null 2>&1
  DUMP_PKG=$(grep -oE 'package="[^"]*"' "$UI" 2>/dev/null | head -1 | sed 's/package="//;s/"//')
  [ "$DUMP_PKG" = "$PKG" ] || { echo "重试后仍抓到 $DUMP_PKG" >&2; exit 3; }
  log "重试后抓到 $PKG ✓"
fi

# ── 5. 找输入框 ──
# v2 修正：不能只靠 class="android.widget.EditText"！
#   千问的输入框是普通 View，没有 EditText class，靠提示文字标识。
#   实测：首页时提示"发消息或按住说话..."，对话页时是 EditText。
# 策略：先找 EditText，找不到再按各 App 的提示文字找。
log "查找输入框"
BOUNDS=$(grep -o '<node[^>]*class="android.widget.EditText"[^>]*>' "$UI" 2>/dev/null | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"')

if [ -z "$BOUNDS" ]; then
  # 按提示文字找（各 App 不同）
  for HINT in "发消息或按住说话" "询问 ChatGPT" "给我布置一个任务" "发消息" "输入" "问一问" "有什么可以帮"; do
    BOUNDS=$(grep -o "<node[^>]*text=\"[^\"]*${HINT}[^\"]*\"[^>]*>" "$UI" 2>/dev/null | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"')
    [ -n "$BOUNDS" ] && { log "  按提示文字找到: $HINT"; break; }
    BOUNDS=$(grep -o "<node[^>]*content-desc=\"[^\"]*${HINT}[^\"]*\"[^>]*>" "$UI" 2>/dev/null | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"')
    [ -n "$BOUNDS" ] && { log "  按 content-desc 找到: $HINT"; break; }
  done
fi

# v3 Compose 兜底：DeepSeek 等 Compose App 输入框是自绘 View，
#   没有 EditText/hint/content-desc，只能按坐标找「屏幕底部 + 宽度>50% 的 View」。
if [ -z "$BOUNDS" ]; then
  log "语义定位失败"
  log "  Compose App（DeepSeek）输入框需坐标定位，应由上层（AppAgent Python）解析"
  log "  aidrop.sh 只负责「执行」，解析在 proot 侧做"
fi

[ -n "$BOUNDS" ] || {
  echo "找不到输入框（EditText、提示文字、Compose 坐标兜底都没匹配到）" >&2
  echo "  当前界面元素数: $(grep -o '<node' "$UI" | wc -l)" >&2
  exit 5
}
# 解析 [x1,y1][x2,y2]
C=$(echo "$BOUNDS" | sed 's/bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/')
X1=$(echo "$C" | cut -d' ' -f1)
Y1=$(echo "$C" | cut -d' ' -f2)
X2=$(echo "$C" | cut -d' ' -f3)
Y2=$(echo "$C" | cut -d' ' -f4)
CX=$(( (X1 + X2) / 2 ))
CY=$(( (Y1 + Y2) / 2 ))
log "输入框中心: ($CX,$CY)"

# ── 6. 点击输入框 ──
log "点击输入框 ($CX,$CY)"
input tap "$CX" "$CY"
sleep 2

# ── 6.5 清空输入框里的残留（重要：上一次失败可能留下垃圾）──
log "清空输入框"
for _i in $(seq 1 30); do input keyevent 67 2>/dev/null; done
sleep 1

# ── 6.6 重新 dump 并定位（布局会随键盘状态变化！坐标不能复用）──
uiautomator dump "$UI" >/dev/null 2>&1
BOUNDS2=$(grep -o '<node[^>]*class="android.widget.EditText"[^>]*>' "$UI" 2>/dev/null | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"')
if [ -n "$BOUNDS2" ]; then
  C2=$(echo "$BOUNDS2" | sed 's/bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/')
  X1=$(echo "$C2" | cut -d' ' -f1); Y1=$(echo "$C2" | cut -d' ' -f2)
  X2=$(echo "$C2" | cut -d' ' -f3); Y2=$(echo "$C2" | cut -d' ' -f4)
  CX2=$(( (X1 + X2) / 2 )); CY2=$(( (Y1 + Y2) / 2 ))
  if [ "$CX2" != "$CX" ] || [ "$CY2" != "$CY" ]; then
    log "  坐标变化 ($CX,$CY) → ($CX2,$CY2)，重新点击"
    input tap "$CX2" "$CY2"
    sleep 1
    CX=$CX2; CY=$CY2
  fi
fi

# ── 7. 校验键盘弹出 ──
KB=$(dumpsys input_method 2>/dev/null | grep -oE 'mInputShown=[a-z]+' | head -1)
if [ "$KB" != "mInputShown=true" ]; then
  log "警告：键盘未弹出（$KB），仍继续尝试输入"
fi

# ── 8. 输入文字 ──
log "输入文字（${#TEXT} 字）"
# 重要限制（实测 2026-11-16）：
#   Android 的 `input text` **不支持中文**，会直接抛异常：
#   "Exception occurred while executing 'text'"
#   剪贴板注入（service call clipboard / am broadcast）在这台机器上也失败。
#   所以：中文目前做不到，只能用英文/数字/符号。
if echo "$TEXT" | LC_ALL=C grep -qE '[^ -~]'; then
  echo "错误：检测到非 ASCII 字符（中文等）。" >&2
  echo "  Android 的 input text 不支持中文，实测会崩溃。" >&2
  echo "  当前只支持英文/数字/符号。" >&2
  exit 10
fi
input text "$TEXT" 2>/dev/null
sleep 2

# ── 9. 校验文字进去了 ──
uiautomator dump "$UI" >/dev/null 2>&1
# 取文字前 8 个字符做校验
HEAD=$(echo "$TEXT" | cut -c1-8)
if grep -qF "$HEAD" "$UI" 2>/dev/null; then
  log "文字已进入输入框 ✓"
else
  echo "文字没进去（找不到: $HEAD）" >&2
  exit 7
fi

# ── 10. 找发送按钮 ──
log "查找发送按钮"
# 中文 App 常用 content-desc="发送消息" / "发送"
SEND_BOUNDS=$(grep -o '<node[^>]*content-desc="[^"]*发送[^"]*"[^>]*>' "$UI" 2>/dev/null | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"')
if [ -z "$SEND_BOUNDS" ]; then
  # 英文 App
  SEND_BOUNDS=$(grep -o '<node[^>]*content-desc="[^"]*[Ss]end[^"]*"[^>]*>' "$UI" 2>/dev/null | head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"')
fi
[ -n "$SEND_BOUNDS" ] || {
  echo "找不到发送按钮" >&2
  exit 8
}
SC=$(echo "$SEND_BOUNDS" | sed 's/bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]"/\1 \2 \3 \4/')
SX=$(( ($(echo "$SC" | cut -d' ' -f1) + $(echo "$SC" | cut -d' ' -f3)) / 2 ))
SY=$(( ($(echo "$SC" | cut -d' ' -f2) + $(echo "$SC" | cut -d' ' -f4)) / 2 ))
log "发送按钮中心: ($SX,$SY)"

# ── 11. 点击发送 ──
if [ "$DRY_RUN" = "1" ]; then
  log "【dry-run】文字已进入输入框，跳过点击发送"
  echo "dry-run 成功：文字已进入输入框，未发送"
  exit 0
fi
log "点击发送"
input tap "$SX" "$SY"
sleep 3

# ── 12. 校验发送成功（EditText 消失）──
uiautomator dump "$UI" >/dev/null 2>&1
EC=$(grep -o 'android.widget.EditText' "$UI" 2>/dev/null | wc -l)
if [ "$EC" -eq 0 ]; then
  log "✅ 发送成功（输入框已清空）"
  exit 0
else
  echo "发送后输入框还在（EditText=$EC），可能没发出去" >&2
  exit 9
fi
