#!/usr/bin/env bash
# SonarQube 扫描入口(范围见根目录 sonar-project.properties)
# 用法: SONAR_TOKEN=xxx bash scripts/sonar-scan.sh
# token 在 server 网页 My Account > Security 生成;凭据在 dev-tools/sonarqube/credentials.txt
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARED_SONAR_URL=http://192.168.1.234:9000
: "${SONAR_TOKEN:?需要 SONAR_TOKEN 环境变量}"
: "${SONAR_HOST_URL:=$SHARED_SONAR_URL}"

case "${SONAR_HOST_URL%/}" in
  "$SHARED_SONAR_URL"|http://127.0.0.1:9000|http://localhost:9000)
    if [[ "$(git -C "$ROOT" branch --show-current)" != main || -n "$(git -C "$ROOT" status --porcelain)" ]]; then
      echo '共享 SonarQube 的 agentmesh 项目只接受干净的 main。分支检查请通过 SONAR_HOST_URL 指向独立实例。' >&2
      exit 2
    fi
    ;;
esac

# --user root: 宿主工作区目录 700,容器默认非 root 用户读不到
docker run --rm --network host --user root \
  -v "$ROOT":/repo:ro \
  -e SONAR_TOKEN -e SONAR_USER_HOME=/tmp/.sonar \
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo \
  sonarsource/sonar-scanner-cli:latest \
  -Dsonar.projectBaseDir=/repo \
  -Dsonar.host.url="$SONAR_HOST_URL" \
  -Dsonar.working.directory=/tmp/.scannerwork
