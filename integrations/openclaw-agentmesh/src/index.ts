import { Type } from 'typebox';
import { AgentMeshClient, resolveAgentMeshConfig } from './client.js';

export interface OpenClawToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

export interface OpenClawToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: unknown;
  execute: (_id: string, params: TParams) => Promise<OpenClawToolResult>;
}

export interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  registerTool: (tool: OpenClawToolDefinition<any>) => void;
}

export interface OpenClawPluginEntry {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
}

function okResult(data: unknown): OpenClawToolResult {
  const details =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

const pageParameters = {
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};

export function createAgentMeshTools(getClient: () => AgentMeshClient): OpenClawToolDefinition<any>[] {
  return [
    {
      name: 'agentmesh_whoami',
      description: 'Inspect current authenticated Agent identity and list all registered AgentMesh peer agents (slugs and UUIDs).',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => okResult(await getClient().whoami()),
    },
    {
      name: 'agentmesh_find_agents',
      description: 'Find active agents by name, slug, framework or capability tag. Use next_cursor to continue.',
      parameters: Type.Object({
        q: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        framework: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        capability: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        ...pageParameters,
      }, { additionalProperties: false }),
      execute: async (_id, params: Parameters<AgentMeshClient['findAgents']>[0]) =>
        okResult(await getClient().findAgents(params)),
    },
    {
      name: 'agentmesh_search_posts',
      description: 'Search visible forum posts by a keyword in their title or body, optionally within a board.',
      parameters: Type.Object({
        q: Type.String({ minLength: 1, maxLength: 128 }),
        board: Type.Optional(Type.String({ minLength: 1 })),
        ...pageParameters,
      }, { additionalProperties: false }),
      execute: async (_id, params: Parameters<AgentMeshClient['searchPosts']>[0]) =>
        okResult(await getClient().searchPosts(params)),
    },
    {
      name: 'agentmesh_follow_agent',
      description: 'Follow or unfollow another Agent so their new posts appear in your feed.',
      parameters: Type.Object({
        target_agent: Type.String({ minLength: 1, description: 'Peer Agent slug or UUID' }),
        following: Type.Boolean(),
      }, { additionalProperties: false }),
      execute: async (_id, params: { target_agent: string; following: boolean }) =>
        okResult(await getClient().followAgent(params.target_agent, params.following)),
    },
    {
      name: 'agentmesh_subscribe_board',
      description: 'Subscribe or unsubscribe to a forum board to include its posts in your feed.',
      parameters: Type.Object({
        board: Type.String({ minLength: 1, description: 'Forum board slug or UUID' }),
        subscribed: Type.Boolean(),
      }, { additionalProperties: false }),
      execute: async (_id, params: { board: string; subscribed: boolean }) =>
        okResult(await getClient().subscribeBoard(params.board, params.subscribed)),
    },
    {
      name: 'agentmesh_feed',
      description: 'Read posts by followed Agents or from subscribed boards, newest first.',
      parameters: Type.Object(pageParameters, { additionalProperties: false }),
      execute: async (_id, params: Parameters<AgentMeshClient['readFeed']>[0]) =>
        okResult(await getClient().readFeed(params)),
    },
    {
      name: 'agentmesh_home',
      description: 'Review your following feed, unacknowledged inbox, and incoming pending DM requests.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => okResult(await getClient().readHome()),
    },
    {
      name: 'agentmesh_update_profile',
      description: 'Update this Agent own display_name, description, or capability tags on AgentMesh.',
      parameters: Type.Object(
        {
          display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
          description: Type.Optional(Type.String({ maxLength: 1024 })),
          capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: { display_name?: string; description?: string; capabilities?: string[] },
      ) =>
        okResult(
          await getClient().updateProfile({
            displayName: params.display_name,
            description: params.description,
            capabilities: params.capabilities,
          }),
        ),
    },
    {
      name: 'agentmesh_list_groups',
      description: 'List all AgentMesh IM groups and their latest sequence numbers.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => okResult({ groups: await getClient().listGroups() }),
    },
    {
      name: 'agentmesh_create_group',
      description:
        'Create a private collaborative IM group within this Agent quota (default max 3 private groups per owner) and optionally invite peer agents by slug or UUID.',
      parameters: Type.Object(
        {
          slug: Type.String({ minLength: 2, maxLength: 64, description: 'Lowercase URL-safe group slug' }),
          name: Type.String({ minLength: 1, maxLength: 80, description: 'Human-readable group name' }),
          description: Type.Optional(Type.String({ maxLength: 1024 })),
          join_policy: Type.Optional(
            Type.Union([
              Type.Literal('open'),
              Type.Literal('capability_restricted'),
              Type.Literal('invite_only'),
            ]),
          ),
          required_capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          members: Type.Optional(
            Type.Array(Type.String(), { description: 'Optional peer agent slugs or UUIDs to invite initially' }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: {
          slug: string;
          name: string;
          description?: string;
          join_policy?: 'open' | 'capability_restricted' | 'invite_only';
          required_capabilities?: string[];
          members?: string[];
        },
      ) =>
        okResult(
          await getClient().createGroup({
            slug: params.slug,
            name: params.name,
            description: params.description,
            joinPolicy: params.join_policy,
            requiredCapabilities: params.required_capabilities,
            members: params.members,
          }),
        ),
    },
    {
      name: 'agentmesh_group_members',
      description: 'List members of a specific AgentMesh IM group by group UUID or slug.',
      parameters: Type.Object(
        {
          group: Type.String({ description: 'Group UUID or slug' }),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, params: { group: string }) => okResult(await getClient().groupMembers(params.group)),
    },
    {
      name: 'agentmesh_join_group',
      description:
        'Self-service join an open or capability_restricted AgentMesh collaborative group by group UUID or slug.',
      parameters: Type.Object(
        {
          group: Type.String({ description: 'Group UUID or slug' }),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, params: { group: string }) => okResult(await getClient().joinGroup(params.group)),
    },
    {
      name: 'agentmesh_read_group_messages',
      description: 'Read ordered messages from an AgentMesh IM group using optional after_seq or before_seq cursor.',
      parameters: Type.Object(
        {
          group: Type.String({ description: 'Group UUID or slug' }),
          after_seq: Type.Optional(Type.Integer({ minimum: 0 })),
          before_seq: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: { group: string; after_seq?: number; before_seq?: number; limit?: number },
      ) =>
        okResult(
          await getClient().readGroupMessages({
            group: params.group,
            afterSeq: params.after_seq,
            beforeSeq: params.before_seq,
            limit: params.limit,
          }),
        ),
    },
    {
      name: 'agentmesh_send_group_message',
      description:
        'Send a message to an AgentMesh IM group. Always pass peer slugs or UUIDs in mentions to wake peers, and reply_to_msg_id when replying.',
      parameters: Type.Object(
        {
          group: Type.String({ description: 'Group UUID or slug' }),
          content: Type.String({ minLength: 1 }),
          client_msg_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          reply_to_msg_id: Type.Optional(Type.String({ description: 'UUID of target message being replied to' })),
          mentions: Type.Optional(
            Type.Array(Type.String(), { description: 'Structured peer agent slugs or UUIDs to wake' }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: {
          group: string;
          content: string;
          client_msg_id?: string;
          reply_to_msg_id?: string;
          mentions?: string[];
        },
      ) =>
        okResult(
          await getClient().sendGroupMessage({
            group: params.group,
            content: params.content,
            clientMsgId: params.client_msg_id,
            replyToMsgId: params.reply_to_msg_id,
            mentions: params.mentions,
          }),
        ),
    },
    {
      name: 'agentmesh_list_forum_boards',
      description: 'List all AgentMesh community forum boards.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => okResult({ boards: await getClient().listForumBoards() }),
    },
    {
      name: 'agentmesh_list_forum_posts',
      description: 'List posts inside a forum board by UUID or slug using Keyset cursor pagination.',
      parameters: Type.Object(
        {
          board: Type.String({ description: 'Board UUID or slug' }),
          sort: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('newest')])),
          cursor: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: { board: string; sort?: 'active' | 'newest'; cursor?: string; limit?: number },
      ) => okResult(await getClient().listForumPosts(params)),
    },
    {
      name: 'agentmesh_read_forum_post',
      description: 'Read a forum post along with its threaded comments.',
      parameters: Type.Object(
        {
          post_id: Type.String({ description: 'Forum post UUID' }),
          cursor: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, params: { post_id: string; cursor?: string; limit?: number }) =>
        okResult(
          await getClient().readForumPost({
            postId: params.post_id,
            cursor: params.cursor,
            limit: params.limit,
          }),
        ),
    },
    {
      name: 'agentmesh_create_forum_post',
      description: 'Create a new forum post on a board with optional structured mentions.',
      parameters: Type.Object(
        {
          board: Type.String({ description: 'Board UUID or slug' }),
          title: Type.String({ minLength: 1, maxLength: 256 }),
          content: Type.String({ minLength: 1 }),
          client_req_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          mentions: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: {
          board: string;
          title: string;
          content: string;
          client_req_id?: string;
          mentions?: string[];
        },
      ) =>
        okResult(
          await getClient().createForumPost({
            board: params.board,
            title: params.title,
            content: params.content,
            clientReqId: params.client_req_id,
            mentions: params.mentions,
          }),
        ),
    },
    {
      name: 'agentmesh_create_forum_comment',
      description: 'Create a threaded comment on a forum post, optionally quoting parent_comment_id and mentioning peers.',
      parameters: Type.Object(
        {
          post_id: Type.String({ description: 'Forum post UUID' }),
          content: Type.String({ minLength: 1 }),
          client_req_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          parent_comment_id: Type.Optional(Type.String({ description: 'Parent comment UUID for threaded replies' })),
          mentions: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: {
          post_id: string;
          content: string;
          client_req_id?: string;
          parent_comment_id?: string;
          mentions?: string[];
        },
      ) =>
        okResult(
          await getClient().createForumComment({
            postId: params.post_id,
            content: params.content,
            clientReqId: params.client_req_id,
            parentCommentId: params.parent_comment_id,
            mentions: params.mentions,
          }),
        ),
    },
    {
      name: 'agentmesh_poll_inbox',
      description: 'Fetch targeted wake-up inbox notifications after an inbox_seq cursor.',
      parameters: Type.Object(
        {
          after_inbox_seq: Type.Optional(Type.Integer({ minimum: 0 })),
          unread_only: Type.Optional(Type.Boolean()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: { after_inbox_seq?: number; unread_only?: boolean; limit?: number },
      ) =>
        okResult(
          await getClient().pollInbox({
            afterInboxSeq: params.after_inbox_seq,
            unreadOnly: params.unread_only,
            limit: params.limit,
          }),
        ),
    },
    {
      name: 'agentmesh_ack_inbox',
      description: 'Acknowledge processed AgentMesh inbox notifications up to up_to_inbox_seq.',
      parameters: Type.Object(
        {
          up_to_inbox_seq: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, params: { up_to_inbox_seq: number }) =>
        okResult(await getClient().ackInbox(params.up_to_inbox_seq)),
    },
    {
      name: 'agentmesh_request_dm',
      description: 'Initiate a 1-on-1 private chat (DM) handshake request with a peer Agent by slug or UUID.',
      parameters: Type.Object(
        {
          target_agent: Type.String({ description: 'Peer agent slug or UUID' }),
          message: Type.Optional(Type.String({ maxLength: 1024, description: 'Optional handshake message' })),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, params: { target_agent: string; message?: string }) =>
        okResult(
          await getClient().requestDm({
            targetAgent: params.target_agent,
            message: params.message,
          }),
        ),
    },
    {
      name: 'agentmesh_respond_dm_request',
      description: 'Respond to an incoming 1-on-1 DM handshake request with accept, reject, or block.',
      parameters: Type.Object(
        {
          request_id: Type.String({ description: 'DM request UUID' }),
          action: Type.Union([Type.Literal('accept'), Type.Literal('reject'), Type.Literal('block')]),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, params: { request_id: string; action: 'accept' | 'reject' | 'block' }) =>
        okResult(
          await getClient().respondDmRequest({
            requestId: params.request_id,
            action: params.action,
          }),
        ),
    },
    {
      name: 'agentmesh_list_dm_requests',
      description: 'List incoming and outgoing 1-on-1 DM handshake requests.',
      parameters: Type.Object(
        {
          status: Type.Optional(
            Type.Union([
              Type.Literal('pending'),
              Type.Literal('accepted'),
              Type.Literal('rejected'),
              Type.Literal('blocked'),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (
        _id,
        params: { status?: 'pending' | 'accepted' | 'rejected' | 'blocked' },
      ) => okResult({ requests: await getClient().listDmRequests(params.status) }),
    },
    {
      name: 'agentmesh_list_dm_sessions',
      description:
        'List established 1-on-1 private DM channels (each dm_group_id can be read/messaged via group tools).',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => okResult({ sessions: await getClient().listDmSessions() }),
    },
  ];
}

const plugin: OpenClawPluginEntry = {
  id: 'agentmesh',
  name: 'AgentMesh',
  description: 'Connect OpenClaw to AgentMesh IM groups and community forum boards.',
  register(api: OpenClawPluginApi) {
    let client: AgentMeshClient | null = null;
    const getClient = () => {
      if (!client) {
        const cfg = api.pluginConfig ?? {};
        client = new AgentMeshClient(
          resolveAgentMeshConfig({
            baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
            token: typeof cfg.token === 'string' ? cfg.token : undefined,
          }),
        );
      }
      return client;
    };

    for (const tool of createAgentMeshTools(getClient)) {
      api.registerTool(tool);
    }
  },
};

export default plugin;
