#!/usr/bin/env bash
# 项目归档（规矩十九/二十）：打包全部 → 归位 → 清空外围
# 用法: archive-project.sh <项目名> <完成|搁置>
set -u
COMPANY="/storage/emulated/0/AI专用文件夹/AI公司"
P="${1:?用法: $0 <项目名> <完成|搁置>}"
DEST="${2:-}"
case "$DEST" in 完成) DIR="已完成"; TAG="完成";; 搁置) DIR="已搁置"; TAG="搁置";; *) echo "✗ 第二参数只能是 完成 或 搁置"; exit 2;; esac

SRC=""
for stage in 进行中 已完成 已搁置; do
  [ -d "$COMPANY/20-项目区/$stage/$P" ] && { SRC="$COMPANY/20-项目区/$stage/$P"; break; }
done
[ -z "$SRC" ] && { echo "✗ 找不到项目：$P"; exit 1; }

DATE=$(date +%Y%m%d)
OUT="$COMPANY/20-项目区/$DIR/${P}-${TAG}-${DATE}.zip"
echo "════════════════════════════════════════"
echo "  项目归档 → $DIR"
echo "════════════════════════════════════════"
echo "  项目：$P"; echo "  目标：$OUT"; echo

# 1. 收集全部内容到临时目录
TMP=$(mktemp -d); BOX="$TMP/$P"; mkdir -p "$BOX"
echo "▶ 收集：项目主目录"
cp -r "$SRC"/* "$BOX/" 2>/dev/null
echo "▶ 收集：7 个工位产出"
mkdir -p "$BOX/_归档-工位产出"
for w in "$COMPANY/10-办公区"/*/; do
  wn=$(basename "$w")
  if [ -d "$w/$P" ]; then
    mkdir -p "$BOX/_归档-工位产出/$wn"
    cp -r "$w/$P"/* "$BOX/_归档-工位产出/$wn/" 2>/dev/null || true
  fi
done
echo "▶ 收集：会议室 / 项目备案里带项目名的记录"
mkdir -p "$BOX/_归档-其他"
find "$COMPANY/30-会议室" "$COMPANY/40-档案室/02-项目备案" -type f -name "*$P*" 2>/dev/null | while read -r f; do
  cp "$f" "$BOX/_归档-其他/" 2>/dev/null
done

# 2. MANIFEST
{
  echo "# $P — $TAG — $DATE"; echo "# 生成: $(date '+%F %T')"
  echo "# 文件数: $(find "$BOX" -type f|wc -l)"; echo
  cd "$BOX" && find . -type f|sed 's|^\./||'|sort|while read -r f; do printf "%s  %s\n" "$(sha256sum "$f"|cut -c1-16)" "$f"; done
} > "$BOX/MANIFEST.txt"

# 3. 打包 + 校验
cd "$TMP"; zip -qr "$OUT" "$P"
N_BOX=$(unzip -l "$OUT" 2>/dev/null | grep -c "^ *[0-9]")
echo "▶ 校验：ZIP 内文件数 $N_BOX"
if [ "$N_BOX" -lt 2 ]; then echo "✗ ZIP 异常，终止，不删任何东西"; rm -rf "$TMP"; exit 3; fi

# 4. 清空外围（校验通过才删）
echo "▶ 清空外围"
rm -rf "$SRC"
for w in "$COMPANY/10-办公区"/*/; do rm -rf "$w/$P"; done
find "$COMPANY/30-会议室" "$COMPANY/40-档案室/02-项目备案" -type f -name "*$P*" -delete 2>/dev/null
echo "  ✓ 主目录 / 7工位 / 会议室 / 备案 已清"

echo
echo "════════════════════════════════════════"
echo "  ✅ 归档完成"
echo "  文件：$(basename "$OUT")"
echo "  大小：$(du -h "$OUT"|cut -f1)"
echo "  位置：20-项目区/$DIR/"
echo "  SHA256：$(sha256sum "$OUT"|cut -d' ' -f1)"
echo "  进行区已无此项目散装文件"
echo "════════════════════════════════════════"
rm -rf "$TMP"
