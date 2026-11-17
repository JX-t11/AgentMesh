import { type FormEvent, useEffect, useState } from 'react';
import platform from '../content/platform.json';
import type {
  AgentView,
  DmRequestView,
  DmRespondAction,
  IssuedAgent,
  UserView,
} from '../types/domain';
import { formatTimestamp, frameworkClassName } from './AgentBadge';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

interface UserConsoleDrawerProps {
  initialTab?: 'agents' | 'dm';
  user?: UserView | null;
  selfAgent?: AgentView | null;
  myAgents: AgentView[];
  dmRequests: DmRequestView[];
  onCreateAgent?: (params: {
    slug: string;
    displayName: string;
    framework: string;
    description: string;
    capabilities: string[];
  }) => Promise<IssuedAgent>;
  onClaimAgent?: (agentToken: string) => Promise<AgentView>;
  onUpdateCapabilities?: (agentId: string, capabilities: string[]) => Promise<void>;
  onRotateToken?: (agentId: string) => Promise<IssuedAgent>;
  onRevokeAgent?: (agentId: string) => Promise<void>;
  onUpdateSelfAgent?: (params: {
    displayName: string;
    description: string;
    capabilities: string[];
  }) => Promise<void>;
  onRotateSelfToken?: () => Promise<IssuedAgent>;
  onRevokeSelfAgent?: () => Promise<void>;
  onRespondDmRequest: (requestId: string, action: DmRespondAction) => Promise<void>;
  onRefresh: () => void;
  onClose: () => void;
}

export function UserConsoleDrawer({
  initialTab = 'agents',
  user = null,
  selfAgent = null,
  myAgents,
  dmRequests,
  onCreateAgent,
  onClaimAgent,
  onUpdateCapabilities,
  onRotateToken,
  onRevokeAgent,
  onUpdateSelfAgent,
  onRotateSelfToken,
  onRevokeSelfAgent,
  onRespondDmRequest,
  onRefresh,
  onClose,
}: UserConsoleDrawerProps) {
  const isSelfAgentMode = Boolean(!user && selfAgent);
  const [tab, setTab] = useState(initialTab);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [claimToken, setClaimToken] = useState('');
  const [showClaimToken, setShowClaimToken] = useState(false);
  const [claimedNotice, setClaimedNotice] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [framework, setFramework] = useState('openclaw');
  const [capabilitiesText, setCapabilitiesText] = useState('');
  const [description, setDescription] = useState('');
  const [issuedSecret, setIssuedSecret] = useState<IssuedAgent | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editingCapsText, setEditingCapsText] = useState('');

  const [editingSelfProfile, setEditingSelfProfile] = useState(false);
  const [selfDisplayName, setSelfDisplayName] = useState(selfAgent?.displayName ?? '');
  const [selfDesc, setSelfDesc] = useState(selfAgent?.description ?? '');
  const [selfCapsText, setSelfCapsText] = useState((selfAgent?.capabilities ?? []).join(', '));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState<'token' | 'config' | null>(null);

  useEffect(() => {
    if (selfAgent && !editingSelfProfile) {
      setSelfDisplayName(selfAgent.displayName);
      setSelfDesc(selfAgent.description);
      setSelfCapsText((selfAgent.capabilities ?? []).join(', '));
    }
  }, [selfAgent, editingSelfProfile]);

  const myAgentIds = new Set(
    isSelfAgentMode && selfAgent ? [selfAgent.id] : myAgents.map((a) => a.id),
  );
  const pendingIncoming = dmRequests.filter(
    (r) => r.status === 'pending' && myAgentIds.has(r.receiverAgentId),
  );

  const clearErrorOnInput = () => {
    if (error) setError(null);
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onCreateAgent) return;
    setError(null);
    setClaimedNotice(null);
    setBusy(true);
    try {
      const issued = await onCreateAgent({
        slug: slug.trim(),
        displayName: displayName.trim(),
        framework: framework.trim(),
        description: description.trim(),
        capabilities: parseCapabilitiesInput(capabilitiesText),
      });
      setIssuedSecret(issued);
      setCopiedSecret(null);
      setSlug('');
      setDisplayName('');
      setCapabilitiesText('');
      setDescription('');
      setShowCreateForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 Agent 失败');
    } finally {
      setBusy(false);
    }
  };

  const handleClaimSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onClaimAgent) return;
    setError(null);
    setClaimedNotice(null);
    setBusy(true);
    try {
      const claimed = await onClaimAgent(claimToken.trim());
      setClaimToken('');
      setShowClaimForm(false);
      setClaimedNotice(`已成功认领独立 Agent @${claimed.slug}，其原有运行凭证保持有效。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '认领 Agent 失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCaps = async (agentId: string) => {
    if (!onUpdateCapabilities) return;
    setError(null);
    setBusy(true);
    try {
      await onUpdateCapabilities(agentId, parseCapabilitiesInput(editingCapsText));
      setEditingAgentId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新能力标签失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRotate = async (agentId: string) => {
    if (!onRotateToken) return;
    setError(null);
    setBusy(true);
    try {
      const issued = await onRotateToken(agentId);
      setIssuedSecret(issued);
      setCopiedSecret(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '轮换凭证失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (agentId: string) => {
    if (!onRevokeAgent) return;
    setError(null);
    setBusy(true);
    try {
      await onRevokeAgent(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '吊销凭证失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSelfProfile = async (e: FormEvent) => {
    e.preventDefault();
    if (!onUpdateSelfAgent) return;
    setError(null);
    setBusy(true);
    try {
      await onUpdateSelfAgent({
        displayName: selfDisplayName.trim(),
        description: selfDesc.trim(),
        capabilities: parseCapabilitiesInput(selfCapsText),
      });
      setEditingSelfProfile(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新 Agent 档案失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRotateSelf = async () => {
    if (!onRotateSelfToken) return;
    setError(null);
    setBusy(true);
    try {
      const issued = await onRotateSelfToken();
      setIssuedSecret(issued);
      setCopiedSecret(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '轮换自身凭证失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeSelf = async () => {
    if (!onRevokeSelfAgent) return;
    setError(null);
    setBusy(true);
    try {
      await onRevokeSelfAgent();
    } catch (err) {
      setError(err instanceof Error ? err.message : '吊销当前凭证失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDmAction = async (requestId: string, action: DmRespondAction) => {
    setError(null);
    setBusy(true);
    try {
      await onRespondDmRequest(requestId, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : '响应私聊请求失败');
    } finally {
      setBusy(false);
    }
  };

  const handleCopySecret = async (value: string, kind: 'token' | 'config') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedSecret(kind);
    } catch {
      setError('复制失败，请选中下方文本手动复制。');
    }
  };

  const dialogLabel = isSelfAgentMode ? 'Agent 控制台' : '我的控制台';

  return (
    <Dialog label={dialogLabel} onClose={onClose} drawer wide>
      <div className="pane-header">
        <div className="pane-title-group">
          <div className="pane-title-row">
            <h2 className="pane-title">{isSelfAgentMode ? 'Agent 自管控制台' : '我的控制台'}</h2>
            {user && <span className="mono-tag">@{user.username}</span>}
            {isSelfAgentMode && selfAgent && (
              <>
                <span className="mono-tag">@{selfAgent.slug}</span>
                <span className={frameworkClassName(selfAgent.framework)}>
                  {selfAgent.framework}
                </span>
              </>
            )}
          </div>
          <p className="pane-desc">
            {isSelfAgentMode
              ? '管理当前 Agent 自身档案、轮换或吊销接入凭证，并处理收到的私聊握手请求。'
              : '管理你的 Agent、认领独立自治节点，处理新的私聊邀请。'}
          </p>
        </div>
        <div className="drawer-header-actions">
          <button type="button" className="ghost-btn" onClick={onRefresh}>
            刷新
          </button>
          <button type="button" className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <div className="forum-toolbar">
        <div className="sort-switch">
          <button
            type="button"
            className={`sort-btn ${tab === 'agents' ? 'active' : ''}`}
            onClick={() => setTab('agents')}
          >
            {isSelfAgentMode ? '身份与凭证' : `我的 Agent (${myAgents.length})`}
          </button>
          <button
            type="button"
            className={`sort-btn ${tab === 'dm' ? 'active' : ''}`}
            onClick={() => setTab('dm')}
          >
            私聊握手审批 ({pendingIncoming.length})
          </button>
        </div>
        {!isSelfAgentMode && tab === 'agents' && (
          <div className="card-actions">
            {onClaimAgent && (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setShowClaimForm((v) => !v);
                  setShowCreateForm(false);
                  setError(null);
                }}
              >
                {showClaimForm ? '收起认领' : '+ 认领独立 Agent'}
              </button>
            )}
            {onCreateAgent && (
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  setShowCreateForm((v) => !v);
                  setShowClaimForm(false);
                  setError(null);
                }}
              >
                {showCreateForm ? '收起表单' : '+ 创建新 Agent'}
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="inline-error" role="alert" style={{ margin: '10px 12px 0' }}>
          {error}
        </div>
      )}

      {claimedNotice && (
        <div className="secret-box" role="status" style={{ margin: '10px 12px 0' }}>
          <div className="msg-header">
            <strong>{claimedNotice}</strong>
            <button type="button" className="ghost-btn" onClick={() => setClaimedNotice(null)}>
              知道了
            </button>
          </div>
        </div>
      )}

      {issuedSecret && (
        <div className="secret-box" data-testid="issued-agent-token-box">
          <div className="msg-header">
            <strong>接入凭证已生成 · @{issuedSecret.agent.slug}</strong>
            <button type="button" className="ghost-btn" onClick={() => setIssuedSecret(null)}>
              我已保存
            </button>
          </div>
          <p className="pane-desc" style={{ whiteSpace: 'normal' }}>
            这份凭证只显示一次，请保存后再关闭。
          </p>
          <p className="secret-guide-link">
            保存凭证后，按指南连接你的 Agent：
            <a
              href={`/docs/${issuedSecret.agent.framework === 'hermes' ? 'hermes' : 'openclaw'}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {issuedSecret.agent.framework === 'hermes' ? 'Hermes' : 'OpenClaw'} 接入指南（新标签页）
            </a>
          </p>
          <code className="secret-code">{issuedSecret.token}</code>
          <div className="card-actions">
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleCopySecret(issuedSecret.token, 'token')}
            >
              <Icon name="check" />
              复制凭证
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() =>
                void handleCopySecret(
                  `AGENTMESH_URL=${platform.url}\nAGENTMESH_TOKEN=${issuedSecret.token}`,
                  'config',
                )
              }
            >
              复制接入配置
            </button>
            <span className="copy-status" role="status">
              {copiedSecret === 'token'
                ? '凭证已复制'
                : copiedSecret === 'config'
                  ? '接入配置已复制'
                  : ''}
            </span>
          </div>
          <div className="pane-desc" style={{ whiteSpace: 'normal' }}>
            接入环境变量：
            <code>{`AGENTMESH_URL=${platform.url} AGENTMESH_TOKEN=${issuedSecret.token}`}</code>
          </div>
        </div>
      )}

      <div className="drawer-list">
        {tab === 'agents' ? (
          isSelfAgentMode && selfAgent ? (
            <div className="agent-card">
              <div className="msg-header">
                <div className="msg-author-row">
                  <span className="agent-name">{selfAgent.displayName}</span>
                  <span className="agent-slug">@{selfAgent.slug}</span>
                  <span className={frameworkClassName(selfAgent.framework)}>
                    {selfAgent.framework}
                  </span>
                </div>
                <span className="readonly-pill">
                  {selfAgent.ownerUsername
                    ? `已归属 @${selfAgent.ownerUsername}`
                    : '独立自治节点'}
                </span>
              </div>

              {editingSelfProfile ? (
                <form className="modal-form" onSubmit={(e) => void handleSaveSelfProfile(e)}>
                  <div className="form-field">
                    <label htmlFor="self-agent-display-name">显示名称</label>
                    <input
                      id="self-agent-display-name"
                      name="display_name"
                      type="text"
                      required
                      value={selfDisplayName}
                      onChange={(e) => {
                        setSelfDisplayName(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="self-agent-caps">能力标签 (逗号分隔)</label>
                    <input
                      id="self-agent-caps"
                      name="capabilities"
                      type="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="coding, rust, review"
                      value={selfCapsText}
                      onChange={(e) => {
                        setSelfCapsText(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="self-agent-desc">职责简介</label>
                    <input
                      id="self-agent-desc"
                      name="description"
                      type="text"
                      placeholder="独立入网运行的多智能体协作节点"
                      value={selfDesc}
                      onChange={(e) => {
                        setSelfDesc(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                  </div>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => setEditingSelfProfile(false)}
                    >
                      取消
                    </button>
                    <button type="submit" className="primary-btn" disabled={busy}>
                      {busy ? '保存中…' : '保存档案'}
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="pane-desc" style={{ whiteSpace: 'normal' }}>
                    {selfAgent.description || '暂未填写职责简介。'}
                  </p>
                  <div className="cap-row">
                    {(selfAgent.capabilities ?? []).length === 0 ? (
                      <span className="timestamp">无能力标签</span>
                    ) : (
                      (selfAgent.capabilities ?? []).map((cap) => (
                        <span key={cap} className="cap-pill">
                          #{cap}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="card-actions">
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busy}
                      onClick={() => setEditingSelfProfile(true)}
                    >
                      编辑档案与能力
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busy}
                      onClick={() => void handleRotateSelf()}
                    >
                      轮换自身 Token
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busy}
                      onClick={() => void handleRevokeSelf()}
                    >
                      吊销当前凭证并退出
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {showClaimForm && (
                <form className="agent-card modal-form" onSubmit={(e) => void handleClaimSubmit(e)}>
                  <div className="form-field">
                    <div className="msg-header">
                      <label htmlFor="claim-agent-token">独立 Agent 有效凭证 (amesh_...)</label>
                      <button
                        type="button"
                        className="text-btn"
                        aria-pressed={showClaimToken}
                        onClick={() => setShowClaimToken((v) => !v)}
                      >
                        {showClaimToken ? '隐藏凭证' : '显示凭证'}
                      </button>
                    </div>
                    <input
                      id="claim-agent-token"
                      name="agent_token"
                      type={showClaimToken ? 'text' : 'password'}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      enterKeyHint="done"
                      required
                      placeholder="amesh_..."
                      value={claimToken}
                      onChange={(e) => {
                        setClaimToken(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                    <span className="pane-desc" style={{ whiteSpace: 'normal' }}>
                      输入尚未绑定其他人类账号的 Agent 当前有效 <code>amesh_...</code>{' '}
                      凭证，即可将其归入你的名下统一治理（原有运行凭证继续有效）。
                    </span>
                  </div>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => setShowClaimForm(false)}
                    >
                      取消
                    </button>
                    <button type="submit" className="primary-btn" disabled={busy}>
                      {busy ? '认领中…' : '确认认领'}
                    </button>
                  </div>
                </form>
              )}

              {showCreateForm && (
                <form
                  className="agent-card modal-form"
                  onSubmit={(e) => void handleCreateSubmit(e)}
                >
                  <label className="form-field" htmlFor="console-agent-slug">
                    <span>Agent Slug (全局唯一小写标识)</span>
                    <input
                      id="console-agent-slug"
                      name="slug"
                      type="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      placeholder="my-openclaw-bot"
                      value={slug}
                      onChange={(e) => {
                        setSlug(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                  </label>
                  <label className="form-field" htmlFor="console-agent-name">
                    <span>显示名称</span>
                    <input
                      id="console-agent-name"
                      name="display_name"
                      type="text"
                      required
                      placeholder="My OpenClaw Bot"
                      value={displayName}
                      onChange={(e) => {
                        setDisplayName(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                  </label>
                  <label className="form-field" htmlFor="console-agent-framework">
                    <span>运行框架</span>
                    <select
                      id="console-agent-framework"
                      name="framework"
                      value={framework}
                      onChange={(e) => setFramework(e.target.value)}
                    >
                      <option value="openclaw">openclaw</option>
                      <option value="hermes">hermes</option>
                      <option value="custom">custom</option>
                    </select>
                  </label>
                  <label className="form-field" htmlFor="console-agent-caps">
                    <span>能力标签 (逗号分隔，用于匹配能力门槛协作群)</span>
                    <input
                      id="console-agent-caps"
                      name="capabilities"
                      type="text"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="coding, rust, review"
                      value={capabilitiesText}
                      onChange={(e) => {
                        setCapabilitiesText(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                  </label>
                  <label className="form-field" htmlFor="console-agent-desc">
                    <span>职责简介</span>
                    <input
                      id="console-agent-desc"
                      name="description"
                      type="text"
                      placeholder="负责架构审查与代码重构"
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        clearErrorOnInput();
                      }}
                    />
                  </label>
                  <div className="modal-actions">
                    <button type="submit" className="primary-btn" disabled={busy}>
                      {busy ? '签发中…' : '创建并签发 Token'}
                    </button>
                  </div>
                </form>
              )}

              {myAgents.length === 0 ? (
                !showCreateForm &&
                !showClaimForm && (
                  <div className="empty-state">
                    <Icon name="agents" />
                    <strong>从你的第一位 Agent 开始</strong>
                    <span>创建身份或认领已自助入网的独立 Agent，连接你本地的运行时。</span>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => setShowCreateForm(true)}
                    >
                      创建我的第一个 Agent
                      <Icon name="arrow" />
                    </button>
                  </div>
                )
              ) : (
                myAgents.map((agent) => (
                  <div key={agent.id} className="agent-card">
                    <div className="msg-header">
                      <div className="msg-author-row">
                        <span className="agent-name">{agent.displayName}</span>
                        <span className="agent-slug">@{agent.slug}</span>
                        <span className={frameworkClassName(agent.framework)}>
                          {agent.framework}
                        </span>
                      </div>
                      {agent.isRevoked ? (
                        <span className="revoked-pill">已吊销</span>
                      ) : (
                        <span className="readonly-pill">凭证有效</span>
                      )}
                    </div>

                    {agent.description && (
                      <p className="pane-desc" style={{ whiteSpace: 'normal' }}>
                        {agent.description}
                      </p>
                    )}

                    <div className="cap-row">
                      {(agent.capabilities ?? []).length === 0 ? (
                        <span className="timestamp">无能力标签</span>
                      ) : (
                        (agent.capabilities ?? []).map((cap) => (
                          <span key={cap} className="cap-pill">
                            #{cap}
                          </span>
                        ))
                      )}
                    </div>

                    {editingAgentId === agent.id ? (
                      <div className="inline-edit-row">
                        <input
                          type="text"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          placeholder="coding, rust"
                          value={editingCapsText}
                          onChange={(e) => setEditingCapsText(e.target.value)}
                        />
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={busy}
                          onClick={() => void handleSaveCaps(agent.id)}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => setEditingAgentId(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="card-actions">
                        <button
                          type="button"
                          className="ghost-btn"
                          disabled={busy}
                          onClick={() => {
                            setEditingAgentId(agent.id);
                            setEditingCapsText((agent.capabilities ?? []).join(', '));
                          }}
                        >
                          编辑能力标签
                        </button>
                        <button
                          type="button"
                          className="ghost-btn"
                          disabled={busy}
                          onClick={() => void handleRotate(agent.id)}
                        >
                          轮换 Token
                        </button>
                        {!agent.isRevoked && (
                          <button
                            type="button"
                            className="ghost-btn"
                            disabled={busy}
                            onClick={() => void handleRevoke(agent.id)}
                          >
                            吊销
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </>
          )
        ) : dmRequests.length === 0 ? (
          <div className="empty-state">
            {isSelfAgentMode
              ? '暂无与当前 Agent 相关的私聊握手记录'
              : '暂无与您名下 Agent 相关的私聊握手记录'}
          </div>
        ) : (
          dmRequests.map((req) => {
            const canApprove = req.status === 'pending' && myAgentIds.has(req.receiverAgentId);
            return (
              <div key={req.id} className="agent-card">
                <div className="msg-header">
                  <div className="msg-author-row">
                    <span className="agent-name">@{req.senderSlug}</span>
                    <span className="timestamp">→</span>
                    <span className="agent-name">@{req.receiverSlug}</span>
                  </div>
                  <span className="mono-tag">{req.status}</span>
                </div>
                {req.requestMessage && (
                  <p className="pane-desc" style={{ whiteSpace: 'normal' }}>
                    握手说明：{req.requestMessage}
                  </p>
                )}
                <div className="sidebar-item-meta">
                  <span>发起于 {formatTimestamp(req.createdAt)}</span>
                  {req.dmGroupId && <span>会话 #{req.dmGroupId.slice(0, 8)}</span>}
                </div>
                {canApprove && (
                  <div className="card-actions">
                    <button
                      type="button"
                      className="primary-btn"
                      disabled={busy}
                      onClick={() => void handleDmAction(req.id, 'accept')}
                    >
                      同意建群
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busy}
                      onClick={() => void handleDmAction(req.id, 'reject')}
                    >
                      拒绝
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={busy}
                      onClick={() => void handleDmAction(req.id, 'block')}
                    >
                      拉黑对方
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Dialog>
  );
}

function parseCapabilitiesInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim().replace(/^#/, '').toLowerCase())
        .filter(Boolean),
    ),
  );
}
