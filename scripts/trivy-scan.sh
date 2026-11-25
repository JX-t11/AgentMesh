#!/usr/bin/env bash
# Trivy 本地依赖/镜像扫描(docker 一次性容器,本机无需安装 Trivy)
# 用法见 usage;漏洞只报告,扫描/导出/转换失败时返回非零
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIVY_IMAGE='docker.io/aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
SCAN_ARGS=(--scanners vuln --list-all-pkgs --format json --exit-code 0 --no-progress)
DEFAULT_IMAGES=(
  agentmesh-server:local
  agentmesh-openclaw-agent:local
  agentmesh-hermes-agent:local
  agentmesh-agentmesh-server:latest
)

usage() {
  cat <<'EOF'
Usage:
  bash scripts/trivy-scan.sh deps [output-dir]
  bash scripts/trivy-scan.sh image <local-image> [output-dir]
  bash scripts/trivy-scan.sh images [output-dir]

deps scans Cargo.lock, web/package-lock.json and docs-site/package-lock.json,
plus integrations/openclaw-agentmesh/package-lock.json when that ignored local
plugin tree is present. images scans the locally built AgentMesh images that
exist (server, OpenClaw agent, Hermes agent), skipping missing tags.

Vulnerability findings are reported without failing the scan. Operational
errors fail. Each target produces report.json and sbom.cdx.json under
.scratch/trivy/ by default.
EOF
}

CACHE_DIR="${AM_TRIVY_CACHE_DIR:-$(dirname "$ROOT")/dev-tools/trivy/cache}"
mkdir -p -- "$CACHE_DIR"
CACHE_DIR="$(cd "$CACHE_DIR" && pwd -P)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/am-trivy.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR"' EXIT
mkdir -p -- "$WORK_DIR/reports"

run_trivy() {
  local source_path="$1" container_path="$2"
  shift 2
  docker run --rm --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
    --env HOME=/tmp --env TRIVY_DB_REPOSITORY \
    --mount "type=bind,source=${CACHE_DIR},target=/cache" \
    --mount "type=bind,source=${source_path},target=${container_path},readonly" \
    "$TRIVY_IMAGE" --cache-dir /cache --timeout 10m "$@"
}

scan_file() {
  local lockfile="$1" reports="$2" filename
  [[ -f "$lockfile" ]] || { echo "[trivy] Skipping missing $lockfile" >&2; return 0; }
  filename="$(basename "$lockfile")"
  echo "[trivy] Scanning $lockfile"
  mkdir -p -- "$reports"
  run_trivy "$lockfile" "/input/$filename" fs "${SCAN_ARGS[@]}" --include-dev-deps /input > "$reports/report.json"
  run_trivy "$reports/report.json" /input/report.json convert --format cyclonedx /input/report.json > "$reports/sbom.cdx.json"
}

scan_image() {
  local image="$1" reports="$2" image_id
  image_id="$(docker image inspect --format '{{.Id}}' -- "$image")"
  echo "[trivy] Scanning image $image ($image_id)"
  mkdir -p -- "$reports"
  docker image save --output "$WORK_DIR/image.tar" "$image_id"
  run_trivy "$WORK_DIR/image.tar" /input/image.tar image "${SCAN_ARGS[@]}" --input /input/image.tar > "$reports/report.json"
  rm -f -- "$WORK_DIR/image.tar"
  run_trivy "$reports/report.json" /input/report.json convert --format cyclonedx /input/report.json > "$reports/sbom.cdx.json"
}

MODE="${1:-}"
case "$MODE" in
  -h|--help) usage; exit 0 ;;
  deps)
    shift
    (( $# <= 1 )) || { usage >&2; exit 2; }
    OUTPUT_DIR="${1:-$ROOT/.scratch/trivy/deps}"
    scan_file "$ROOT/web/package-lock.json" "$WORK_DIR/reports/web"
    scan_file "$ROOT/docs-site/package-lock.json" "$WORK_DIR/reports/docs-site"
    scan_file "$ROOT/Cargo.lock" "$WORK_DIR/reports/cargo"
    scan_file "$ROOT/integrations/openclaw-agentmesh/package-lock.json" "$WORK_DIR/reports/openclaw-agentmesh"
    ;;
  image)
    shift
    (( $# >= 1 && $# <= 2 )) || { usage >&2; exit 2; }
    IMAGE_ID="$(docker image inspect --format '{{.Id}}' -- "$1")"
    OUTPUT_DIR="${2:-$ROOT/.scratch/trivy/images/${IMAGE_ID#sha256:}}"
    scan_image "$IMAGE_ID" "$WORK_DIR/reports"
    ;;
  images)
    shift
    (( $# <= 1 )) || { usage >&2; exit 2; }
    OUTPUT_DIR="${1:-$ROOT/.scratch/trivy/images}"
    for image in "${DEFAULT_IMAGES[@]}"; do
      if ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "[trivy] Skipping missing image $image" >&2
        continue
      fi
      name="${image%%:*}"
      scan_image "$image" "$WORK_DIR/reports/$name"
    done
    if [[ -z "$(find "$WORK_DIR/reports" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]]; then
      echo 'ERROR: none of the expected AgentMesh images exist; build them first.' >&2
      exit 1
    fi
    ;;
  *) usage >&2; exit 2 ;;
esac

mkdir -p -- "$OUTPUT_DIR"
cp -R -- "$WORK_DIR/reports/." "$OUTPUT_DIR/"
echo "[trivy] Reports saved to $OUTPUT_DIR"
