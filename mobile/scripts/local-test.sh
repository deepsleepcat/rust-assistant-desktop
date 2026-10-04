#!/usr/bin/env bash
# 本机（Android / Termux）测试沙箱脚本。
#
# 为什么需要它：会话工作区在 /storage/emulated/0（FUSE，noexec），
# 原生二进制（esbuild、rollup .node）无法在该分区执行或 dlopen；
# 依赖的 .bin 符号链接也无法创建。因此把源码同步到应用私有目录
# （$HOME，ext4 可执行）后运行测试与构建。
#
# 源码权威始终在仓库目录；本脚本只做单向同步 + 运行，不改动仓库。
# 沙箱目录可用 OHMYTX_SANDBOX 覆盖。
#
# 用法：
#   scripts/local-test.sh test    # 跑 vitest（线程池；folks 池在 Termux 下会 EPIPE）
#   scripts/local-test.sh build   # tsc 类型检查 + vite 生产构建
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${OHMYTX_SANDBOX:-$HOME/work/ohmytxphone}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

# 需要同步进沙箱的路径（构建产物与 node_modules 除外）
SYNC_PATHS=(src tests public assets index.html package.json tsconfig.json tsconfig.node.json vite.config.ts vitest.config.ts)

mkdir -p "$DEST"

# 依赖需要（重新）同步的两种情形：
# - 沙箱里还没有 node_modules；
# - 仓库的 package-lock.json 比沙箱里 npm 写的元数据更新（新增/升级了依赖）。
NEED_DEPS=0
if [ ! -d "$DEST/node_modules" ]; then
  NEED_DEPS=1
elif [ ! -f "$DEST/node_modules/.package-lock.json" ]; then
  NEED_DEPS=1
elif [ "$SRC/package-lock.json" -nt "$DEST/node_modules/.package-lock.json" ]; then
  NEED_DEPS=1
fi

if [ "$NEED_DEPS" = 1 ]; then
  if [ -d "$SRC/node_modules" ]; then
    echo "==> 复制 node_modules（约 90MB）"
  else
    echo "==> 在仓库内安装依赖（跳过 postinstall：esbuild 校验在 noexec 分区会失败）"
    ( cd "$SRC" && npm install --registry="$REGISTRY" --no-audit --no-fund --no-bin-links --ignore-scripts )
  fi
  rm -rf "$DEST/node_modules"
  cp -a "$SRC/node_modules" "$DEST/"
  # 原生二进制在私有目录需要执行位
  chmod +x "$DEST/node_modules/@esbuild/android-arm64/bin/esbuild" 2>/dev/null || true
fi

echo "==> 同步源码到 $DEST"
for p in "${SYNC_PATHS[@]}"; do
  [ -e "$SRC/$p" ] || continue
  rm -rf "$DEST/$p"
  cp -a "$SRC/$p" "$DEST/"
done

cd "$DEST"
case "${1:-test}" in
  test)
    exec node node_modules/vitest/vitest.mjs run --pool=threads
    ;;
  build)
    node node_modules/typescript/bin/tsc
    exec node node_modules/vite/bin/vite.js build
    ;;
  *)
    echo "用法: $0 [test|build]" >&2
    exit 2
    ;;
esac
