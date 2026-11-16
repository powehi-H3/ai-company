#!/usr/bin/env bash
# 项目打包器 —— 带「可交付性闸门」(R2)
set -u
COMPANY="/storage/emulated/0/AI专用文件夹/AI公司"
P="${1:?用法: $0 <项目名> [版本号] [骨架包|交付包]}"
VER="${2:-v1.0}"
KIND="${3:-交付包}"

# Q-03 命名校验
if [[ "$P" =~ [[:space:]/\\:*?\"\<\>|] ]]; then
  echo "✗ 项目名含空格或非法字符：$P"; exit 2
fi

PROJDIR=""
for stage in 进行中 已完成 已搁置; do
  [ -d "$COMPANY/20-项目区/$stage/$P" ] && { PROJDIR="$COMPANY/20-项目区/$stage/$P"; STAGE="$stage"; break; }
done
[ -z "$PROJDIR" ] && { echo "✗ 找不到项目：$P"; exit 1; }

# ── 可交付性闸门（R2，根除 Q-04 / Q-07 / Q-11）──
if [ "$KIND" = "交付包" ]; then
  echo "▶ 可交付性检查"
  MISS=0
  # 1. 材料本体：01-材料本体/ 必须有实际文件
  MAT="$PROJDIR/01-材料本体"
  n_mat=$(find "$MAT" -type f 2>/dev/null | wc -l)
  if [ ! -d "$MAT" ] || [ "$n_mat" -eq 0 ]; then
    echo "  ✗ 01-材料本体/ 为空：交付包必须含被评审/被处理的原始资料"; MISS=1
  else
    echo "  ✓ 材料本体：$n_mat 个文件"
  fi
  # 2. 通用开场白
  [ -f "$PROJDIR/00-通用开场白.md" ] || [ -f "$PROJDIR/通用开场白-复制这段.md" ] \
    && echo "  ✓ 通用开场白" || { echo "  ✗ 缺通用开场白"; MISS=1; }
  # 3. 任务话术
  ls "$PROJDIR"/*任务话术* >/dev/null 2>&1 && echo "  ✓ 任务话术" || echo "  ⚠ 未见任务话术（评审类项目应有）"
  if [ "$MISS" -eq 1 ]; then
    echo
    echo "✗ 闸门未通过：这是「骨架包」，不能当交付包发。"
    echo "  补好材料后重跑；或明确传第三参数 骨架包。"
    exit 3
  fi
fi

echo "════════════════════════════════════════"
echo "  项目打包（$KIND）"
echo "════════════════════════════════════════"
echo "  项目：$P   版本：$VER   状态：$STAGE"
echo

TMP=$(mktemp -d); STAGE_DIR="$TMP/$P"; mkdir -p "$STAGE_DIR"
# 收集项目文档（排除旧 zip / MANIFEST）
for item in "$PROJDIR"/*; do
  b=$(basename "$item")
  case "$b" in *.zip|*.tar.gz|MANIFEST.txt) continue;; esac
  cp -r "$item" "$STAGE_DIR/"
done
# 各工位产出
OUTDIR="$STAGE_DIR/06-工位产出"; mkdir -p "$OUTDIR"
for w in "$COMPANY/10-办公区"/*/; do
  wn=$(basename "$w")
  if [ -d "$w/$P" ]; then
    mkdir -p "$OUTDIR/$wn"; cp -r "$w/$P"/* "$OUTDIR/$wn/" 2>/dev/null || true
  fi
done
# 清单
{
  echo "# $P — $VER — $KIND — $(date +%Y%m%d)"; echo "# 生成: $(date '+%F %T')"
  echo "# 文件数: $(find "$STAGE_DIR" -type f | wc -l)"; echo
  cd "$STAGE_DIR" && find . -type f | sed 's|^\./||' | sort | while read -r f; do
    printf "%s  %s\n" "$(sha256sum "$f"|cut -c1-16)" "$f"; done
} > "$STAGE_DIR/MANIFEST.txt"

SUFFIX="交付包"; [ "$KIND" = "骨架包" ] && SUFFIX="骨架包"
OUT="$PROJDIR/${P}-${VER}-${SUFFIX}-$(date +%Y%m%d).zip"
rm -f "$PROJDIR/${P}-${VER}-${SUFFIX}-"*.zip 2>/dev/null
cd "$TMP"; zip -qr "$OUT" "$P" 2>/dev/null || { OUT="${OUT%.zip}.tar.gz"; tar -czf "$OUT" "$P"; }

if [ -f "$OUT" ]; then
  echo "  ✅ 打包完成"
  echo "  文件：$(basename "$OUT")"
  echo "  大小：$(du -h "$OUT"|cut -f1)   内容：$(find "$STAGE_DIR" -type f|wc -l) 个文件"
  echo "  位置：20-项目区/$STAGE/$P/"
  echo "  SHA256：$(sha256sum "$OUT"|cut -d' ' -f1)"
else echo "✗ 打包失败"; fi
rm -rf "$TMP"
