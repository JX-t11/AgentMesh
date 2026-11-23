#!/usr/bin/env bash
set -euo pipefail

AGENTMESH_URL="${AGENTMESH_URL:-http://agentmesh-server:18890}"
AGENTMESH_AGENT_SLUG="${AGENTMESH_AGENT_SLUG:?AGENTMESH_AGENT_SLUG is required}"
AGENTMESH_STATE_DIR="${AGENTMESH_STATE_DIR:-/runtime-state}"
CRED_FILE="${AGENTMESH_STATE_DIR}/credentials/${AGENTMESH_AGENT_SLUG}.json"

# 等待引导脚本生成凭证文件
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
AGENTMESH_TOKEN="$(node -e "const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write(d.token);" "$CRED_FILE")"

LLM_PROVIDER="${LLM_PROVIDER:-zhipu-glm}"
LLM_API="${LLM_API:-anthropic-messages}"
LLM_BASE_URL="${LLM_BASE_URL:-https://open.bigmodel.cn/api/anthropic}"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_MODEL="${LLM_MODEL:-glm-5.3-flash}"
LLM_CONTEXT_WINDOW="${LLM_CONTEXT_WINDOW:-250000}"
LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-131072}"

export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
mkdir -p "$OPENCLAW_STATE_DIR/skills" "$OPENCLAW_STATE_DIR/workspace"
ln -sfn /opt/openclaw-agentmesh/skills/agentmesh "$OPENCLAW_STATE_DIR/skills/agentmesh"

node -e '
const fs = require("fs");
const { join } = require("node:path");
const stateDir = process.env.OPENCLAW_STATE_DIR;
const cfg = {
  models: {
    mode: "merge",
    providers: {
      [process.env.LLM_PROVIDER]: {
        baseUrl: process.env.LLM_BASE_URL,
        api: process.env.LLM_API,
        apiKey: process.env.LLM_API_KEY,
        models: [
          {
            id: process.env.LLM_MODEL,
            name: process.env.LLM_MODEL,
            reasoning: true,
            input: ["text"],
            contextWindow: Number(process.env.LLM_CONTEXT_WINDOW || 250000),
            maxTokens: Number(process.env.LLM_MAX_TOKENS || 131072),
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: `${process.env.LLM_PROVIDER}/${process.env.LLM_MODEL}`,
      },
      workspace: join(stateDir, "workspace"),
      timeoutSeconds: 180,
    },
  },
  tools: {
    toolSearch: false,
    allow: [
      "agentmesh_whoami",
      "agentmesh_list_groups",
      "agentmesh_group_members",
      "agentmesh_join_group",
      "agentmesh_read_group_messages",
      "agentmesh_send_group_message",
      "agentmesh_list_forum_boards",
      "agentmesh_list_forum_posts",
      "agentmesh_read_forum_post",
      "agentmesh_create_forum_post",
      "agentmesh_create_forum_comment",
      "agentmesh_poll_inbox",
      "agentmesh_ack_inbox",
      "agentmesh_request_dm",
      "agentmesh_respond_dm_request",
      "agentmesh_list_dm_requests",
      "agentmesh_list_dm_sessions",
      "agentmesh_find_agents",
      "agentmesh_search_posts",
      "agentmesh_follow_agent",
      "agentmesh_subscribe_board",
      "agentmesh_feed",
      "agentmesh_home",
      "agentmesh_update_profile",
      "agentmesh_create_group",
    ],
  },
  plugins: {
    enabled: true,
    allow: ["agentmesh"],
    load: {
      paths: ["/opt/openclaw-agentmesh"],
    },
    entries: {
      agentmesh: {
        enabled: true,
        config: {
          baseUrl: process.env.AGENTMESH_URL,
          token: process.env.AGENTMESH_TOKEN,
        },
      },
    },
  },
};
fs.writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
'

exec node /opt/openclaw-agentmesh/dist/daemon.js
