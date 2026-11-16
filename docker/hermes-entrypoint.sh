#!/usr/bin/env bash
set -euo pipefail

AGENTMESH_URL="${AGENTMESH_URL:-http://agentmesh-server:18890}"
AGENTMESH_AGENT_SLUG="${AGENTMESH_AGENT_SLUG:?AGENTMESH_AGENT_SLUG is required}"
AGENTMESH_STATE_DIR="${AGENTMESH_STATE_DIR:-/runtime-state}"
HERMES_HOME="${HERMES_HOME:-/opt/data}"
CRED_FILE="${AGENTMESH_STATE_DIR}/credentials/${AGENTMESH_AGENT_SLUG}.json"

for _ in $(seq 1 60); do
  if [ -f "$CRED_FILE" ]; then
    break
  fi
  sleep 1
done

if [ ! -f "$CRED_FILE" ]; then
  echo "Credential file not found: $CRED_FILE" >&2
  exit 1
fi

export AGENTMESH_TOKEN
AGENTMESH_TOKEN="$(/opt/hermes/.venv/bin/python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['token'], end='')" "$CRED_FILE")"

LLM_API="${LLM_API:-anthropic-messages}"
LLM_BASE_URL="${LLM_BASE_URL:-https://open.bigmodel.cn/api/anthropic}"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_MODEL="${LLM_MODEL:-glm-5.3-flash}"
LLM_CONTEXT_WINDOW="${LLM_CONTEXT_WINDOW:-250000}"

mkdir -p "${HERMES_HOME}/plugins" "${HERMES_HOME}/skills"
rm -rf "${HERMES_HOME}/plugins/agentmesh" "${HERMES_HOME}/skills/agentmesh"
cp -R /opt/agentmesh-plugin "${HERMES_HOME}/plugins/agentmesh"
cp -R /opt/agentmesh-plugin/skills/agentmesh "${HERMES_HOME}/skills/agentmesh"

# /anthropic endpoints with provider="custom" preserve model slugs verbatim while routing via anthropic_messages.
if [ "$LLM_API" = "anthropic-messages" ]; then
  if [[ "$LLM_BASE_URL" == */anthropic ]]; then
    HERMES_PROVIDER="custom"
  else
    HERMES_PROVIDER="anthropic"
  fi
  export ANTHROPIC_API_KEY="$LLM_API_KEY"
  export ANTHROPIC_BASE_URL="$LLM_BASE_URL"
  export OPENAI_API_KEY="$LLM_API_KEY"
else
  HERMES_PROVIDER="custom"
  export OPENAI_API_KEY="$LLM_API_KEY"
  export OPENAI_BASE_URL="$LLM_BASE_URL"
fi

cat > "${HERMES_HOME}/config.yaml" <<EOF
plugins:
  enabled:
    - agentmesh
tools:
  tool_search: false
model:
  default: "${LLM_MODEL}"
  provider: "${HERMES_PROVIDER}"
  base_url: "${LLM_BASE_URL}"
  context_length: ${LLM_CONTEXT_WINDOW}
EOF
chmod 0600 "${HERMES_HOME}/config.yaml"
chown -R hermes:hermes "${HERMES_HOME}"

export PYTHONPATH="${HERMES_HOME}/plugins:${PYTHONPATH:-}"
exec /opt/hermes/.venv/bin/python3 -m agentmesh.daemon
