#!/usr/bin/env bash
# 生成 Sonar 覆盖率报告(Rust LCOV、web/OpenClaw JS LCOV、Hermes Python Cobertura)。
# 前置: cargo-llvm-cov 0.6.21、llvm-tools-preview、@vitest/coverage-v8、Python coverage。
# 用法: bash scripts/coverage.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v cargo-llvm-cov >/dev/null || {
  echo 'cargo-llvm-cov is required: cargo install cargo-llvm-cov --version 0.6.21 --locked' >&2
  exit 1
}
command -v npm >/dev/null || {
  echo 'npm is required for JS/TS coverage' >&2
  exit 1
}

cd "$ROOT"

echo '[coverage] Rust integration tests'
rustup component add llvm-tools-preview
cargo llvm-cov --workspace --all-targets --lcov --output-path target/agentmesh.lcov
# cargo-llvm-cov 写入绝对路径；Sonar scanner 挂载后需要仓库相对路径。
sed -i "s|^SF:${ROOT}/|SF:|" target/agentmesh.lcov

echo '[coverage] Observer web tests'
npm run test:coverage --prefix web

echo '[coverage] OpenClaw plugin tests'
npm run test:coverage --prefix integrations/openclaw-agentmesh

echo '[coverage] Hermes plugin tests'
python3 -m coverage --version >/dev/null || {
  echo 'Python coverage is required: python3 -m pip install -r integrations/hermes-agentmesh/requirements-dev.txt' >&2
  exit 1
}
rm -f .coverage
rm -rf integrations/hermes-agentmesh/coverage-reports
python3 -m coverage run --rcfile=integrations/hermes-agentmesh/.coveragerc \
  -m unittest discover -s integrations/hermes-agentmesh/tests -p 'test_*.py'
mkdir -p integrations/hermes-agentmesh/coverage-reports
python3 -m coverage report --rcfile=integrations/hermes-agentmesh/.coveragerc -m
python3 -m coverage xml --rcfile=integrations/hermes-agentmesh/.coveragerc \
  -o integrations/hermes-agentmesh/coverage-reports/coverage.xml

echo '[coverage] reports:'
printf '  %s\n' \
  target/agentmesh.lcov \
  web/coverage/lcov.info \
  integrations/openclaw-agentmesh/coverage/lcov.info \
  integrations/hermes-agentmesh/coverage-reports/coverage.xml
