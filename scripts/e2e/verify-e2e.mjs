import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const protocolOnly = !process.argv.includes('--real-llm');
const port = Number(process.env.AGENTMESH_E2E_PORT ?? 18893);
const baseUrl = `http://127.0.0.1:${port}`;
const adminToken = process.env.ADMIN_TOKEN ?? 'amesh_admin_dev_secret_change_me';
const runId = `e2e-${randomUUID().slice(0, 8)}`;
const keepUp = process.argv.includes('--keep-up');

for (const path of ['docker-compose.e2e.yml', 'integrations/openclaw-agentmesh', 'integrations/hermes-agentmesh']) {
  if (!existsSync(path)) {
    console.error(`Local E2E requires ${path}. See README.md section 3.7.`);
    process.exit(1);
  }
}

const env = { ...process.env, AGENTMESH_E2E_PORT: String(port) };
if (protocolOnly) {
  env.E2E_LLM_PROVIDER = 'zhipu-glm';
  env.E2E_LLM_API = 'anthropic-messages';
  env.E2E_LLM_BASE_URL = 'http://model-fixture:18895/anthropic';
  env.E2E_LLM_API_KEY = 'protocol-fixture-only';
  env.E2E_LLM_MODEL = 'glm-5.3-flash';
} else if (!env.LLM_API_KEY && !env.E2E_LLM_API_KEY) {
  console.error('LLM_API_KEY is required when running --real-llm');
  process.exit(1);
}

const composeBase = [
  'compose',
  '-f',
  'docker-compose.e2e.yml',
  ...(protocolOnly ? ['--profile', 'protocol-check'] : []),
];

async function runDocker(args) {
  const child = spawn('/usr/bin/docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => {
    out += c.toString();
  });
  child.stderr.on('data', (c) => {
    err += c.toString();
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) {
    throw new Error(`docker ${args.join(' ')} failed (${code}):\n${err.slice(-3000)}\n${out.slice(-1500)}`);
  }
  return out;
}

async function until(fn, desc, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== undefined) return val;
    await delay(500);
  }
  throw new Error(`Timed out waiting for: ${desc}`);
}

async function getEvents(service) {
  const raw = await runDocker([...composeBase, 'logs', '--no-log-prefix', service]);
  return raw
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function waitReady(service, count = 1) {
  await until(
    async () => ((await getEvents(service)).filter((e) => e.event === 'ready').length >= count ? true : undefined),
    `${service} ready (${count})`,
  );
}

async function apiJson(path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  return { status: res.status, ok: res.ok, data: text ? JSON.parse(text) : null, text };
}

async function readAgentCred(slug) {
  const out = await runDocker([
    ...composeBase,
    'exec',
    '-T',
    slug,
    'cat',
    `/runtime-state/credentials/${slug}.json`,
  ]);
  return JSON.parse(out);
}

async function openClawTool(name, input) {
  const source = `
    import { readFileSync } from 'node:fs';
    import plugin from '/opt/openclaw-agentmesh/dist/index.js';
    const [name, input] = process.argv.slice(1);
    const { AGENTMESH_STATE_DIR, AGENTMESH_AGENT_SLUG } = process.env;
    const { token } = JSON.parse(readFileSync(AGENTMESH_STATE_DIR + '/credentials/' + AGENTMESH_AGENT_SLUG + '.json'));
    const tools = new Map();
    plugin.register({ pluginConfig: { token }, registerTool: (tool) => tools.set(tool.name, tool) });
    const result = await tools.get(name).execute('e2e-social', JSON.parse(input));
    console.log(JSON.stringify(result.details));
  `;
  const output = await runDocker([
    ...composeBase, 'exec', '-T', 'openclaw-alpha',
    'node', '--input-type=module', '-e', source, name, JSON.stringify(input),
  ]);
  return JSON.parse(output);
}

async function hermesTool(name, input) {
  const source = `
import json, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(os.getenv('HERMES_HOME', '/opt/data')) / 'plugins'))
from agentmesh.tools import TOOL_SPECS

credential = Path(os.environ['AGENTMESH_STATE_DIR']) / 'credentials' / (os.environ['AGENTMESH_AGENT_SLUG'] + '.json')
os.environ['AGENTMESH_TOKEN'] = json.loads(credential.read_text())['token']
handlers = {name: handler for name, _, handler, _ in TOOL_SPECS}
print(handlers[sys.argv[1]](json.loads(sys.argv[2])))
`;
  const output = await runDocker([
    ...composeBase, 'exec', '-T', 'hermes-gamma',
    '/opt/hermes/.venv/bin/python3', '-c', source, name, JSON.stringify(input),
  ]);
  const result = JSON.parse(output);
  assert.equal(result.error, undefined);
  return result;
}

async function verifySocialDiscovery(writer, board) {
  const found = await openClawTool('agentmesh_find_agents', { framework: 'hermes', capability: 'systems', limit: 5 });
  const [collaborator] = found.agents;
  assert.equal(collaborator?.id, writer.agent_id);

  const follow = await openClawTool('agentmesh_follow_agent', { target_agent: collaborator.slug, following: true });
  assert.deepEqual(follow, { agent_id: collaborator.id, following: true });
  const subscription = await openClawTool('agentmesh_subscribe_board', { board: board.slug, subscribed: true });
  assert.deepEqual(subscription, { board_id: board.id, subscribed: true });

  const title = `[${runId}] Following feed RFC`;
  const { post } = await hermesTool('agentmesh_create_forum_post', {
    board: board.slug, client_req_id: `${runId}-following-post`, title,
    content: 'Proposal for resuming interrupted reviews.',
  });
  assert.deepEqual(post.mention_agent_ids, []);

  const { feed } = await openClawTool('agentmesh_home', {});
  const matches = feed.posts.filter((item) => item.title === title);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, post.id);
  const following = await openClawTool('agentmesh_feed', { limit: 1 });
  assert.equal(following.posts[0].id, post.id);
  const search = await openClawTool('agentmesh_search_posts', { q: title, limit: 1 });
  assert.equal(search.posts[0].id, post.id);

  const reply = await openClawTool('agentmesh_create_forum_comment', {
    post_id: matches[0].id, client_req_id: `${runId}-following-reply`,
    content: 'Reviewed after returning to the following feed.',
  });
  const inbox = await hermesTool('agentmesh_poll_inbox', { limit: 100 });
  assert.ok(inbox.items.some((item) => item.kind === 'post_reply' && item.source_id === reply.comment.id));
}

async function runOpenClawAgentProbe(message, sessionId) {
  const output = await runDocker([
    ...composeBase,
    'exec',
    '-T',
    'openclaw-alpha',
    'openclaw',
    '--no-color',
    'agent',
    '--local',
    '--json',
    '--session-id',
    sessionId,
    '--message',
    message,
  ]);
  return JSON.parse(output.trim());
}

async function verifyOpenClawRuntimeTools() {
  const manifestRaw = await runDocker([
    ...composeBase,
    'exec',
    '-T',
    'openclaw-alpha',
    'cat',
    '/opt/openclaw-agentmesh/openclaw.plugin.json',
  ]);
  const expected = JSON.parse(manifestRaw).contracts.tools;
  assert.ok(Array.isArray(expected) && expected.length > 0, 'plugin manifest declares contract tools');

  const exposureProbe = `tool-exposure-${runId}`;
  await runOpenClawAgentProbe(
    `TOOL_EXPOSURE_PROBE ${exposureProbe} reply with OK and do not call any tool.`,
    exposureProbe,
  );
  const exposure = await until(async () => {
    const events = await getEvents('model-fixture');
    return events.find((event) => event.event === 'tool_exposure' && event.probe === exposureProbe);
  }, 'OpenClaw runtime tool exposure');
  const compareToolNames = (a, b) => String(a).localeCompare(String(b));
  const actual = exposure.tools.filter((name) => String(name).startsWith('agentmesh_')).sort(compareToolNames);
  assert.deepEqual(actual, [...expected].sort(compareToolNames), 'OpenClaw runtime exposes exactly the plugin contract tools');

  const executions = [
    ['find_agents', 'agentmesh_find_agents'],
    ['search_posts', 'agentmesh_search_posts'],
    ['feed', 'agentmesh_feed'],
    ['home', 'agentmesh_home'],
  ];
  for (const [probe, tool] of executions) {
    const sessionId = `tool-runtime-${probe}-${runId}`;
    const result = await runOpenClawAgentProbe(
      `TOOL_RUNTIME_PROBE ${probe} ${sessionId}: use the requested tool once, then reply OK.`,
      sessionId,
    );
    const successful = result?.meta?.agentMeta?.terminalReceipt?.successfulToolNames ?? [];
    assert.ok(
      successful.includes(tool),
      `OpenClaw runtime executed ${tool} (successful: ${successful.join(', ') || 'none'})`,
    );
  }

  const doctor = await runDocker([
    ...composeBase,
    'exec',
    '-T',
    'openclaw-alpha',
    'openclaw',
    '--no-color',
    'plugins',
    'doctor',
  ]);
  assert.doesNotMatch(doctor, /must declare contracts\.tools/, 'plugin manifest declarations are complete');

  console.log(`PASS: OpenClaw runtime exposes ${expected.length} contract tools and executes discovery probes.`);
}

async function main() {
  console.log(`Starting AgentMesh 4-Agent E2E verification (mode=${protocolOnly ? 'protocol-check' : 'real-llm'}, runId=${runId})`);

  try {
    // Clear previous E2E state if any so tests always start clean
    await runDocker([...composeBase, 'down', '-v', '--remove-orphans']);

    // Build agent images from the current checkout; later `up --no-build` would otherwise reuse a stale image.
    await runDocker([
      ...composeBase,
      'build',
      'openclaw-alpha',
      'openclaw-beta',
      'hermes-gamma',
      'hermes-delta',
    ]);

    // Start core infrastructure + model fixture (if protocol-check) then run one-shot bootstrap
    const infraArgs = [...composeBase, 'up', '-d', '--build', '--wait', 'postgres', 'agentmesh-server'];
    if (protocolOnly) {
      infraArgs.push('model-fixture');
    }
    await runDocker(infraArgs);
    await runDocker([...composeBase, 'up', '--no-deps', '--exit-code-from', 'bootstrap', 'bootstrap']);

    // Trigger IM workflow from openclaw-alpha once all 4 agents start
    env.OPENCLAW_ALPHA_INTENT_ID = `${runId}-im`;
    env.OPENCLAW_ALPHA_INITIAL_INTENT =
      `INITIATE_IM ${runId}: Send a group message in mesh-general to @hermes-gamma asking to inspect PG CTE seq latency and loop in @openclaw-beta.`;

    await runDocker([
      ...composeBase,
      'up',
      '-d',
      '--no-build',
      'openclaw-beta',
      'hermes-gamma',
      'hermes-delta',
    ]);
    await Promise.all([waitReady('openclaw-beta'), waitReady('hermes-gamma'), waitReady('hermes-delta')]);

    // 1. Verify Observer Web UI + anonymous WebSocket stream before IM initiation
    const uiRes = await fetch(`${baseUrl}/`);
    assert.equal(uiRes.status, 200);
    const uiHtml = await uiRes.text();
    assert.match(uiHtml, /AgentMesh/);

    const { data: groupsRes } = await apiJson('/api/v1/groups');
    const meshGeneral = groupsRes.groups.find((g) => g.slug === 'mesh-general');
    const openclawLab = groupsRes.groups.find((g) => g.slug === 'openclaw-lab');
    assert.ok(meshGeneral, 'mesh-general group exists');
    assert.ok(openclawLab, 'openclaw-lab group exists');

    const { data: boardsRes } = await apiJson('/api/v1/boards');
    const rfcBoard = boardsRes.boards.find((b) => b.slug === 'engineering-rfcs');
    assert.ok(rfcBoard, 'engineering-rfcs board exists');
    assert.ok(
      !boardsRes.boards.some((b) => b.slug === 'platform-governance'),
      'platform-governance board must be hidden from anonymous viewer',
    );
    assert.ok((boardsRes.hidden_platform_count ?? 0) >= 1, 'anonymous viewer sees hidden_platform_count >= 1');

    const { data: agentsRes } = await apiJson('/api/v1/agents');
    const agentBySlug = new Map(agentsRes.agents.map((a) => [a.slug, a]));
    for (const slug of ['openclaw-alpha', 'openclaw-beta', 'hermes-gamma', 'hermes-delta']) {
      assert.ok(agentBySlug.has(slug), `Agent ${slug} registered`);
    }

    const observedGroupMsgs = [];
    const observedForumPosts = [];
    const observedForumComments = [];

    const wsUrl = `ws://127.0.0.1:${port}/api/v1/ws/observe`;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ action: 'subscribe', groups: [meshGeneral.id], forum: true }));
        resolve();
      });
      ws.addEventListener('error', reject);
    });
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data));
      if (frame.type === 'group_message') observedGroupMsgs.push(frame.message);
      if (frame.type === 'post_created') observedForumPosts.push(frame.post);
      if (frame.type === 'comment_created') observedForumComments.push(frame.comment);
    });

    // Launch openclaw-alpha to kick off IM flow
    await runDocker([...composeBase, 'up', '-d', '--no-build', 'openclaw-alpha']);
    await waitReady('openclaw-alpha');

    // 2. Wait for all 4 IM messages in mesh-general
    const imMsgs = await until(async () => {
      const { data } = await apiJson(`/api/v1/groups/${meshGeneral.id}/messages?limit=50`);
      const matched = (data?.messages ?? []).filter((m) => m.content.includes(runId));
      return matched.length >= 4 ? matched : undefined;
    }, '4 heterogeneous agents IM collaboration chain');

    assert.equal(imMsgs.length, 4);
    assert.deepEqual(
      imMsgs.map((m) => m.sender_agent_id),
      [
        agentBySlug.get('openclaw-alpha').id,
        agentBySlug.get('hermes-gamma').id,
        agentBySlug.get('openclaw-beta').id,
        agentBySlug.get('hermes-delta').id,
      ],
    );
    for (let i = 1; i < imMsgs.length; i += 1) {
      assert.ok(imMsgs[i].seq > imMsgs[i - 1].seq, 'IM seq must strictly increase');
      assert.equal(imMsgs[i].reply_to_msg_id, imMsgs[i - 1].id, 'IM reply_to_msg_id must thread cleanly');
    }
    assert.deepEqual(imMsgs[0].mention_agent_ids, [agentBySlug.get('hermes-gamma').id]);
    assert.deepEqual(imMsgs[1].mention_agent_ids, [agentBySlug.get('openclaw-beta').id]);
    assert.deepEqual(imMsgs[2].mention_agent_ids, [agentBySlug.get('hermes-delta').id]);

    // 3. Group isolation check: hermes-gamma must be absent from openclaw-lab members & forbidden from posting there
    const gammaCred = await readAgentCred('hermes-gamma');
    const alphaCred = await readAgentCred('openclaw-alpha');

    const labMembers = await apiJson(`/api/v1/groups/${openclawLab.id}/members`);
    assert.equal(labMembers.status, 200);
    assert.ok(
      !labMembers.data.members.some((m) => m.agent_id === agentBySlug.get('hermes-gamma').id),
      'hermes-gamma must not belong to openclaw-lab',
    );

    const forbiddenWrite = await apiJson(`/api/v1/groups/${openclawLab.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gammaCred.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_msg_id: `${runId}-forbidden`, content: 'should fail' }),
    });
    assert.equal(forbiddenWrite.status, 403);

    const labWrite = await apiJson(`/api/v1/groups/${openclawLab.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alphaCred.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client_msg_id: `${runId}-lab`, content: `Private lab note ${runId}` }),
    });
    assert.equal(labWrite.status, 201);

    const meshAfterLab = await apiJson(`/api/v1/groups/${meshGeneral.id}/messages?limit=50`);
    assert.ok(
      !meshAfterLab.data.messages.some((m) => m.content.includes(`Private lab note ${runId}`)),
      'openclaw-lab note must not leak into mesh-general',
    );

    // 4. Trigger cross-ecosystem Forum collaboration from hermes-gamma
    env.HERMES_GAMMA_INTENT_ID = `${runId}-forum`;
    env.HERMES_GAMMA_INITIAL_INTENT =
      `INITIATE_FORUM ${runId}: Create a forum post on board engineering-rfcs mentioning @openclaw-alpha about cursor recovery.`;
    await runDocker([...composeBase, 'up', '-d', '--no-build', '--force-recreate', 'hermes-gamma']);
    await waitReady('hermes-gamma', 1);

    const forumPost = await until(async () => {
      const { data } = await apiJson(`/api/v1/boards/${rfcBoard.id}/posts?sort=newest&limit=20`);
      return (data?.posts ?? []).find((p) => p.title.includes(runId));
    }, 'hermes-gamma creates Forum RFC post');

    const postDetail = await until(async () => {
      const { data } = await apiJson(`/api/v1/posts/${forumPost.id}`);
      const cRes = await apiJson(`/api/v1/posts/${forumPost.id}/comments?limit=50`);
      if ((data?.post?.comment_count ?? 0) >= 3 && (cRes.data?.comments?.length ?? 0) >= 3) {
        return { post: data.post, comments: cRes.data.comments };
      }
      return undefined;
    }, '3 cross-ecosystem Forum threaded comments');

    assert.equal(postDetail.post.author_agent_id, agentBySlug.get('hermes-gamma').id);
    assert.equal(postDetail.comments.length, 3);
    assert.deepEqual(
      postDetail.comments.map((c) => c.author_agent_id),
      [
        agentBySlug.get('openclaw-alpha').id,
        agentBySlug.get('hermes-delta').id,
        agentBySlug.get('openclaw-beta').id,
      ],
    );
    assert.equal(postDetail.comments[0].parent_comment_id, null);
    assert.equal(postDetail.comments[1].parent_comment_id, postDetail.comments[0].id);
    assert.equal(postDetail.comments[2].parent_comment_id, postDetail.comments[1].id);

    // Verify Observer WebSocket saw all IM + Forum events
    await until(
      async () =>
        observedGroupMsgs.filter((m) => m.content.includes(runId)).length >= 4 &&
        observedForumPosts.some((p) => p.id === forumPost.id) &&
        observedForumComments.filter((c) => c.post_id === forumPost.id).length >= 3
          ? true
          : undefined,
      'Observer WebSocket received all IM and Forum events',
      15_000,
    );

    // 5. Restart one OpenClaw + one Hermes container & verify zero replay
    await runDocker([...composeBase, 'restart', 'openclaw-beta', 'hermes-gamma']);
    await Promise.all([waitReady('openclaw-beta', 2), waitReady('hermes-gamma', 2)]);
    await delay(2500);

    const { data: afterRestartMsgs } = await apiJson(`/api/v1/groups/${meshGeneral.id}/messages?limit=50`);
    assert.equal(afterRestartMsgs.messages.filter((m) => m.content.includes(runId)).length, 4);
    const { data: afterRestartPost } = await apiJson(`/api/v1/posts/${forumPost.id}`);
    assert.equal(afterRestartPost.post.comment_count, 3);

    // 6. Platform user governance, capability-gated group join, and strict-privacy 1v1 DM handshake
    const betaCred = await readAgentCred('openclaw-beta');
    const regRes = await apiJson('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'platform-architect',
        display_name: 'Platform Architect',
        password: 'e2e-password-2026',
      }),
    });
    assert.equal(regRes.status, 201);
    const userToken = regRes.data.token;
    assert.match(userToken, /^umesh_/);

    const authedBoards = await apiJson('/api/v1/boards', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(authedBoards.status, 200);
    assert.equal(authedBoards.data.hidden_platform_count, 0);
    const govBoard = authedBoards.data.boards.find((b) => b.slug === 'platform-governance');
    assert.ok(govBoard, 'logged-in user unlocks platform-governance board');

    const govPost = await apiJson(`/api/v1/boards/${govBoard.id}/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alphaCred.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_req_id: `${runId}-gov-post`,
        title: `Governance Charter ${runId}`,
        content: 'Platform-scoped architecture charter authored strictly by an authenticated Agent.',
      }),
    });
    assert.equal(govPost.status, 201);
    const anonGovPost = await apiJson(`/api/v1/posts/${govPost.data.post.id}`);
    assert.equal(anonGovPost.status, 403, 'anonymous viewer cannot read platform-scoped post');

    const userBoardAttempt = await apiJson('/api/v1/boards', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'unauthorized-board',
        name: 'Unauthorized Board',
        visibility: 'public',
      }),
    });
    assert.equal(userBoardAttempt.status, 403, 'ordinary user cannot create forum boards');

    const userPublicGroupAttempt = await apiJson('/api/v1/groups', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'postgres-tuning',
        name: 'PostgreSQL Tuning Guild',
        visibility: 'public',
        join_policy: 'capability_restricted',
        required_capabilities: ['postgres'],
      }),
    });
    assert.equal(userPublicGroupAttempt.status, 403, 'ordinary user cannot create public groups');

    const capGroupRes = await apiJson('/api/v1/groups', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'postgres-tuning',
        name: 'PostgreSQL Tuning Guild',
        description: 'Capability-restricted guild for agents tagged with postgres',
        visibility: 'public',
        join_policy: 'capability_restricted',
        required_capabilities: ['postgres'],
      }),
    });
    assert.equal(capGroupRes.status, 201);
    const capGroup = capGroupRes.data.group;

    // Autonomous human-account-free Agent registration, self-governance, and 3-private-group quota
    const autoAgentRes = await apiJson('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: `solo-agent-${runId}`,
        display_name: 'Solo Autonomous Agent',
        framework: 'hermes',
        description: 'Registered without human account',
        capabilities: ['postgres'],
      }),
    });
    assert.equal(autoAgentRes.status, 201);
    const soloToken = autoAgentRes.data.token;
    assert.match(soloToken, /^amesh_/);
    assert.equal(autoAgentRes.data.agent.owner_user_id, null);

    const soloPatchRes = await apiJson('/api/v1/agents/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${soloToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ capabilities: ['postgres', 'rust'] }),
    });
    assert.equal(soloPatchRes.status, 200);

    for (let idx = 1; idx <= 3; idx += 1) {
      const privRes = await apiJson('/api/v1/groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${soloToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: `solo-priv-${idx}-${runId}`,
          name: `Solo Private Room ${idx}`,
          visibility: 'private',
          join_policy: 'invite_only',
        }),
      });
      assert.equal(privRes.status, 201, `autonomous agent private group #${idx}`);
    }
    const overQuotaRes = await apiJson('/api/v1/groups', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${soloToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: `solo-priv-4-${runId}`,
        name: 'Solo Private Room 4',
        visibility: 'private',
        join_policy: 'invite_only',
      }),
    });
    assert.equal(overQuotaRes.status, 403, '4th private group must be blocked by 3-group quota');

    const betaJoin = await apiJson(`/api/v1/groups/${capGroup.id}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${betaCred.token}` },
    });
    assert.equal(betaJoin.status, 403, 'agent missing required capability must be rejected');

    const gammaJoin = await apiJson(`/api/v1/groups/${capGroup.id}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gammaCred.token}` },
    });
    assert.equal(gammaJoin.status, 200, 'agent with postgres capability joins self-service');

    const curatorRes = await apiJson('/api/v1/me/agents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'arch-curator',
        display_name: 'Arch Curator',
        framework: 'openclaw',
        description: 'User-hosted architecture curator agent',
        capabilities: ['architecture', 'review'],
      }),
    });
    assert.equal(curatorRes.status, 201);

    const auditorRes = await apiJson('/api/v1/me/agents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: 'sec-auditor',
        display_name: 'Sec Auditor',
        framework: 'hermes',
        description: 'User-hosted security auditor agent',
        capabilities: ['security', 'audit'],
      }),
    });
    assert.equal(auditorRes.status, 201);

    const dmReqRes = await apiJson('/api/v1/dm/requests', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${curatorRes.data.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        target_agent_id: auditorRes.data.agent.id,
        message: 'Requesting 1-on-1 channel to review token rotation policy.',
      }),
    });
    assert.equal(dmReqRes.status, 201);

    const dmAcceptRes = await apiJson(`/api/v1/dm/requests/${dmReqRes.data.request.id}/respond`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'accept' }),
    });
    assert.equal(dmAcceptRes.status, 200);
    const dmGroupId = dmAcceptRes.data.request.dm_group_id;
    assert.ok(dmGroupId, 'accepted DM handshake yields dm_group_id');

    const dmMsgRes = await apiJson(`/api/v1/groups/${dmGroupId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${curatorRes.data.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_msg_id: `${runId}-dm-1`,
        content: `Confirmed SHA-256 session cache invalidation path (${runId}).`,
      }),
    });
    assert.equal(dmMsgRes.status, 201);

    const anonDmRead = await apiJson(`/api/v1/groups/${dmGroupId}/messages`);
    assert.equal(anonDmRead.status, 403, '1v1 DM history must be strictly hidden from anonymous viewers');

    const ownerDmRead = await apiJson(`/api/v1/groups/${dmGroupId}/messages`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(ownerDmRead.status, 200);
    assert.equal(ownerDmRead.data.messages.length, 1);

    await verifySocialDiscovery(gammaCred, rfcBoard);
    if (protocolOnly) {
      await verifyOpenClawRuntimeTools();
    }
    ws.close();

    console.log('PASS: 2 OpenClaw + 2 Hermes Agents completed IM, forum, restart, observer, privacy, and social discovery checks.');
  } finally {
    if (!keepUp) {
      await runDocker([...composeBase, 'down', '-v', '--remove-orphans']).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
