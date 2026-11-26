#!/usr/bin/env bash
# 合并前双门禁：Semgrep（本机扫描）与 Qualor（服务端质量门）都必须通过，缺一不得合入 main。
# 用法: bash scripts/premerge-check.sh
#   - 候选分支上运行: 扫当前分支已提交快照，相对 origin/main 共同祖先判定新增问题。
#   - 干净 main 上运行: 刷新 main 基线（本地 main 允许领先 origin/main，如刚合并未推送）。
# 依赖: docker、curl、jq、python3，以及本机运行的 Qualor（127.0.0.1:19080）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

branch=$(git branch --show-current)
if [[ -z "$branch" ]]; then
  echo 'detached HEAD，请在候选分支或 main 上运行' >&2
  exit 2
fi
git fetch --quiet origin main

if [[ "$branch" == main ]]; then
  baseline=$(git rev-parse 'refs/heads/main^{commit}')
  target=$baseline
  echo "mode=main 基线刷新 target=${target:0:12}"
else
  baseline=$(git rev-parse 'refs/remotes/origin/main^{commit}')
  local_main=$(git rev-parse 'refs/heads/main^{commit}')
  if [[ "$local_main" != "$baseline" ]]; then
    echo "本地 main ${local_main:0:12} 与 origin/main ${baseline:0:12} 不一致，请先同步基线" >&2
    exit 2
  fi
  target=$(git rev-parse "refs/heads/$branch^{commit}")
  echo "mode=分支 branch=$branch target=${target:0:12} baseline=${baseline:0:12}"
fi

echo '== 门禁 1/2: Semgrep'
bash scripts/semgrep-scan.sh

echo '== 门禁 2/2: Qualor 质量门'
scan_dir=$(mktemp -d /tmp/am-premerge.XXXXXX)
token_id_file="$scan_dir/token-id"
cleanup() { rm -rf -- "$scan_dir"; }
trap cleanup EXIT

git clone --quiet --no-local --no-checkout -- "$PWD" "$scan_dir/checkout"
clone_baseline=$(git -C "$scan_dir/checkout" rev-parse --verify 'refs/remotes/origin/main^{commit}')
if [[ "$clone_baseline" != "$baseline" ]]; then
  echo "克隆的 origin/main ${clone_baseline:0:12} 与基线不一致" >&2
  exit 2
fi
git -C "$scan_dir/checkout" checkout --quiet --detach "$target"

cat > "$scan_dir/qualor.yml" <<'YAML'
version: 1
sources:
  include:
    - web/src/**
    - web/scripts/**
    - integrations/openclaw-agentmesh/src/**
    - docs-site/src/**
    - docs-site/scripts/**
    - scripts/**
languages: [javascript, typescript]
analyzers:
  eslint: { enabled: false }
  sonarjs: { enabled: true, typeChecking: false }
  qualor: { enabled: false }
  semgrep: { enabled: false }
  gitleaks: { enabled: false }
  trivy: { enabled: false }
  trivy-iac: { enabled: false }
scm:
  autoFetch: false
  mainBranch: main
YAML

# 分析令牌：经本机 Qualor API 以 admin 身份创建（密码在 dev-tools/qualor/.env），扫完即删。
python3 - "$scan_dir" <<'PYEOF'
import http.cookiejar, json, re, sys, urllib.request
from pathlib import Path

scan_dir = Path(sys.argv[1])
env = Path('/home/jx03/work_lumin/llm_train/code-workplace/dev-tools/qualor/.env')
pw = re.search(r'^QUALOR_BOOTSTRAP_ADMIN_PASSWORD=(.*)$', env.read_text(), re.M).group(1).strip()
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
csrf = {'v': None}

def q(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request('http://127.0.0.1:19080' + path, data=data, method=method)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if method != 'GET' and csrf['v']:
        req.add_header('X-Qualor-Csrf', csrf['v'])
    with op.open(req, timeout=120) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None

q('POST', '/api/v0/auth/login', {'username': 'admin', 'password': pw})
csrf['v'] = q('GET', '/api/v0/auth/me')['csrfToken']
created = q('POST', '/api/v0/projects/01a2159e-cb8d-70a9-8672-6a3113c7a83c/tokens',
            {'name': f'premerge-{scan_dir.name[-6:]}', 'expiresInDays': 1})
(scan_dir / 'token').write_text(created['token'] + '\n', encoding='utf8')
(scan_dir / 'token-id').write_text(created['id'], encoding='utf8')
print(f'analysis token {created["id"][:8]}… created')
PYEOF

set +e
docker run --rm --network host --user "$(id -u):$(id -g)" --cpus 4 --memory 8g \
  --read-only --tmpfs /tmp:rw,exec,size=1g,mode=1777 --cap-drop ALL --security-opt no-new-privileges \
  --env HOME=/tmp \
  --mount "type=bind,src=$scan_dir/checkout,dst=/src,readonly" \
  --mount "type=bind,src=$scan_dir/qualor.yml,dst=/pilot/qualor.yml,readonly" \
  --mount "type=bind,src=$scan_dir/token,dst=/pilot/project-token,readonly" \
  --workdir /src \
  docker.io/qualor/scanner:0.17.0@sha256:deaa73488a12ea1adb56f6b663558d8959411e80318a954d9d6a9074c50f8c47 \
  scan --config /pilot/qualor.yml --server-url http://127.0.0.1:19080 \
  --token-file /pilot/project-token --project-key JX-t11/AgentMesh --branch "$branch"
gate=$?
set -e

if [[ -f "$token_id_file" ]]; then
  python3 - "$scan_dir" <<'PYEOF' || true
import http.cookiejar, json, re, sys, urllib.request
from pathlib import Path

scan_dir = Path(sys.argv[1])
env = Path('/home/jx03/work_lumin/llm_train/code-workplace/dev-tools/qualor/.env')
pw = re.search(r'^QUALOR_BOOTSTRAP_ADMIN_PASSWORD=(.*)$', env.read_text(), re.M).group(1).strip()
token_id = (scan_dir / 'token-id').read_text().strip()
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
csrf = {'v': None}

def q(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request('http://127.0.0.1:19080' + path, data=data, method=method)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    if method != 'GET' and csrf['v']:
        req.add_header('X-Qualor-Csrf', csrf['v'])
    with op.open(req, timeout=120) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None

q('POST', '/api/v0/auth/login', {'username': 'admin', 'password': pw})
csrf['v'] = q('GET', '/api/v0/auth/me')['csrfToken']
q('DELETE', f'/api/v0/projects/01a2159e-cb8d-70a9-8672-6a3113c7a83c/tokens/{token_id}')
print('analysis token deleted')
PYEOF
fi

if [[ "$gate" -ne 0 ]]; then
  echo "Qualor 质量门未通过（exit $gate）" >&2
  exit 1
fi

echo '== 双门禁通过：Semgrep 0 命中 + Qualor 质量门 passed，允许合入 main'
