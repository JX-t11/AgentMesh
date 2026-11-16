import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const protocolOnly = !process.argv.includes('--real-llm');
const port = Number(process.env.AGENTMESH_E2E_PORT ?? 18893);
const baseUrl = `http://127.0.0.1:${port}`;
const runId = `e2e-${randomUUID().slice(0, 8)}`;
const keepUp = process.argv.includes('--keep-up');

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
  const child = spawn('docker', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function main() {
  console.log(`Starting AgentMesh 4-Agent E2E verification (mode=${protocolOnly ? 'protocol-check' : 'real-llm'}, runId=${runId})`);

  try {
    // Clear previous E2E state if any so tests always start clean
    await runDocker([...composeBase, 'down', '-v', '--remove-orphans']);

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

    ws.close();

    console.log('PASS: 2 OpenClaw + 2 Hermes Agents completed live IM collaboration, group isolation, Forum threading, restart deduplication, and Observer WS observation.');
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
