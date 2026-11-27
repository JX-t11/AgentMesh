import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MODEL_FIXTURE_PORT ?? 18895);

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return JSON.stringify(part ?? '');
      })
      .join('\n');
  }
  return '';
}

function getTrailingTurn(messages) {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      start = i + 1;
      break;
    }
  }
  const trailing = messages.slice(start);
  const hasToolResult = trailing.some(
    (msg) =>
      msg?.role === 'tool' ||
      (msg?.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.some((b) => b && b.type === 'tool_result')),
  );
  const latestUserText = trailing
    .filter((msg) => msg?.role === 'user')
    .map((msg) => extractText(msg.content))
    .join('\n');
  const assistant = start > 0 ? messages[start - 1] : null;
  const toolBlock = Array.isArray(assistant?.content)
    ? assistant.content.find((b) => b?.type === 'tool_use')
    : null;
  const toolResultBlock = trailing
    .flatMap((msg) => (Array.isArray(msg?.content) ? msg.content : []))
    .find((b) => b?.type === 'tool_result');
  // 触发当前工具调用的回合提示：从工具调用往前找最近一条带回合标记的 user 消息，
  // 跳过运行时可能插入的无标记备注。
  let turnPromptText = '';
  for (let i = start - 2; i >= 0; i -= 1) {
    const text = messages[i]?.role === 'user' ? extractText(messages[i].content) : '';
    if (/(X_DISCOVER|X_REVISIT|X_PROPOSE|event_kind=[a-z_]+)/.test(text)) {
      turnPromptText = text;
      break;
    }
  }
  return {
    hasToolResult,
    latestUserText,
    toolUse: toolBlock ? { name: toolBlock.name, input: toolBlock.input ?? {} } : null,
    toolResultText: toolResultBlock ? extractText(toolResultBlock.content) : '',
    turnPromptText,
  };
}

function extractCorrelationId(prompt) {
  const m = prompt.match(/(e2e-[a-z0-9-]+)/i);
  return m ? m[1] : 'e2e-run';
}

// 跨轮评审场景（protocol E2E 的模型侧脚本，逐请求无状态）：意图标记 X_PROPOSE / X_DISCOVER /
// X_REVISIT 驱动三步工具链；收件箱唤醒轮按内容标记（X-REVIEW / X-ANSWER / X-FOLLOWUP）续写，
// X-FINAL 之后没有规则，唤醒-回应链自然终止。
function crossRoundStep(systemText, userText, ctx, matches) {
  const { toolUse, toolResultText, turnPromptText, conversationText } = ctx;
  const runId = extractCorrelationId(conversationText || userText);
  const parseResult = () => {
    try {
      return JSON.parse(toolResultText);
    } catch {
      return null;
    }
  };

  if (ctx.hasToolResult) {
    if (toolUse?.name === 'agentmesh_find_agents' && turnPromptText.includes('X_DISCOVER')) {
      const slug = parseResult()?.agents?.[0]?.slug;
      return slug ? { name: 'agentmesh_follow_agent', input: { target_agent: slug, following: true } } : null;
    }
    if (toolUse?.name === 'agentmesh_home' && turnPromptText.includes('X_REVISIT')) {
      const proposal = (parseResult()?.feed?.posts ?? []).find(
        (p) => String(p?.title ?? '').includes('X-PROPOSAL') && String(p?.title ?? '').includes(runId),
      );
      return proposal ? { name: 'agentmesh_read_forum_post', input: { post_id: proposal.id } } : null;
    }
    if (toolUse?.name === 'agentmesh_read_forum_post') {
      const anchor = String(parseResult()?.post?.content ?? '').match(/CR-ANCHOR-[A-Za-z0-9]+/)?.[0];
      const parent = turnPromptText.match(/target_comment_id=([0-9a-f-]+)/i)?.[1];
      const fullTurn = `${systemText}\n${turnPromptText}`;
      if (fullTurn.includes('[ROLE:openclaw-alpha]') && turnPromptText.includes('X_REVISIT')) {
        return {
          name: 'agentmesh_create_forum_comment',
          input: {
            post_id: toolUse.input?.post_id,
            content: `[${runId}] X-REVIEW：结论先行——采纳评论约定路线，取舍锚点 ${anchor} 的可逆性论证成立；未核：账本未实际运行。`,
            client_req_id: `${runId}-x-review-1`,
          },
        };
      }
      if (fullTurn.includes('[ROLE:hermes-gamma]') && turnPromptText.includes('X-REVIEW') && parent) {
        return {
          name: 'agentmesh_create_forum_comment',
          input: {
            post_id: toolUse.input?.post_id,
            parent_comment_id: parent,
            content: `[${runId}] X-ANSWER：认账并补一条硬约束——状态键须带轮次序号，回访先对账再表态。`,
            client_req_id: `${runId}-x-answer-1`,
            mentions: ['openclaw-alpha'],
          },
        };
      }
      if (fullTurn.includes('[ROLE:openclaw-alpha]') && turnPromptText.includes('X-ANSWER') && parent) {
        return {
          name: 'agentmesh_create_forum_comment',
          input: {
            post_id: toolUse.input?.post_id,
            parent_comment_id: parent,
            content: `[${runId}] X-FOLLOWUP：补充一条硬约束——状态键须带轮次序号，回访先对账再表态。`,
            client_req_id: `${runId}-x-followup-1`,
          },
        };
      }
      if (fullTurn.includes('[ROLE:hermes-gamma]') && turnPromptText.includes('X-FOLLOWUP') && parent) {
        return {
          name: 'agentmesh_create_forum_comment',
          input: {
            post_id: toolUse.input?.post_id,
            parent_comment_id: parent,
            content: `[${runId}] X-FINAL：定稿——采纳评论约定（A），硬约束入账；待决：编辑能力与漂移判定。对账时见。`,
            client_req_id: `${runId}-x-final-1`,
          },
        };
      }
    }
    return null;
  }

  const full = `${systemText}\n${userText}`;
  const { postMatch, targetCommentMatch } = matches;
  if (full.includes('[ROLE:hermes-gamma]') && userText.includes('X_PROPOSE')) {
    const anchor = `CR-ANCHOR-${randomUUID().slice(0, 6)}`;
    return {
      name: 'agentmesh_create_forum_post',
      input: {
        board: 'engineering-rfcs',
        title: `[${runId}] X-PROPOSAL: 跨轮评审的状态账本`,
        content: `[${runId}] 背景：发起方与评审方不共享运行时上下文。\n备选：A 评论约定为主；B 平台级任务对象。\n取舍锚点：${anchor}（采纳 A：可逆性不对称，B 难撤销）。\n待决：编辑能力与格式漂移判定。`,
        client_req_id: `${runId}-x-propose-1`,
      },
    };
  }
  if (
    full.includes('[ROLE:hermes-gamma]') &&
    (userText.includes('event_kind=post_reply') || userText.includes('event_kind=comment_reply')) &&
    (userText.includes('X-REVIEW') || userText.includes('X-FOLLOWUP')) &&
    postMatch &&
    targetCommentMatch
  ) {
    return { name: 'agentmesh_read_forum_post', input: { post_id: postMatch[1] } };
  }
  if (full.includes('[ROLE:openclaw-alpha]') && userText.includes('X_DISCOVER')) {
    const capability = userText.match(/capability=([a-z][a-z-]*)/i)?.[1];
    return capability ? { name: 'agentmesh_find_agents', input: { capability, limit: 1 } } : null;
  }
  if (full.includes('[ROLE:openclaw-alpha]') && userText.includes('X_REVISIT')) {
    return { name: 'agentmesh_home', input: {} };
  }
  if (
    full.includes('[ROLE:openclaw-alpha]') &&
    userText.includes('event_kind=comment_mention') &&
    userText.includes('X-ANSWER') &&
    postMatch &&
    targetCommentMatch
  ) {
    return { name: 'agentmesh_read_forum_post', input: { post_id: postMatch[1] } };
  }
  return null;
}

function decideToolCall(systemText, userText, ctx = {}) {
  const runId = extractCorrelationId(userText);
  const full = `${systemText}\n${userText}`;
  const groupMatch = userText.match(/group_id=([0-9a-f-]+)/i);
  const targetMsgMatch = userText.match(/target_message_id=([0-9a-f-]+)/i);
  const postMatch = userText.match(/post_id=([0-9a-f-]+)/i);
  const targetCommentMatch = userText.match(/target_comment_id=([0-9a-f-]+)/i);
  const runtimeProbeMatch = userText.match(/TOOL_RUNTIME_PROBE\s+([a-z_]+)/);

  if (runtimeProbeMatch) {
    const probes = {
      find_agents: { name: 'agentmesh_find_agents', input: { limit: 1 } },
      search_posts: { name: 'agentmesh_search_posts', input: { q: 'probe', limit: 1 } },
      feed: { name: 'agentmesh_feed', input: { limit: 1 } },
      home: { name: 'agentmesh_home', input: {} },
    };
    const probe = probes[runtimeProbeMatch[1]];
    if (probe) return probe;
  }

  const crossRound = crossRoundStep(systemText, userText, ctx, { postMatch, targetCommentMatch });
  if (crossRound) return crossRound;

  if (ctx.hasToolResult) return null;

  if (full.includes('[ROLE:openclaw-alpha]')) {
    if (userText.includes('INITIATE_IM')) {
      return {
        name: 'agentmesh_send_group_message',
        input: {
          group: 'mesh-general',
          content: `[${runId}] @hermes-gamma Please inspect workspace latency and coordinate with @openclaw-beta.`,
          client_msg_id: `${runId}-alpha-im-1`,
          mentions: ['hermes-gamma'],
        },
      };
    }
    if (userText.includes('event_kind=post_mention') && postMatch) {
      return {
        name: 'agentmesh_create_forum_comment',
        input: {
          post_id: postMatch[1],
          content: `[${runId}] Reviewed by OpenClaw Alpha. Tagging @hermes-delta for verification.`,
          client_req_id: `${runId}-alpha-comment-1`,
          mentions: ['hermes-delta'],
        },
      };
    }
  }

  if (full.includes('[ROLE:hermes-gamma]')) {
    if (userText.includes('event_kind=group_mention') && targetMsgMatch && groupMatch) {
      return {
        name: 'agentmesh_send_group_message',
        input: {
          group: groupMatch[1],
          content: `[${runId}] Hermes Gamma checked PG CTE seq throughput; looping in @openclaw-beta for cache check.`,
          client_msg_id: `${runId}-gamma-im-2`,
          reply_to_msg_id: targetMsgMatch[1],
          mentions: ['openclaw-beta'],
        },
      };
    }
    if (userText.includes('INITIATE_FORUM')) {
      return {
        name: 'agentmesh_create_forum_post',
        input: {
          board: 'engineering-rfcs',
          title: `[${runId}] RFC: Cross-Agent Cursor Recovery`,
          content: `[${runId}] Proposing standardized inbox_seq watermarks. Requesting review from @openclaw-alpha.`,
          client_req_id: `${runId}-gamma-post-1`,
          mentions: ['openclaw-alpha'],
        },
      };
    }
  }

  if (full.includes('[ROLE:openclaw-beta]')) {
    if (userText.includes('event_kind=group_mention') && targetMsgMatch && groupMatch) {
      return {
        name: 'agentmesh_send_group_message',
        input: {
          group: groupMatch[1],
          content: `[${runId}] OpenClaw Beta confirmed DashMap auth cache hit rate; handing off to @hermes-delta for final sign-off.`,
          client_msg_id: `${runId}-beta-im-3`,
          reply_to_msg_id: targetMsgMatch[1],
          mentions: ['hermes-delta'],
        },
      };
    }
    if (userText.includes('event_kind=comment_mention') && postMatch && targetCommentMatch) {
      return {
        name: 'agentmesh_create_forum_comment',
        input: {
          post_id: postMatch[1],
          parent_comment_id: targetCommentMatch[1],
          content: `[${runId}] OpenClaw Beta concurs with threaded reply verification.`,
          client_req_id: `${runId}-beta-comment-3`,
        },
      };
    }
  }

  if (full.includes('[ROLE:hermes-delta]')) {
    if (userText.includes('event_kind=group_mention') && targetMsgMatch && groupMatch) {
      return {
        name: 'agentmesh_send_group_message',
        input: {
          group: groupMatch[1],
          content: `[${runId}] Hermes Delta verified end-to-end IM flow across all 4 agents.`,
          client_msg_id: `${runId}-delta-im-4`,
          reply_to_msg_id: targetMsgMatch[1],
        },
      };
    }
    if (userText.includes('event_kind=comment_mention') && postMatch && targetCommentMatch) {
      return {
        name: 'agentmesh_create_forum_comment',
        input: {
          post_id: postMatch[1],
          parent_comment_id: targetCommentMatch[1],
          content: `[${runId}] Hermes Delta verified RFC comments; asking @openclaw-beta to sign off.`,
          client_req_id: `${runId}-delta-comment-2`,
          mentions: ['openclaw-beta'],
        },
      };
    }
  }

  return null;
}

function writeAnthropicSse(res, model, toolCall) {
  const msgId = `msg_${randomUUID().slice(0, 8)}`;
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, output_tokens: 0 },
        },
      },
    ],
  ];

  if (toolCall) {
    const toolId = `toolu_${randomUUID().slice(0, 8)}`;
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolId, name: toolCall.name, input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.input) },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 45 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    );
  } else {
    events.push(
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Acknowledged.' } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 12 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    );
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => {
    raw += c.toString();
  });
  req.on('end', () => {
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const body = raw ? JSON.parse(raw) : {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemText =
      extractText(body.system ?? '') +
      '\n' +
      messages
        .filter((m) => m.role === 'system')
        .map((m) => extractText(m.content))
        .join('\n');
    const trailingTurn = getTrailingTurn(messages);
    const { hasToolResult, latestUserText } = trailingTurn;
    const exposureMatch = latestUserText.match(/TOOL_EXPOSURE_PROBE\s+(\S+)/);
    if (exposureMatch) {
      console.log(
        JSON.stringify({
          event: 'tool_exposure',
          probe: exposureMatch[1],
          tools: Array.isArray(body.tools)
            ? body.tools.map((tool) => tool?.name).filter(Boolean)
            : [],
        }),
      );
    }
    const conversationText = `${systemText}\n${messages.map((m) => extractText(m.content)).join('\n')}`;
    const toolCall = decideToolCall(systemText, latestUserText, { ...trailingTurn, conversationText });
    console.log(
      JSON.stringify({
        event: 'fixture_turn',
        run: extractCorrelationId(conversationText),
        tool_use: trailingTurn.toolUse?.name ?? null,
        decided: toolCall?.name ?? null,
      }),
    );

    if (req.url?.endsWith('/messages')) {
      const model = body.model ?? 'glm-5.3-flash';
      if (body.stream === true) {
        writeAnthropicSse(res, model, toolCall);
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      const msgId = `msg_${randomUUID().slice(0, 8)}`;
      if (toolCall) {
        res.end(
          JSON.stringify({
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: `toolu_${randomUUID().slice(0, 8)}`,
                name: toolCall.name,
                input: toolCall.input,
              },
            ],
            usage: { input_tokens: 120, output_tokens: 45 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: msgId,
          type: 'message',
          role: 'assistant',
          model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Acknowledged.' }],
          usage: { input_tokens: 80, output_tokens: 12 },
        }),
      );
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      if (toolCall) {
        res.end(
          JSON.stringify({
            id: `chatcmpl-${randomUUID().slice(0, 8)}`,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `call_${randomUUID().slice(0, 8)}`,
                      type: 'function',
                      function: {
                        name: toolCall.name,
                        arguments: JSON.stringify(toolCall.input),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: `chatcmpl-${randomUUID().slice(0, 8)}`,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Acknowledged.' },
            },
          ],
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: `unsupported path ${req.url}` }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'model_fixture_ready', port: PORT }));
});
