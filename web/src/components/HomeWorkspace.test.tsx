import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeWorkspace } from './HomeWorkspace';
import type { AgentView, BoardView, GroupView, PostView } from '../types/domain';

describe('home discovery previews', () => {
  it('bounds real content, excludes private channels and revoked Agents, and uses the newest registrations', () => {
    const agents: AgentView[] = Array.from({ length: 7 }, (_, n) => ({
      id: `a${n}`, slug: `agent-${n}`, displayName: `Agent ${n}`, framework: 'hermes', description: '协作',
      capabilities: ['review'], isRevoked: n === 6, createdAt: `2026-11-${10 + n}T00:00:00Z`,
    }));
    const boards: BoardView[] = Array.from({ length: 6 }, (_, n) => ({
      id: `b${n}`, slug: `board-${n}`, name: `分类 ${n}`, description: '分类说明', postCount: 12 + n,
      visibility: n === 0 ? 'platform' : 'public', createdAt: '2026-11-16T02:00:00Z',
    }));
    const groups: GroupView[] = Array.from({ length: 7 }, (_, n) => ({
      id: `g${n}`, slug: `channel-${n}`, name: `频道 ${n}`, description: '频道说明',
      visibility: n === 0 ? 'private' : 'public', isDm: n === 1, memberCount: 2 + n, lastSeq: 20,
      createdAt: '2026-11-16T02:00:00Z',
    }));
    const posts: PostView[] = Array.from({ length: 8 }, (_, n) => ({
      id: `p${n}`, boardId: 'b0', authorAgentId: 'a0', title: `讨论 ${n}`, content: '**真实**内容',
      clientReqId: `req-${n}`, mentionAgentIds: [], commentCount: 10 + n,
      createdAt: '2026-11-16T02:00:00Z', lastActivityAt: '2026-11-17T02:00:00Z',
    }));
    const inspect = vi.fn();
    const openAgents = vi.fn();
    const props = {
      posts, boards, groups, agents, agentsById: new Map(agents.map((agent) => [agent.id, agent])),
      currentUser: null, myAgentCount: 0, pendingDmCount: 0, hasUpdates: false,
      status: Object.fromEntries(['posts', 'boards', 'groups', 'agents', 'personal'].map((key) => [key, { isLoading: false, error: null }])) as Parameters<typeof HomeWorkspace>[0]['status'],
      onNavigate: vi.fn(), onConnectAgent: vi.fn(), onOpenAgents: openAgents, onOpenConsole: vi.fn(), onRefresh: vi.fn(),
      onRetryPosts: vi.fn(), onRetryBoards: vi.fn(), onRetryGroups: vi.fn(), onRetryAgents: vi.fn(), onRetryPersonal: vi.fn(),
      onInspectAgent: inspect, onUnknownAgent: vi.fn(),
    };
    render(<HomeWorkspace {...props} />);
    const topics = within(screen.getByRole('region', { name: '活跃讨论' }));
    expect(topics.getAllByRole('article')).toHaveLength(6);
    expect(topics.getByRole('link', { name: '讨论 0' })).toHaveAttribute('href', '/t/p0');
    expect(topics.getByText('10 条回复')).toBeInTheDocument();
    expect(topics.getAllByText('平台用户可见')).toHaveLength(6);
    expect(within(screen.getByRole('region', { name: '探索分类' })).getAllByRole('heading', { level: 3 })).toHaveLength(4);
    const channels = within(screen.getByRole('region', { name: '公开频道' }));
    expect(channels.getAllByRole('heading', { level: 3 })).toHaveLength(4);
    expect(channels.queryByText('频道 0')).not.toBeInTheDocument();
    expect(channels.queryByText('频道 1')).not.toBeInTheDocument();
    expect(channels.getByText('4 位成员')).toBeInTheDocument();
    const directory = within(screen.getByRole('region', { name: '新加入 Agent' }));
    expect(directory.getAllByRole('article')).toHaveLength(4);
    expect(directory.getAllByRole('button').slice(0, 4).map((button) => button.textContent)).toEqual([
      expect.stringContaining('Agent 5'), expect.stringContaining('Agent 4'), expect.stringContaining('Agent 3'), expect.stringContaining('Agent 2'),
    ]);
    expect(directory.queryByText('Agent 6')).not.toBeInTheDocument();
    fireEvent.click(directory.getByRole('button', { name: /查看 Agent Agent 5/ }));
    expect(inspect).toHaveBeenCalledWith('a5');
    fireEvent.click(directory.getByRole('button', { name: /Agent 名录/ }));
    expect(openAgents).toHaveBeenCalledOnce();
    expect(screen.queryByText(/在线人数|浏览量|点赞/)).not.toBeInTheDocument();
  });
});
