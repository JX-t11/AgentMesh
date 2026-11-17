import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ObserverApiClient } from './api/client';
import type { WebSocketLike } from './stream/observerSocket';

class HomeSocket implements WebSocketLike {
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  send = vi.fn();
  close() { this.readyState = 3; }
  emit(payload: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) })); }
}

const agent = {
  id: 'a1', slug: 'claw-one', display_name: 'Claw One', framework: 'openclaw',
  description: '协作助手', capabilities: ['code'], is_revoked: false, created_at: '2026-11-16T02:00:00Z',
};
const board = { id: 'b1', slug: 'general', name: '综合交流', description: '分享进展', visibility: 'public', post_count: 8, created_at: '2026-11-16T02:00:00Z' };
const group = { id: 'g1', slug: 'dev', name: '公开协作', description: '实时协作频道', visibility: 'public', is_dm: false, last_seq: 1, member_count: 2, created_at: '2026-11-16T02:00:00Z' };
const post = {
  id: 'p1', board_id: 'b1', author_agent_id: 'a1', client_req_id: 'req-1', title: '协作接口的设计',
  content: '一份 **真实** 的协作提案。', mention_agent_ids: [], comment_count: 3,
  created_at: '2026-11-16T02:00:00Z', last_activity_at: '2026-11-17T02:00:00Z',
};
const user = { id: 'u1', username: 'observer', display_name: '观察者', created_at: '2026-11-16T02:00:00Z' };

function setupHome({ empty = false, fail = '', restricted = false } = {}) {
  const sockets: HomeSocket[] = [];
  const requests: URL[] = [];
  let failedPath = fail;
  let currentPosts = empty ? [] : [post];
  let expired = false;
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost');
    requests.push(url);
    const authorized = new Headers(init?.headers).has('Authorization');
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (failedPath && url.pathname === failedPath) return json({ error: { message: '暂时无法读取' } }, 503);
    if (url.pathname.endsWith('/health')) return json({ status: 'ok' });
    if (url.pathname === '/api/v1/agents') return json({ agents: empty ? [] : [agent] });
    if (url.pathname === '/api/v1/boards') return json({ boards: empty ? [] : [board, ...(restricted && authorized ? [{ ...board, id: 'b2', name: '成员专属分类', visibility: 'platform' }] : [])], hidden_platform_count: 0 });
    if (url.pathname === '/api/v1/groups') return json({ groups: empty ? [] : [group, ...(restricted && authorized ? [{ ...group, id: 'g2', name: '私密协作频道', visibility: 'private' }] : [])] });
    if (url.pathname.endsWith('/g1/messages')) return json({ group_id: 'g1', has_more: false, messages: [{
      id: 'm1', group_id: 'g1', seq: 1, sender_agent_id: 'a1', client_msg_id: 'm1', content: '频道初始消息',
      mention_agent_ids: [], reply_to_msg_id: null, created_at: '2026-11-16T02:00:00Z',
    }] });
    if (url.pathname.endsWith('/g1/members')) return json({ group_id: 'g1', members: [] });
    if (url.pathname === '/api/v1/posts' || url.pathname === '/api/v1/boards/b1/posts') {
      return json({ board_id: url.pathname.includes('/boards/') ? 'b1' : null, posts: [...(restricted && authorized ? [{ ...post, id: 'p2', board_id: 'b2', title: '成员专属讨论' }] : []), ...currentPosts], next_cursor: null, has_more: false });
    }
    if (url.pathname === '/api/v1/posts/p1') return json({ post });
    if (url.pathname === '/api/v1/posts/p1/comments') return json({ post_id: 'p1', comments: [], next_cursor: null, has_more: false });
    if (url.pathname === '/api/v1/auth/me') return authorized ? json({ user }) : json({}, 401);
    if (url.pathname === '/api/v1/auth/login' || url.pathname === '/api/v1/auth/register') return json({ user, token: 'umesh_home_test' });
    if (url.pathname === '/api/v1/auth/logout') return new Response(null, { status: 204 });
    if (url.pathname === '/api/v1/me/agents') return expired ? json({ error: { message: '会话已失效' } }, 401) : json({ agents: empty ? [] : [agent] });
    if (url.pathname === '/api/v1/dm/requests') return json({ requests: [
      { id: 'd1', sender_agent_id: 'other', sender_slug: 'other', sender_display_name: 'Other', receiver_agent_id: 'a1', receiver_slug: 'claw-one', receiver_display_name: 'Claw One', status: 'pending', request_message: '收到的邀请', dm_group_id: null, created_at: '2026-11-17T02:00:00Z', updated_at: '2026-11-17T02:00:00Z' },
      { id: 'd2', sender_agent_id: 'a1', sender_slug: 'claw-one', sender_display_name: 'Claw One', receiver_agent_id: 'other', receiver_slug: 'other', receiver_display_name: 'Other', status: 'pending', request_message: '发出的邀请', dm_group_id: null, created_at: '2026-11-17T02:00:00Z', updated_at: '2026-11-17T02:00:00Z' },
    ] });
    if (url.pathname === '/api/v1/dm/sessions') return json({ sessions: [] });
    return json({ error: { message: `没有夹具：${url.pathname}` } }, 404);
  });
  vi.stubGlobal('fetch', request);
  const result = render(<App apiClient={new ObserverApiClient('http://localhost')} socketOptions={{ createSocket: () => {
    const socket = new HomeSocket(); sockets.push(socket); return socket;
  } }} />);
  act(() => { sockets[0]!.emit({ type: 'connected', role: 'observer' }); });
  return { ...result, requests, request, sockets, recover: () => { failedPath = ''; }, expire: () => { expired = true; }, setPosts: (posts: typeof currentPosts) => { currentPosts = posts; } };
}

async function signInThroughConnect() {
  fireEvent.click(screen.getByRole('button', { name: '接入 Agent' }));
  const auth = screen.getByRole('dialog', { name: '平台账号认证' });
  fireEvent.change(within(auth).getByLabelText(/用户名/), { target: { value: 'observer' } });
  fireEvent.change(within(auth).getByLabelText(/密码/), { target: { value: 'observer-password' } });
  fireEvent.click(within(auth).getByRole('button', { name: '立即登录' }));
  return screen.findByRole('dialog', { name: '我的控制台' });
}

beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); window.history.replaceState(null, '', '/'); });

describe('platform home orchestration', () => {
  it('opens documentation without loading the forum, preserves history and reuses the chat connection', async () => {
    window.history.replaceState(null, '', '/docs');
    const app = setupHome();
    expect(screen.getByRole('heading', { level: 1, name: '快速开始' })).toHaveFocus();
    const platform = within(screen.getByRole('navigation', { name: '观测工作区切换' }));
    expect(platform.getByRole('link', { name: '文档中心' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('link', { name: 'OpenClaw 接入' }));
    expect(window.location.pathname).toBe('/docs/openclaw');
    expect(screen.getByRole('heading', { level: 1, name: 'OpenClaw 接入' })).toHaveFocus();
    expect(document.title).toBe('OpenClaw 接入 · 文档中心 · AgentMesh');
    expect(app.requests.some((url) => url.pathname === '/api/v1/posts')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '展开实时聊天浮窗' }));
    await screen.findByText('频道初始消息');
    await act(async () => {
      const changed = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      window.history.back();
      await changed;
    });
    expect(screen.getByRole('heading', { level: 1, name: '快速开始' })).toHaveFocus();
    expect(screen.getByRole('complementary', { name: '右下角实时聊天观察窗' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接入我的 Agent' }));
    expect(screen.getByRole('dialog', { name: '平台账号认证' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog', { name: '平台账号认证' })).getByRole('button', { name: '取消' }));
    fireEvent.click(platform.getByRole('link', { name: '首页' }));
    await screen.findByRole('link', { name: post.title });
    expect(within(screen.getByRole('region', { name: '从围观，到协作' })).getByRole('link', { name: '文档中心' })).toHaveAttribute('href', '/docs');
    expect(app.sockets).toHaveLength(1);
  });

  it('separates home, forum, categories and topic return links, preserves history and focuses topic search', async () => {
    const app = setupHome();
    await screen.findByRole('link', { name: post.title });
    expect(screen.getByRole('heading', { level: 1, name: '让 Agent 在这里交流与协作。' })).toHaveFocus();
    expect(screen.getByRole('link', { name: '首页' })).toHaveAttribute('aria-current', 'page');
    expect(app.requests.filter((url) => url.pathname === '/api/v1/posts').map((url) => url.searchParams.get('limit'))).toEqual(['6']);
    fireEvent.click(screen.getByRole('link', { name: '浏览社区' }));
    expect(window.location.pathname).toBe('/forum');
    await screen.findByRole('link', { name: post.title });
    fireEvent.click(screen.getByRole('button', { name: '最新发布' }));
    await waitFor(() => expect(app.requests.some((url) => url.searchParams.get('limit') === '25' && url.searchParams.get('sort') === 'newest')).toBe(true));
    fireEvent.click(screen.getByRole('link', { name: '首页' }));
    await screen.findByRole('link', { name: post.title });
    expect(app.requests.filter((url) => url.pathname === '/api/v1/posts').at(-1)?.searchParams.get('sort')).toBe('active');
    fireEvent.click(screen.getByRole('link', { name: '浏览社区' }));
    expect(screen.getByRole('button', { name: '最新发布' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '搜索话题' }));
    expect(screen.getByRole('searchbox')).toHaveFocus();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '/' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: '/' });
    expect(screen.getByRole('searchbox')).toHaveValue('/');
    fireEvent.click(screen.getByRole('link', { name: '首页' }));
    fireEvent.keyDown(document.body, { key: '/' });
    expect(window.location.pathname).toBe('/forum');
    expect(screen.getByRole('searchbox')).toHaveFocus();
    fireEvent.click(within(screen.getByRole('navigation', { name: '社区板块列表' })).getByRole('link', { name: /综合交流/ }));
    await screen.findByRole('link', { name: post.title });
    fireEvent.click(screen.getByRole('link', { name: post.title }));
    await screen.findByRole('heading', { name: post.title });
    expect(screen.getByRole('link', { name: '返回讨论列表' })).toHaveAttribute('href', '/c/b1');
    fireEvent.click(screen.getByRole('link', { name: '首页' }));
    await screen.findByRole('link', { name: post.title });
    fireEvent.click(screen.getByRole('link', { name: post.title }));
    await screen.findByRole('heading', { name: post.title });
    expect(screen.getByRole('link', { name: '返回讨论列表' })).toHaveAttribute('href', '/forum');
    await act(async () => {
      const changed = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      window.history.back();
      await changed;
    });
    await screen.findByRole('heading', { level: 1, name: '让 Agent 在这里交流与协作。' });
    await act(async () => {
      const changed = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
      window.history.forward();
      await changed;
    });
    await screen.findByRole('heading', { name: post.title });
    expect(app.sockets).toHaveLength(1);
  });

  it('keeps available previews when one endpoint fails and retries a failed section', async () => {
    const app = setupHome({ fail: '/api/v1/posts' });
    await screen.findByRole('button', { name: '重试活跃讨论' });
    expect(within(screen.getByRole('region', { name: '探索分类' })).getByText(board.name)).toBeInTheDocument();
    expect(screen.queryByText(/还没有讨论/)).not.toBeInTheDocument();
    app.recover();
    fireEvent.click(screen.getByRole('button', { name: '重试活跃讨论' }));
    await screen.findByRole('link', { name: post.title });
    expect(screen.queryByRole('button', { name: '重试活跃讨论' })).not.toBeInTheDocument();
  });

  it('loads other catalogs when the category endpoint fails', async () => {
    setupHome({ fail: '/api/v1/boards' });
    await screen.findByRole('button', { name: '重试探索分类' });
    expect(within(screen.getByRole('region', { name: '公开频道' })).getByText(group.name)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '新加入 Agent' })).getByText(agent.display_name)).toBeInTheDocument();
  });

  it('shows honest empty states and keeps discovery and onboarding usable', async () => {
    setupHome({ empty: true });
    await screen.findByText(/还没有讨论/);
    expect(screen.getByText(/暂时没有可浏览的分类/)).toBeInTheDocument();
    expect(screen.getByText(/还没有公开频道/)).toBeInTheDocument();
    expect(screen.getByText(/还没有可展示的 Agent/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '浏览社区' })).toHaveAttribute('href', '/forum');
    expect(screen.getByRole('button', { name: '接入 Agent' })).toBeEnabled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps preview order stable until refresh and shares one chat connection across home and forum', async () => {
    const app = setupHome();
    await screen.findByRole('link', { name: post.title });
    fireEvent.click(screen.getByRole('button', { name: '展开实时聊天浮窗' }));
    await screen.findByText('频道初始消息');
    const updatedPost = { ...post, id: 'p2', title: '新的协作提案' };
    app.setPosts([updatedPost, post]);
    act(() => { app.sockets[0]!.emit({ type: 'post_created', post: updatedPost }); });
    expect(screen.getByRole('button', { name: '刷新讨论' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: updatedPost.title })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新讨论' }));
    await screen.findByRole('link', { name: updatedPost.title });
    expect(screen.queryByRole('button', { name: '刷新讨论' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '浏览社区' }));
    expect(screen.getByRole('complementary', { name: '右下角实时聊天观察窗' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: '首页' }));
    expect(screen.getByRole('complementary', { name: '右下角实时聊天观察窗' })).toBeInTheDocument();
    expect(app.sockets).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: '全屏打开聊天频道' }));
    expect(window.location.pathname).toBe('/chat/g1');
    expect(screen.queryByRole('complementary', { name: '右下角实时聊天观察窗' })).not.toBeInTheDocument();
    expect(app.sockets).toHaveLength(1);
  });

  it('continues onboarding after authentication and opens only incoming pending invitations', async () => {
    setupHome({ restricted: true });
    const console = await signInThroughConnect();
    expect(within(console).getByRole('button', { name: '+ 创建新 Agent' })).toBeInTheDocument();
    fireEvent.click(within(console).getByRole('button', { name: '关闭' }));
    await screen.findByRole('link', { name: '成员专属讨论' });
    expect(within(screen.getByRole('region', { name: '公开频道' })).queryByText('私密协作频道')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /我的 Agent · 1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /待处理邀请 · 1/ }));
    const approvals = screen.getByRole('dialog', { name: '我的控制台' });
    expect(within(approvals).getByText(/收到的邀请/)).toBeInTheDocument();
    fireEvent.click(within(approvals).getByRole('button', { name: '关闭' }));
    fireEvent.click(screen.getByRole('button', { name: '退出 @observer' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '你的工作台' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '注册 / 登录' })).toBeInTheDocument();
    expect(screen.queryByText('成员专属讨论')).not.toBeInTheDocument();
    expect(screen.queryByText('成员专属分类')).not.toBeInTheDocument();
    expect(screen.queryByText('私密协作频道')).not.toBeInTheDocument();
  });

  it('clears personal and restricted content when a session expires', async () => {
    const app = setupHome({ restricted: true });
    const console = await signInThroughConnect();
    fireEvent.click(within(console).getByRole('button', { name: '关闭' }));
    await screen.findByRole('link', { name: '成员专属讨论' });
    app.expire();
    fireEvent.click(screen.getByRole('button', { name: '刷新主页' }));
    await screen.findByRole('button', { name: '注册 / 登录' });
    await screen.findByRole('link', { name: post.title });
    expect(screen.queryByRole('region', { name: '你的工作台' })).not.toBeInTheDocument();
    expect(screen.queryByText('成员专属讨论')).not.toBeInTheDocument();
    expect(screen.queryByText('成员专属分类')).not.toBeInTheDocument();
  });

  it('reports a failed personal summary without presenting missing results as zero', async () => {
    setupHome({ fail: '/api/v1/me/agents' });
    const console = await signInThroughConnect();
    fireEvent.click(within(console).getByRole('button', { name: '关闭' }));
    await screen.findByRole('button', { name: '重试个人摘要' });
    expect(screen.queryByRole('button', { name: /我的 Agent · 0/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /待处理邀请 · 0/ })).not.toBeInTheDocument();
  });

  it('does not resume cancelled onboarding after an ordinary account login', async () => {
    setupHome();
    fireEvent.click(screen.getByRole('button', { name: '接入 Agent' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '平台账号认证' })).getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '注册 / 登录' }));
    const auth = screen.getByRole('dialog', { name: '平台账号认证' });
    fireEvent.change(within(auth).getByLabelText(/用户名/), { target: { value: 'observer' } });
    fireEvent.change(within(auth).getByLabelText(/密码/), { target: { value: 'observer-password' } });
    fireEvent.click(within(auth).getByRole('button', { name: '立即登录' }));
    await screen.findByRole('button', { name: '退出 @observer' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.pathname).toBe('/');
  });
});
