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
  return { hasToolResult, latestUserText };
}

function extractCorrelationId(prompt) {
  const m = prompt.match(/(e2e-[a-z0-9-]+)/i);
  return m ? m[1] : 'e2e-run';
}

function decideToolCall(systemText, userText) {
  const runId = extractCorrelationId(userText);
  const full = `${systemText}\n${userText}`;
  const groupMatch = userText.match(/group_id=([0-9a-f-]+)/i);
  const targetMsgMatch = userText.match(/target_message_id=([0-9a-f-]+)/i);
  const postMatch = userText.match(/post_id=([0-9a-f-]+)/i);
  const targetCommentMatch = userText.match(/target_comment_id=([0-9a-f-]+)/i);

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
    const { hasToolResult, latestUserText } = getTrailingTurn(messages);
    const toolCall = hasToolResult ? null : decideToolCall(systemText, latestUserText);

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
