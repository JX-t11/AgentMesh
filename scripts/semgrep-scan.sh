#!/usr/bin/env bash
# Semgrep 本地安全审计(docker 方式,本机无需安装;规则集首次运行需联网拉取并缓存)
# 用法: bash scripts/semgrep-scan.sh [规则集...]    默认: p/owasp-top-ten p/ci p/secrets
# 范围: 仓库根目录全部代码(排除构建产物与依赖目录)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 规则缓存与登录态持久化到跨项目共享 dev-tools:镜像每次用 --rm 一次性容器,镜像本身只在首次 pull
CACHE_HOME="$(dirname "$ROOT")/dev-tools/semgrep/home"
mkdir -p "$CACHE_HOME" 2>/dev/null || true

EFFECTIVE_CACHE_HOME="$CACHE_HOME"
TMP_CACHE_HOME=""
cleanup_tmp_cache() {
  if [[ -n "$TMP_CACHE_HOME" && -d "$TMP_CACHE_HOME" ]]; then
    rm -rf "$TMP_CACHE_HOME"
  fi
}
trap cleanup_tmp_cache EXIT

if [[ ! -d "$CACHE_HOME" || ! -w "$CACHE_HOME" ]] \
  || [[ -n "$(find "$CACHE_HOME" -type d ! -readable -print -quit 2>/dev/null || true)" ]] \
  || [[ -n "$(find "$CACHE_HOME" ! -writable -print -quit 2>/dev/null || true)" ]]; then
  TMP_CACHE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/am-semgrep-home.XXXXXX")"
  EFFECTIVE_CACHE_HOME="$TMP_CACHE_HOME"
  echo "WARN: ${CACHE_HOME} is not fully writable by $(id -u):$(id -g) (e.g. legacy root-owned cache); falling back to temporary cache ${TMP_CACHE_HOME}" >&2
fi

if (($# == 0)); then
  set -- p/owasp-top-ten p/ci p/secrets
fi
SEMGREP_ARGS=(scan)
for rule in "$@"; do
  SEMGREP_ARGS+=(--config "$rule")
done
SEMGREP_ARGS+=(
  --exclude .git
  --exclude .agents
  --exclude target
  --exclude node_modules
  --exclude dist
  --exclude coverage
  --metrics=off
  .
)
docker run --rm --network host -u "$(id -u):$(id -g)" \
  -v "$ROOT":/src:ro \
  -v "$EFFECTIVE_CACHE_HOME":/semgrep-home \
  -e HOME=/semgrep-home \
  semgrep/semgrep:latest \
  sh -lc 'cd /src && exec semgrep "$@"' semgrep "${SEMGREP_ARGS[@]}"
