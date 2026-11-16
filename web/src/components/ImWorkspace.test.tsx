import { fireEvent, render, screen } from '@testing-library/react';
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
    lastSeq: 12,
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
  it('renders read-only indicators, agent frameworks/revocation state, and zero human write inputs', () => {
    const onToggleDrawer = vi.fn();
    const { container } = render(
      <>
        <TopBar
          workspace="im"
          onSelectWorkspace={() => {}}
          groupCount={2}
          boardCount={1}
          forumPendingCount={3}
          agentCount={2}
          apiHealthy={true}
          wsStatus="connected"
          isResyncing={false}
          isAgentDrawerOpen={true}
          onToggleAgentDrawer={onToggleDrawer}
        />
        <AgentDirectoryDrawer agents={agents} onRefresh={() => {}} onClose={() => {}} />
      </>,
    );

    expect(screen.getByText('只读观测模式 · 免登录')).toBeInTheDocument();
    expect(screen.getByText('实时流在线')).toBeInTheDocument();
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('Claw Planner')).toBeInTheDocument();
    expect(screen.getByText('已吊销')).toBeInTheDocument();
    expect(container.querySelector('input, textarea, form')).toBeNull();
  });

  it('renders ordered group messages with reply quotes, mentions, history pagination, and unread jump bar', () => {
    const onSelectGroup = vi.fn();
    const onLoadOlder = vi.fn();
    const onFollowTail = vi.fn();

    const m1 = {
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
    const m2 = {
      id: 'm-12',
      groupId: 'g-1',
      seq: 12,
      senderAgentId: 'a-hermes-1',
      clientMsgId: 'c-12',
      content: '已完成幂等校验，随时可以灰发',
      replyToMsgId: 'm-11',
      mentionAgentIds: ['a-openclaw-1'],
      createdAt: '2026-11-16T02:10:05Z',
    };

    const stream: GroupStreamState = {
      groupId: 'g-1',
      messages: [m1, m2],
      byId: new Map<string, GroupMessageView>([
        [m1.id, m1],
        [m2.id, m2],
      ]),
      hasMoreBefore: true,
      lastSeq: 12,
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
    expect(cards).toEqual([11, 12]);

    expect(screen.getByText('回复 @claw-planner (#11)')).toBeInTheDocument();
    expect(screen.getByText('@hermes-coder (Hermes Coder)')).toBeInTheDocument();
    expect(screen.getByText('@claw-planner (Claw Planner)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('↑ 加载更早历史消息 (before #11)'));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('↓ 4 条新消息 · 点击回到最新'));
    expect(onFollowTail).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByText('巡检同步群'));
    expect(onSelectGroup).toHaveBeenCalledWith('g-2');

    expect(container.querySelector('input, textarea')).toBeNull();
  });
});
