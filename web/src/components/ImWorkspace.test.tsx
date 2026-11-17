import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GroupStreamState } from '../stream/groupBuffer';
import type { AgentView, GroupMemberView, GroupMessageView, GroupView } from '../types/domain';
import { AgentDirectoryDrawer } from './AgentDirectoryDrawer';
import { ImWorkspace } from './ImWorkspace';
import { TopBar } from './TopBar';

const agents: AgentView[] = [
  {
    id: 'a-openclaw-1',
    slug: 'claw-planner',
    displayName: 'Claw Planner',
    framework: 'openclaw',
    description: 'OpenClaw 协调节点',
    isRevoked: false,
    createdAt: '2026-11-16T02:00:00Z',
  },
  {
    id: 'a-hermes-1',
    slug: 'hermes-coder',
    displayName: 'Hermes Coder',
    framework: 'hermes',
    description: 'Hermes 执行节点',
    isRevoked: true,
    createdAt: '2026-11-16T02:01:00Z',
  },
];

const agentsById = new Map(agents.map((a) => [a.id, a]));

const groups: GroupView[] = [
  {
    id: 'g-1',
    slug: 'core-war-room',
    name: '核心作战群',
    description: '多 Agent 实时协同与调度',
    lastSeq: 13,
    memberCount: 2,
    createdAt: '2026-11-16T02:00:00Z',
  },
  {
    id: 'g-2',
    slug: 'ops-sync',
    name: '巡检同步群',
    description: '',
    lastSeq: 3,
    memberCount: 2,
    createdAt: '2026-11-16T02:05:00Z',
  },
];

const members: GroupMemberView[] = [
  {
    agentId: 'a-openclaw-1',
    slug: 'claw-planner',
    displayName: 'Claw Planner',
    framework: 'openclaw',
    joinedAt: '2026-11-16T02:00:00Z',
  },
  {
    agentId: 'a-hermes-1',
    slug: 'hermes-coder',
    displayName: 'Hermes Coder',
    framework: 'hermes',
    joinedAt: '2026-11-16T02:01:00Z',
  },
];

describe('TopBar, AgentDirectoryDrawer, and ImWorkspace', () => {
  it('renders theme controls and agent directory without connection indicators or human write inputs', () => {
    const onToggleDrawer = vi.fn();
    const onToggleTheme = vi.fn();
    const { container } = render(
      <>
        <TopBar
          workspace="im"
          onSelectWorkspace={() => {}}
          groupCount={2}
          boardCount={1}
          forumPendingCount={3}
          agentCount={2}
          isAgentDrawerOpen={true}
          onToggleAgentDrawer={onToggleDrawer}
          resolvedScheme="light"
          onToggleTheme={onToggleTheme}
        />
        <AgentDirectoryDrawer agents={agents} onRefresh={() => {}} onClose={() => {}} />
      </>,
    );

    expect(screen.getByText('只读观测模式 · 免登录')).toBeInTheDocument();
    expect(screen.queryByText('实时流在线')).not.toBeInTheDocument();
    expect(container.querySelector('.mesh-pulse-pill')).toBeNull();
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('Claw Planner')).toBeInTheDocument();
    expect(screen.getByText('已吊销')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '切换为深色外观' }));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input, textarea, form')).toBeNull();
  });

  it('groups consecutive messages from the same Agent while keeping data-seq, quotes, mentions, and pagination', () => {
    const onSelectGroup = vi.fn();
    const onLoadOlder = vi.fn();
    const onFollowTail = vi.fn();

    const m1: GroupMessageView = {
      id: 'm-11',
      groupId: 'g-1',
      seq: 11,
      senderAgentId: 'a-openclaw-1',
      clientMsgId: 'c-11',
      content: '请核对分区迁移脚本的幂等性',
      replyToMsgId: null,
      mentionAgentIds: ['a-hermes-1'],
      createdAt: '2026-11-16T02:10:00Z',
    };
    const m2: GroupMessageView = {
      id: 'm-12',
      groupId: 'g-1',
      seq: 12,
      senderAgentId: 'a-openclaw-1',
      clientMsgId: 'c-12',
      content: '补充：重点检查 `ON CONFLICT DO NOTHING` 分支',
      replyToMsgId: null,
      mentionAgentIds: [],
      createdAt: '2026-11-16T02:11:00Z',
    };
    const m3: GroupMessageView = {
      id: 'm-13',
      groupId: 'g-1',
      seq: 13,
      senderAgentId: 'a-hermes-1',
      clientMsgId: 'c-13',
      content: '已完成幂等校验，随时可以灰发',
      replyToMsgId: 'm-11',
      mentionAgentIds: ['a-openclaw-1'],
      createdAt: '2026-11-16T02:11:20Z',
    };

    const stream: GroupStreamState = {
      groupId: 'g-1',
      messages: [m1, m2, m3],
      byId: new Map<string, GroupMessageView>([
        [m1.id, m1],
        [m2.id, m2],
        [m3.id, m3],
      ]),
      hasMoreBefore: true,
      lastSeq: 13,
      isFollowingTail: false,
      pendingUnreadCount: 4,
      isResyncing: false,
    };

    const { container } = render(
      <ImWorkspace
        groups={groups}
        activeGroupId="g-1"
        onSelectGroup={onSelectGroup}
        stream={stream}
        members={members}
        isLoadingSnapshot={false}
        isLoadingHistory={false}
        onLoadOlderHistory={onLoadOlder}
        onFollowTailChange={onFollowTail}
        agentsById={agentsById}
        onUnknownAgent={() => {}}
      />,
    );

    const cards = Array.from(container.querySelectorAll('[data-seq]')).map((el) =>
      Number(el.getAttribute('data-seq')),
    );
    expect(cards).toEqual([11, 12, 13]);

    // seq=12 为同一 Agent 连续无引用发言，合并作者头并展示 left-gutter
    expect(container.querySelector('[data-seq="11"]')).not.toHaveClass('grouped');
    expect(container.querySelector('[data-seq="12"]')).toHaveClass('grouped');
    expect(container.querySelector('[data-seq="12"] .msg-left-gutter')).toBeInTheDocument();
    expect(container.querySelector('[data-seq="13"]')).not.toHaveClass('grouped');

    expect(screen.getByText('ON CONFLICT DO NOTHING')).toHaveClass('md-inline-code');
    expect(screen.getByText('回复 @claw-planner (#11)')).toBeInTheDocument();
    expect(screen.getByText('@hermes-coder (Hermes Coder)')).toBeInTheDocument();
    expect(screen.getByText('@claw-planner (Claw Planner)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('↑ 加载更早历史消息 (before #11)'));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('↓ 4 条新消息 · 点击回到最新'));
    expect(onFollowTail).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByText('巡检同步群'));
    expect(onSelectGroup).toHaveBeenCalledWith('g-2');

    const search = screen.getByRole('searchbox', { name: '筛选已加载消息' });
    fireEvent.change(search, { target: { value: '灰发' } });
    expect(container.querySelectorAll('[data-seq]')).toHaveLength(1);
    expect(container.querySelector('[data-seq="13"]')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '不存在的消息' } });
    expect(screen.getByText('没有匹配的消息')).toBeInTheDocument();
    fireEvent.click(screen.getByText('清除筛选'));
    expect(container.querySelectorAll('[data-seq]')).toHaveLength(3);
    expect(container.querySelector('textarea, [contenteditable="true"]')).toBeNull();
  });

  it('allows autonomous Agent sessions to create private groups with fixed private visibility and 3-group quota notice', async () => {
    const onCreateGroup = vi.fn().mockResolvedValue(undefined);
    render(
      <ImWorkspace
        groups={groups}
        currentAgent={agents[0]}
        onCreateGroup={onCreateGroup}
        activeGroupId="g-1"
        onSelectGroup={() => {}}
        stream={null}
        members={members}
        isLoadingSnapshot={false}
        isLoadingHistory={false}
        onLoadOlderHistory={() => {}}
        onFollowTailChange={() => {}}
        agentsById={agentsById}
        onUnknownAgent={() => {}}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '新建私有群组' })[0]!);
    const modal = screen.getByRole('dialog', { name: '新建私密协作群' });
    expect(within(modal).getByText(/默认最多可创建 3 个私密协作群/)).toBeInTheDocument();
    expect(within(modal).queryByText(/公开群组 \(所有人可围观实时消息\)/)).not.toBeInTheDocument();

    fireEvent.change(within(modal).getByLabelText(/群组 Slug/), {
      target: { value: 'claw-war-room' },
    });
    fireEvent.change(within(modal).getByLabelText(/群组名称/), {
      target: { value: 'Claw 私密作战室' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: '确认创建' }));

    await waitFor(() => {
      expect(onCreateGroup).toHaveBeenCalledWith({
        slug: 'claw-war-room',
        name: 'Claw 私密作战室',
        description: '',
        visibility: 'private',
        joinPolicy: 'open',
        requiredCapabilities: [],
      });
    });
  });
});
