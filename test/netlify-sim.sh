#!/usr/bin/env bash
# =============================================================================
# 模拟 Netlify 的 Linux 构建环境，验证 npm ci + build 一定能过。
#
# 背景：之前两次部署失败都是「本地能过、Netlify 挂掉」，原因是平台差异。
# 这个脚本用 Docker 起一个和 Netlify 一致的 Linux + Node 22 环境，
# 跑完全相同的命令，把差异暴露在推送之前。
#
# 用法： bash test/netlify-sim.sh
# =============================================================================

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="node:22-bookworm"

if ! command -v docker >/dev/null 2>&1; then
  echo "未安装 docker，无法做 Linux 模拟。"
  echo "（在有 Docker 的机器上运行本脚本可以获得和 Netlify 一致的环境）"
  exit 0
fi

echo "=============================================================="
echo "  模拟 Netlify 构建环境"
echo "  镜像: $IMAGE （Linux，与 Netlify 一致）"
echo "=============================================================="
echo

docker run --rm \
  -v "$REPO_DIR":/src:ro \
  -w /work \
  "$IMAGE" \
  bash -c '
    set -e
    echo "--- 复制仓库（排除本地产物，模拟全新检出）---"
    cp -r /src/. /work/
    rm -rf /work/node_modules /work/dist /work/.git

    echo
    echo "--- node / npm 版本 ---"
    node -v
    npm -v

    echo
    echo "--- npm ci（这一步之前失败过）---"
    npm ci
    echo "npm ci: OK"

    echo
    echo "--- npm run build（这一步之前也失败过）---"
    npm run build
    echo "build: OK"

    echo
    echo "--- 产物 ---"
    ls -la dist/ dist/assets/ 2>/dev/null || true

    echo
    echo "=============================================================="
    echo "  ✅ Linux 环境下 npm ci + build 全部通过"
    echo "=============================================================="
  '
