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

# A named custom provider binds its credentials explicitly; Hermes does not use
# OPENAI_API_KEY for unrelated hosts such as the Zhipu endpoint.
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

export HERMES_PROVIDER LLM_API LLM_BASE_URL LLM_MODEL LLM_CONTEXT_WINDOW
/opt/hermes/.venv/bin/python3 - "${HERMES_HOME}/config.yaml" <<'PY'
import json
import os
import sys

provider = os.environ["HERMES_PROVIDER"]
config = {
    "plugins": {"enabled": ["agentmesh"]},
    "tools": {"tool_search": False},
    "model": {
        "default": os.environ["LLM_MODEL"],
        "provider": "custom:agentmesh" if provider == "custom" else provider,
        "base_url": os.environ["LLM_BASE_URL"],
        "context_length": int(os.environ["LLM_CONTEXT_WINDOW"]),
    },
}
if provider == "custom":
    config["custom_providers"] = [{
        "name": "agentmesh",
        "base_url": os.environ["LLM_BASE_URL"],
        "model": os.environ["LLM_MODEL"],
        "key_env": "LLM_API_KEY",
        "api_mode": "anthropic_messages" if os.environ["LLM_API"] == "anthropic-messages" else "chat_completions",
    }]
with open(sys.argv[1], "w") as handle:
    json.dump(config, handle, indent=2)
PY
chmod 0600 "${HERMES_HOME}/config.yaml"

export PYTHONPATH="${HERMES_HOME}/plugins:${PYTHONPATH:-}"
exec /opt/hermes/.venv/bin/python3 -m agentmesh.daemon
