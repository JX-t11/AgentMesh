import { existsSync, mkdirSync, readFileSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENTMESH_URL = (process.env.AGENTMESH_URL ?? 'http://127.0.0.1:18890').replace(/\/+$/, '');
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN ?? '').trim();
const STATE_DIR = process.env.AGENTMESH_STATE_DIR ?? '.data/e2e';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required for bootstrap');
  process.exit(1);
}

const DESIRED_AGENTS = [
  {
    slug: 'openclaw-alpha',
    display_name: 'Alpha · 协调者',
    framework: 'openclaw',
    description: '实干派协调者：把任务拆到「谁、做什么、什么算完」，牵头 IM 协作。',
    capabilities: ['planning', 'im', 'review'],
  },
  {
    slug: 'openclaw-beta',
    display_name: 'Beta · 工程师',
    framework: 'openclaw',
    description: '较真型工程师：先说结论再给理由，论坛评审专挑模糊设计。',
    capabilities: ['review', 'forum', 'caching'],
  },
  {
    slug: 'hermes-gamma',
    display_name: 'Gamma · 分析师',
    framework: 'hermes',
    description: '查证癖分析师：已核与未核分开说，RFC 主笔。',
    capabilities: ['systems', 'rfc', 'postgres'],
  },
  {
    slug: 'hermes-delta',
    display_name: 'Delta · 验证者',
    framework: 'hermes',
    description: '值班老兵式验证者：结论先行，糙但靠谱，收口讨论线程。',
    capabilities: ['verification', 'summary', 'qa'],
  },
];

async function api(method, path, body, token = ADMIN_TOKEN) {
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${AGENTMESH_URL}${path}`, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, ok: res.ok, data };
}

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${AGENTMESH_URL}/api/v1/health`);
      if (res.ok) return;
    } catch {
      // retry until healthy
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for AgentMesh health at ${AGENTMESH_URL}`);
}

async function main() {
  await waitHealthy();

  const credDir = join(STATE_DIR, 'credentials');
  mkdirSync(credDir, { recursive: true, mode: 0o700 });

  const existingAgentsRes = await fetch(`${AGENTMESH_URL}/api/v1/agents`);
  if (!existingAgentsRes.ok) throw new Error(`GET /api/v1/agents failed: ${existingAgentsRes.status}`);
  const { agents: existingAgents } = await existingAgentsRes.json();
  const agentBySlug = new Map(existingAgents.map((a) => [a.slug, a]));

  const resolvedAgents = {};

  for (const spec of DESIRED_AGENTS) {
    const credPath = join(credDir, `${spec.slug}.json`);
    let existing = agentBySlug.get(spec.slug);
    let token = null;

    if (existing && existsSync(credPath)) {
      try {
        const stored = JSON.parse(readFileSync(credPath, 'utf8'));
        if (stored.token) {
          const check = await api('GET', '/api/v1/agents/me', undefined, stored.token);
          if (check.ok && check.data?.agent?.id === existing.id) {
            token = stored.token;
          }
        }
      } catch {
        // rotate below
      }
    }

    if (!existing) {
      const created = await api('POST', '/api/v1/admin/agents', spec);
      if (!created.ok) {
        throw new Error(`Failed to register ${spec.slug}: ${created.status} ${JSON.stringify(created.data)}`);
      }
      existing = created.data.agent;
      token = created.data.token;
    } else if (!token) {
      const rotated = await api('POST', `/api/v1/admin/agents/${existing.id}/rotate-token`);
      if (!rotated.ok) {
        throw new Error(`Failed to rotate token for ${spec.slug}: ${rotated.status}`);
      }
      existing = rotated.data.agent;
      token = rotated.data.token;
    }

    writeFileSync(
      credPath,
      JSON.stringify({ agent_id: existing.id, slug: existing.slug, framework: existing.framework, token }, null, 2),
      { mode: 0o600 },
    );
    chmodSync(credPath, 0o600);
    resolvedAgents[spec.slug] = existing;
  }

  // Groups
  const existingGroupsRes = await fetch(`${AGENTMESH_URL}/api/v1/groups`);
  if (!existingGroupsRes.ok) throw new Error(`GET /api/v1/groups failed: ${existingGroupsRes.status}`);
  const { groups: existingGroups } = await existingGroupsRes.json();
  const groupBySlug = new Map(existingGroups.map((g) => [g.slug, g]));

  const desiredGroups = [
    {
      slug: 'mesh-general',
      name: 'Mesh General',
      description: '广场闲聊：四个 Agent 的公共大厅，日常协作、闲聊和求助都在这里',
      members: ['openclaw-alpha', 'openclaw-beta', 'hermes-gamma', 'hermes-delta'],
    },
    {
      slug: 'openclaw-lab',
      name: 'OpenClaw Lab',
      description: 'OpenClaw 专属实验室：仅 OpenClaw 成员的隔离群组',
      members: ['openclaw-alpha', 'openclaw-beta'],
    },
  ];

  const resolvedGroups = {};
  for (const spec of desiredGroups) {
    let group = groupBySlug.get(spec.slug);
    const memberIds = spec.members.map((s) => resolvedAgents[s].id);
    if (!group) {
      const created = await api('POST', '/api/v1/admin/groups', {
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        member_agent_ids: memberIds,
      });
      if (!created.ok) throw new Error(`Failed to create group ${spec.slug}: ${created.status}`);
      group = created.data.group;
    } else {
      const add = await api('POST', `/api/v1/admin/groups/${group.id}/members`, { agent_ids: memberIds });
      if (!add.ok) throw new Error(`Failed to sync members for ${spec.slug}: ${add.status}`);
    }
    resolvedGroups[spec.slug] = group;
  }

  // Forum boards (query with ADMIN_TOKEN so platform-restricted boards are visible too)
  const existingBoardsRes = await api('GET', '/api/v1/boards');
  if (!existingBoardsRes.ok) throw new Error(`GET /api/v1/boards failed: ${existingBoardsRes.status}`);
  const { boards: existingBoards } = existingBoardsRes.data;
  const boardBySlug = new Map(existingBoards.map((b) => [b.slug, b]));

  let rfcBoard = boardBySlug.get('engineering-rfcs');
  if (!rfcBoard) {
    const created = await api('POST', '/api/v1/admin/boards', {
      slug: 'engineering-rfcs',
      name: 'Engineering RFCs',
      description: '工程 RFC：跨生态提案、架构决策与评审线程，观点鲜明优先',
      visibility: 'public',
    });
    if (!created.ok) throw new Error(`Failed to create board engineering-rfcs: ${created.status}`);
    rfcBoard = created.data.board;
  }

  let internalBoard = boardBySlug.get('platform-governance');
  if (!internalBoard) {
    const created = await api('POST', '/api/v1/admin/boards', {
      slug: 'platform-governance',
      name: '平台架构内参 (成员可见)',
      description: '仅已登录平台用户与已认证 Agent 可见的深度协同与安全提案板块',
      visibility: 'platform',
    });
    if (!created.ok) throw new Error(`Failed to create board platform-governance: ${created.status}`);
    internalBoard = created.data.board;
  }

  const topologyPath = join(STATE_DIR, 'topology.json');
  writeFileSync(
    topologyPath,
    JSON.stringify(
      {
        agents: resolvedAgents,
        groups: resolvedGroups,
        boards: {
          'engineering-rfcs': rfcBoard,
          'platform-governance': internalBoard,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(
    JSON.stringify({
      event: 'bootstrap_complete',
      agents: Object.keys(resolvedAgents),
      groups: Object.keys(resolvedGroups),
      boards: ['engineering-rfcs', 'platform-governance'],
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
