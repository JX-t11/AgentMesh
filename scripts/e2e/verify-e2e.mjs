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
env.AGENTMESH_E2E_PG_PASSWORD ??= randomUUID();
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
    // 真实模型下，重建容器的 catch_up_inbox 先回放积压唤醒轮，每个都是一次 LLM 回合；
    // 意图轮本身偶发 10 分钟以上（模型侧限流/工具循环），给足余量。
    protocolOnly ? 180_000 : 1_500_000,
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

// 等单个守护进程把「此刻已投递」的事件处理并确认完（快照定界：等待期间新到的事件不纳入，
// 否则处理会催生新提及、永排不完）。真实模型下每个事件是一轮 LLM 回合。
async function drainAgent(slug) {
  const cred = await readAgentCred(slug);
  const page = await apiJson('/api/v1/inbox?after_inbox_seq=0&limit=100', {
    headers: { Authorization: `Bearer ${cred.token}` },
  });
  const snapshot = page.data?.next_after_inbox_seq ?? 0;
  if (snapshot === 0) return;
  await until(
    async () => {
      // 重启刚落地时 exec 可能撞上 setns 过渡窗口，视为本轮未就绪、继续轮询。
      let out;
      try {
        out = await runDocker([
          ...composeBase,
          'exec',
          '-T',
          slug,
          'cat',
          `/runtime-state/${slug}/cursor.json`,
        ]);
      } catch {
        return undefined;
      }
      // Hermes 游标是 snake_case，OpenClaw 是 camelCase。
      const cursor = JSON.parse(out);
      const acked = cursor.acked_inbox_seq ?? cursor.ackedInboxSeq ?? 0;
      return acked >= snapshot ? true : undefined;
    },
    `${slug} drains its delivered inbox (up to seq ${snapshot})`,
    protocolOnly ? 60_000 : 900_000,
  );
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
    const agentById = new Map(agentsRes.agents.map((a) => [a.id, a]));
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
    const imStartedAt = Date.now();
    await runDocker([...composeBase, 'up', '-d', '--no-build', 'openclaw-alpha']);
    await waitReady('openclaw-alpha');

    // 2. Wait for the IM collaboration chain in mesh-general. The fixture echoes the runId into
    // every message; real models speak freely, so real mode counts participants since startup.
    const imMsgs = await until(async () => {
      const { data } = await apiJson(`/api/v1/groups/${meshGeneral.id}/messages?limit=50`);
      if (protocolOnly) {
        const matched = (data?.messages ?? []).filter((m) => m.content.includes(runId));
        return matched.length >= 4 ? matched : undefined;
      }
      const recent = (data?.messages ?? []).filter((m) => Date.parse(m.created_at) >= imStartedAt - 2000);
      const senders = new Set(recent.map((m) => m.sender_agent_id));
      const allFour = ['openclaw-alpha', 'openclaw-beta', 'hermes-gamma', 'hermes-delta'].every((slug) =>
        senders.has(agentBySlug.get(slug).id),
      );
      return allFour && recent.length >= 4 ? recent : undefined;
    }, '4 heterogeneous agents IM collaboration chain', protocolOnly ? 180_000 : 600_000);

    if (protocolOnly) {
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
    } else {
      const senders = new Set(imMsgs.map((m) => m.sender_agent_id));
      assert.equal(senders.size, 4, 'all four agents joined the IM exchange');
      assert.ok(imMsgs[0].mention_agent_ids.length >= 1, 'the kickoff message carries a structured mention');
      assert.ok(
        imMsgs.filter((m) => m.reply_to_msg_id).length >= 2,
        'IM replies thread via reply_to_msg_id',
      );
    }

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
    const forumStartedAt = Date.now();
    env.HERMES_GAMMA_INTENT_ID = `${runId}-forum`;
    env.HERMES_GAMMA_INITIAL_INTENT =
      `INITIATE_FORUM ${runId}: Create a forum post on board engineering-rfcs mentioning @openclaw-alpha about cursor recovery.`;
    await drainAgent('hermes-gamma');
    await runDocker([...composeBase, 'up', '-d', '--no-build', '--force-recreate', 'hermes-gamma']);
    await waitReady('hermes-gamma', 1);

    const forumPost = await until(async () => {
      const { data } = await apiJson(`/api/v1/boards/${rfcBoard.id}/posts?sort=newest&limit=20`);
      return (data?.posts ?? []).find((p) =>
        protocolOnly
          ? p.title.includes(runId)
          : p.author_agent_id === agentBySlug.get('hermes-gamma').id &&
            Date.parse(p.created_at) >= forumStartedAt - 2000,
      );
    }, 'hermes-gamma creates Forum RFC post', protocolOnly ? 180_000 : 600_000);

    const postDetail = await until(async () => {
      const { data } = await apiJson(`/api/v1/boards/${rfcBoard.id}/posts?sort=newest&limit=20`);
      const candidates = protocolOnly
        ? (data?.posts ?? []).filter((p) => p.title.includes(runId)).slice(0, 1)
        : (data?.posts ?? []).filter(
            (p) =>
              p.author_agent_id === agentBySlug.get('hermes-gamma').id &&
              Date.parse(p.created_at) >= forumStartedAt - 2000,
          );
      for (const post of candidates) {
        const cRes = await apiJson(`/api/v1/posts/${post.id}/comments?limit=50`);
        const comments = cRes.data?.comments ?? [];
        if (protocolOnly) {
          if ((post.comment_count ?? 0) >= 3 && comments.length >= 3) {
            return { post, comments };
          }
          continue;
        }
        // 真实模型会自组织评审流水线（并行多帖、把后续讨论引去自己的文档都属常态）。
        // 机制层面只锁定：被提及的评审方（openclaw-alpha）跨运行时帖内回应，且楼主侧
        // （hermes 框架）有串楼回楼；不钉楼数、不钉具体是意图窗口里的哪一篇。
        const reviewer = comments.find((c) => agentById.get(c.author_agent_id)?.slug === 'openclaw-alpha');
        const authorSideReply = comments.some(
          (c) =>
            c.parent_comment_id !== null &&
            agentById.get(c.author_agent_id)?.framework === 'hermes',
        );
        if (reviewer && authorSideReply) {
          return { post, comments };
        }
      }
      return undefined;
    }, 'cross-ecosystem Forum threaded review', protocolOnly ? 180_000 : 600_000);

    assert.equal(postDetail.post.author_agent_id, agentBySlug.get('hermes-gamma').id);
    if (protocolOnly) {
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
    } else {
      const frameworks = new Set(postDetail.comments.map((c) => agentById.get(c.author_agent_id)?.framework));
      assert.ok(postDetail.comments.length >= 2, 'forum thread gathers the reviewer and the author side');
      assert.ok(frameworks.has('openclaw') && frameworks.has('hermes'), 'forum replies span both runtimes');
      assert.ok(
        postDetail.comments.filter((c) => c.parent_comment_id !== null).length >= 1,
        'forum replies thread in-comment',
      );
    }

    // 4b. Both daemons forward per-turn tool receipts. Hermes turns run in the resident gateway,
    // whose stderr is not the CLI child's, so its receipts must arrive through the receipt file.
    // Protocol mode pins the exact turn keys; real mode only proves forwarding happened, because
    // real inbox sequences include the free-form debate traffic.
    if (protocolOnly) {
      for (const [service, turn, tool] of [
        ['openclaw-alpha', 'inbox:1', 'agentmesh_create_forum_comment'],
        ['openclaw-beta', 'inbox:1', 'agentmesh_send_group_message'],
        ['hermes-delta', 'inbox:1', 'agentmesh_send_group_message'],
        ['hermes-gamma', `intent:${runId}-forum`, 'agentmesh_create_forum_post'],
      ]) {
        const receipt = await until(
          async () =>
            (await getEvents(service)).find((e) => e.event === 'tool_receipt' && e.turn === turn && e.tool === tool),
          `${service} forwarded tool_receipt ${tool}`,
          15_000,
        );
        assert.equal(receipt.ok, true, `${service} tool_receipt ${tool} is ok`);
      }
    } else {
      for (const service of ['openclaw-alpha', 'openclaw-beta', 'hermes-gamma', 'hermes-delta']) {
        const receipts = await until(
          async () =>
            (await getEvents(service)).filter(
              (e) => e.event === 'tool_receipt' && e.turn.startsWith('inbox:') && e.ok === true,
            ),
          `${service} forwarded inbox tool receipts`,
          60_000,
        );
        assert.ok(receipts.length >= 1, `${service} forwarded at least one inbox receipt`);
      }
      const gammaForum = await until(
        async () =>
          (await getEvents('hermes-gamma')).find(
            (e) =>
              e.event === 'tool_receipt' &&
              e.turn === `intent:${runId}-forum` &&
              e.tool === 'agentmesh_create_forum_post',
          ),
        'hermes-gamma forwarded the forum intent receipt',
        60_000,
      );
      assert.equal(gammaForum.ok, true, 'hermes-gamma forum intent receipt is ok');
    }
    console.log('PASS: both daemons forwarded per-turn tool_receipt events.');

    // Verify Observer WebSocket saw all IM + Forum events. Real mode only requires evidence of
    // forum activity: the models may concentrate replies on an organic sibling post rather than
    // the intent post.
    await until(
      async () =>
        (protocolOnly
          ? observedGroupMsgs.filter((m) => m.content.includes(runId)).length >= 4 &&
            observedForumPosts.some((p) => p.id === forumPost.id) &&
            observedForumComments.filter((c) => c.post_id === forumPost.id).length >= 3
          : observedGroupMsgs.length >= 4 && observedForumPosts.length >= 1 && observedForumComments.length >= 2)
          ? true
          : undefined,
      'Observer WebSocket received all IM and Forum events',
      protocolOnly ? 15_000 : 30_000,
    );

    // 5. Restart one OpenClaw + one Hermes container & verify zero replay. Protocol mode waits
    // for the full startup; real mode only waits for the process — its catch_up may still be
    // replaying legitimate backlog, and the replay check is content-dedupe based.
    await runDocker([...composeBase, 'restart', 'openclaw-beta', 'hermes-gamma']);
    if (protocolOnly) {
      await Promise.all([waitReady('openclaw-beta', 2), waitReady('hermes-gamma', 2)]);
      await delay(2500);
    } else {
      await delay(15_000);
    }

    const { data: afterRestartMsgs } = await apiJson(`/api/v1/groups/${meshGeneral.id}/messages?limit=50`);
    // 真实模式下用机制门选中的帖子验证持久性：模型可能把讨论集中在有机姊妹帖而非意图帖。
    const restartProbePost = protocolOnly ? forumPost.id : postDetail.post.id;
    const { data: afterRestartPost } = await apiJson(`/api/v1/posts/${restartProbePost}`);
    if (protocolOnly) {
      assert.equal(afterRestartMsgs.messages.filter((m) => m.content.includes(runId)).length, 4);
      assert.equal(afterRestartPost.post.comment_count, 3);
    } else {
      // 重启不得重放旧消息：重启后同一发送者的同一段内容至多出现一次。
      const pairs = new Map();
      for (const m of afterRestartMsgs.messages) {
        const key = `${m.sender_agent_id}|${m.content}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
      const replayed = [...pairs.entries()].filter(([, count]) => count > 1);
      assert.deepEqual(replayed, [], 'restart must not replay any previous message');
      assert.ok(afterRestartPost.post.comment_count >= 2, 'forum thread survives the restart');
    }

    // 5c. Cross-round proposal review: R1 hermes-gamma publishes a proposal post (forced intent,
    // no mentions), R2 openclaw-alpha discovers the author by capability tag and follows, R3 alpha
    // revisits via home and reviews in-thread, R4 the inbox wake-up chain converges and stops.
    // Every step runs the real daemon → model → tool path; tool_receipt events are the forensics.
    await drainAgent('hermes-gamma');
    const r1StartedAt = Date.now();
    env.HERMES_GAMMA_INTENT_ID = `${runId}-x-propose`;
    env.HERMES_GAMMA_INITIAL_INTENT =
      `X_PROPOSE ${runId}: 在 engineering-rfcs 板块发布一篇方案帖。标题以 "[${runId}] X-PROPOSAL" 开头；正文依次包含「背景：」「备选：」「取舍锚点：CR-ANCHOR-<自选随机后缀>」「待决：」四段；不要 @ 任何同伴。`;
    await runDocker([...composeBase, 'up', '-d', '--no-build', '--force-recreate', 'hermes-gamma']);
    await waitReady('hermes-gamma', 1);

    const proposal = await until(async () => {
      const { data } = await apiJson(`/api/v1/boards/${rfcBoard.id}/posts?sort=newest&limit=20`);
      return (data?.posts ?? []).find((p) =>
        protocolOnly
          ? p.title.includes('X-PROPOSAL') && p.title.includes(runId)
          : p.author_agent_id === agentBySlug.get('hermes-gamma').id &&
            Date.parse(p.created_at) >= r1StartedAt - 2000,
      );
    }, 'hermes-gamma publishes the cross-round proposal post');
    const proposalDetail = await apiJson(`/api/v1/posts/${proposal.id}`);
    assert.equal(proposalDetail.data.post.author_agent_id, agentBySlug.get('hermes-gamma').id);
    assert.deepEqual(proposalDetail.data.post.mention_agent_ids, [], 'proposal post must not mention anyone');
    for (const section of ['背景：', '备选：', '取舍锚点：', '待决：']) {
      assert.ok(proposalDetail.data.post.content.includes(section), `proposal content carries the ${section} section`);
    }
    const anchor = proposalDetail.data.post.content.match(/CR-ANCHOR-[A-Za-z0-9]+/)?.[0];
    assert.ok(anchor, 'proposal content carries a CR-ANCHOR trade-off token');
    const proposeReceipts = (await getEvents('hermes-gamma')).filter(
      (e) => e.event === 'tool_receipt' && e.turn === `intent:${runId}-x-propose`,
    );
    const postReceipt = proposeReceipts.find((e) => e.tool === 'agentmesh_create_forum_post');
    assert.ok(postReceipt, 'proposal turn called agentmesh_create_forum_post');
    assert.equal(postReceipt.args.board, 'engineering-rfcs');
    assert.equal(postReceipt.args.mentions, undefined, 'proposal receipt carries no mentions');

    // R2: neutral intent — capability tag only, no title/board/content hints (anti-cheat).
    const feedBefore = await apiJson('/api/v1/agents/me/feed', {
      headers: { Authorization: `Bearer ${alphaCred.token}` },
    });
    assert.ok(
      !feedBefore.data.posts.some((p) => p.id === proposal.id),
      'proposal must be absent from the feed before following',
    );
    env.OPENCLAW_ALPHA_INTENT_ID = `${runId}-x-discover`;
    env.OPENCLAW_ALPHA_INITIAL_INTENT =
      `X_DISCOVER ${runId} capability=rfc：用 agentmesh_find_agents 按 capability=rfc 检索一位同伴并关注它。禁止读论坛或搜索帖子。`;
    await drainAgent('openclaw-alpha');
    await runDocker([...composeBase, 'up', '-d', '--no-build', '--force-recreate', 'openclaw-alpha']);
    await waitReady('openclaw-alpha', 1);
    const discoverReceipts = await until(
      async () => {
        const receipts = (await getEvents('openclaw-alpha')).filter(
          (e) => e.event === 'tool_receipt' && e.turn === `intent:${runId}-x-discover`,
        );
        return receipts.some((e) => e.tool === 'agentmesh_follow_agent') ? receipts : undefined;
      },
      'discover turn receipts to settle',
      30_000,
    );
    const discoverTools = discoverReceipts.map((e) => e.tool);
    if (protocolOnly) {
      assert.deepEqual(discoverTools, ['agentmesh_find_agents', 'agentmesh_follow_agent']);
    } else {
      assert.ok(
        discoverTools.includes('agentmesh_find_agents') && discoverTools.includes('agentmesh_follow_agent'),
        `discover turn called find and follow (got: ${discoverTools.join(', ')})`,
      );
    }
    const followReceipt = discoverReceipts.find((e) => e.tool === 'agentmesh_follow_agent');
    assert.equal(followReceipt.args.target_agent, 'hermes-gamma', 'reviewer follows the proposal author');
    const followRows = await runDocker([
      ...composeBase,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'agentmesh',
      '-d',
      'agentmesh',
      '-tAc',
      "SELECT count(*) FROM agent_follows af JOIN agents f ON f.id = af.follower_agent_id JOIN agents g ON g.id = af.followed_agent_id WHERE f.slug = 'openclaw-alpha' AND g.slug = 'hermes-gamma'",
    ]);
    assert.equal(Number(followRows.trim()), 1, 'follow row lands in the database');
    const feedAfter = await apiJson('/api/v1/agents/me/feed', {
      headers: { Authorization: `Bearer ${alphaCred.token}` },
    });
    assert.ok(feedAfter.data.posts.some((p) => p.id === proposal.id), 'following puts the proposal into the feed');

    // R3: neutral revisit intent — home → read → top-level in-thread review citing the anchor.
    const r3StartedAt = Date.now();
    env.OPENCLAW_ALPHA_INTENT_ID = `${runId}-x-revisit`;
    env.OPENCLAW_ALPHA_INITIAL_INTENT =
      `X_REVISIT ${runId}：回访。用 agentmesh_home 查看关注动态，找到标题含 X-PROPOSAL 的帖子并通读全文，然后在原帖顶层（不回复某条评论）发表评审意见：结论先行，并引用正文中的取舍锚点（CR-ANCHOR-…）。禁止使用搜索工具。`;
    await drainAgent('openclaw-alpha');
    await runDocker([...composeBase, 'up', '-d', '--no-build', '--force-recreate', 'openclaw-alpha']);
    await waitReady('openclaw-alpha', 1);
    const review = await until(async () => {
      const res = await apiJson(`/api/v1/posts/${proposal.id}/comments?limit=50`);
      return (res.data?.comments ?? []).find(
        (c) =>
          c.author_agent_id === agentBySlug.get('openclaw-alpha').id &&
          (protocolOnly || Date.parse(c.created_at) >= r3StartedAt - 2000) &&
          (!protocolOnly || c.content.includes('X-REVIEW')),
      );
    }, 'reviewer posts the cross-round review comment', protocolOnly ? 120_000 : 480_000);
    // 顶层评审是回访意图的要求；真实模型偶发先串楼后评审时降级为 rubric 观测，不判死。
    const anchorCited = review.content.includes(anchor);
    const topLevelReview = review.parent_comment_id === null;
    if (protocolOnly) {
      assert.ok(topLevelReview, 'review must be a top-level in-thread comment');
      assert.ok(anchorCited, 'review cites the CR-ANCHOR token from the post content');
    }
    const revisitReceipts = (await getEvents('openclaw-alpha')).filter(
      (e) => e.event === 'tool_receipt' && e.turn === `intent:${runId}-x-revisit`,
    );
    const revisitTools = revisitReceipts.map((e) => e.tool);
    if (protocolOnly) {
      assert.deepEqual(
        revisitTools,
        ['agentmesh_home', 'agentmesh_read_forum_post', 'agentmesh_create_forum_comment'],
        'revisit recovers context via home and a full post read',
      );
    } else {
      for (const tool of ['agentmesh_home', 'agentmesh_read_forum_post', 'agentmesh_create_forum_comment']) {
        assert.ok(revisitTools.includes(tool), `revisit turn called ${tool} (got: ${revisitTools.join(', ')})`);
      }
    }
    const revisitRead = revisitReceipts.find((e) => e.tool === 'agentmesh_read_forum_post');
    const revisitComment = revisitReceipts.find((e) => e.tool === 'agentmesh_create_forum_comment');
    assert.equal(revisitRead.args.post_id, proposal.id);
    assert.equal(revisitComment.args.post_id, proposal.id);

    // R4: inbox wake-ups only — no forced rounds. In protocol mode the fixture script answers,
    // follows up and concludes (C2-C4, then both sides wake once more and stay silent); a real
    // model converges on its own, so real mode waits for the thread to go quiet instead of
    // counting comments.
    let thread;
    if (protocolOnly) {
      thread = await until(async () => {
        const res = await apiJson(`/api/v1/posts/${proposal.id}/comments?limit=50`);
        return (res.data?.comments?.length ?? 0) >= 4 ? res.data.comments : undefined;
      }, 'inbox wake-up chain converges to four comments', 180_000);
      const [c2, c3, c4] = thread.slice(1);
      assert.equal(c2.author_agent_id, agentBySlug.get('hermes-gamma').id);
      assert.equal(c2.parent_comment_id, review.id);
      assert.ok(c2.content.includes('X-ANSWER'));
      assert.deepEqual(c2.mention_agent_ids, [agentBySlug.get('openclaw-alpha').id], 'answer re-wakes the reviewer');
      assert.equal(c3.author_agent_id, agentBySlug.get('openclaw-alpha').id);
      assert.equal(c3.parent_comment_id, c2.id);
      assert.ok(c3.content.includes('X-FOLLOWUP'));
      assert.equal(c4.author_agent_id, agentBySlug.get('hermes-gamma').id);
      assert.equal(c4.parent_comment_id, c3.id);
      assert.ok(c4.content.includes('X-FINAL'));
      assert.deepEqual(c4.mention_agent_ids, [], 'final comment must not re-wake the reviewer');
    } else {
      // 每次评论都会唤醒对方（楼主或被回楼者），链靠模型主动收口结束：
      // 等「至少一条回应且静默 3 分钟」判稳，避免把一次慢响应误判为终止。
      let seen = 0;
      let since = Date.now();
      thread = await until(async () => {
        const res = await apiJson(`/api/v1/posts/${proposal.id}/comments?limit=50`);
        const comments = res.data?.comments ?? [];
        if (comments.length !== seen) {
          seen = comments.length;
          since = Date.now();
        }
        return seen >= 2 && Date.now() - since >= 180_000 ? comments : undefined;
      }, 'inbox wake-up chain settles', protocolOnly ? 180_000 : 1_500_000);
      // 真实模型不受夹具角色约束：同主题辩论会吸引其他 Agent 经关注流主动跟评，作者侧回应
      // 也可能由第三方代管（平台机制允许）。硬断言只锁机制：评审方发评、且存在被唤醒的
      // 非评审方在帖内回楼。
      assert.ok(
        thread.some((c) => c.author_agent_id === agentBySlug.get('openclaw-alpha').id),
        'the reviewer comments in-thread',
      );
      assert.ok(
        thread.some(
          (c) => c.parent_comment_id !== null && c.author_agent_id !== agentBySlug.get('openclaw-alpha').id,
        ),
        'a woken agent answers the review in-thread',
      );
    }
    // 唤醒轮的回执行在回合结束（CLI 退出）后才打到日志，而评论先在服务端可见；
    // 用 until 等回执落盘，再断言精确形状。
    const wakeAnswerReceipts = async (service, min) =>
      until(async () => {
        const events = await getEvents(service);
        const receipts = events.filter(
          (e) =>
            e.event === 'tool_receipt' &&
            e.turn.startsWith('inbox:') &&
            e.tool === 'agentmesh_create_forum_comment' &&
            e.args?.post_id === proposal.id,
        );
        if (receipts.length < min) return undefined;
        const shapes = receipts.map((receipt) =>
          JSON.stringify(
            events.filter((e) => e.event === 'tool_receipt' && e.turn === receipt.turn).map((e) => e.tool),
          ),
        );
        return { receipts, shapes };
      }, `${service} inbox answer receipts to settle`, 30_000);

    if (protocolOnly) {
      const gammaWake = await wakeAnswerReceipts('hermes-gamma', 2);
      assert.equal(gammaWake.receipts.length, 2, 'author answers twice via inbox wake-ups');
      for (const shape of gammaWake.shapes) {
        assert.equal(
          shape,
          JSON.stringify(['agentmesh_read_forum_post', 'agentmesh_create_forum_comment']),
          'each wake answer reads the thread first',
        );
      }
      const alphaWake = await wakeAnswerReceipts('openclaw-alpha', 1);
      assert.equal(alphaWake.receipts.length, 1, 'reviewer follows up once via inbox wake-up');
      assert.equal(
        alphaWake.shapes[0],
        JSON.stringify(['agentmesh_read_forum_post', 'agentmesh_create_forum_comment']),
        'the follow-up reads the thread first',
      );
    } else {
      // 回应者身份随模型组织方式漂移（楼主/评审方/第三方皆可），只要求存在由收件箱唤醒轮
      // 产生、落在提议帖内的评论回执。
      const wakeReceipts = await until(
        async () => {
          for (const service of ['openclaw-alpha', 'openclaw-beta', 'hermes-gamma', 'hermes-delta']) {
            try {
              return await wakeAnswerReceipts(service, 1);
            } catch {
              // 该守护进程没有帖内评论回执，继续看下一个。
            }
          }
          return undefined;
        },
        'an inbox wake turn answers in-thread',
        60_000,
      );
      assert.ok(wakeReceipts.receipts.length >= 1, 'an inbox wake turn answered via create_forum_comment');
    }

    if (protocolOnly) {
      await delay(8000);
      const settled = await apiJson(`/api/v1/posts/${proposal.id}`);
      assert.equal(
        settled.data.post.comment_count,
        thread.length,
        'wake chain must terminate without idle back-and-forth',
      );
    } else {
      // 真实模式下 3 分钟静默判稳即终止证据；窗口内有机第三方评论可能仍在落帖，不做等式断言。
      await delay(60_000);
    }

    const createdAt = (row) => Date.parse(row.created_at);
    const timeToFirstReplyMs = createdAt(review) - createdAt(proposalDetail.data.post);
    const revisitInTurnMs = createdAt(review) - r3StartedAt;
    const convergeMs = createdAt(thread[thread.length - 1]) - createdAt(proposalDetail.data.post);
    assert.ok(revisitInTurnMs <= 600_000, `first reply within 10 minutes of the revisit round (took ${revisitInTurnMs} ms)`);
    assert.ok(convergeMs <= 2_400_000, `thread converged within 40 minutes (took ${convergeMs} ms)`);
    // 回访上下文恢复 rubric：锚点引用需内容级判定，真实模型下记录观测值、留待人工复核（WP4）。
    const contextRecoveryRubric = {
      anchor_cited: anchorCited,
      top_level_review: topLevelReview,
      tool_chain: true,
    };
    assert.ok(
      Object.values(contextRecoveryRubric).filter(Boolean).length >= 2,
      'context recovery rubric passes at least 2 of 3',
    );
    console.log('PASS: cross-round proposal review converged via capability discovery, feed revisit, and inbox wake-ups.');
    console.log(
      JSON.stringify({
        event: 'cross_round_metrics',
        run: runId,
        proposal_post_id: proposal.id,
        time_to_first_reply_ms: timeToFirstReplyMs,
        revisit_in_turn_ms: revisitInTurnMs,
        converge_ms: convergeMs,
        comments: thread.length,
        context_recovery_rubric: contextRecoveryRubric,
      }),
    );

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

    console.log('PASS: 2 OpenClaw + 2 Hermes Agents completed IM, forum, cross-round review, restart, observer, privacy, and social discovery checks.');
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
