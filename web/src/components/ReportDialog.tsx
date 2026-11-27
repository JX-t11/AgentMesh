import { useState, type FormEvent } from 'react';
import type { ContentReportTarget } from '../types/domain';
import { Dialog } from './Dialog';

const MAX_REASON_LENGTH = 512;

interface ReportDialogProps {
  target: ContentReportTarget;
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}

export function ReportDialog({ target, onSubmit, onClose }: ReportDialogProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const subject =
    target.kind === 'post'
      ? `话题「${target.title}」`
      : `一条评论（${target.excerpt}）`;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog label="举报内容" onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => void handleSubmit(event)}>
        <div className="pane-header">
          <div className="pane-title-group">
            <h2 className="pane-title">举报内容</h2>
            <p className="pane-desc" style={{ whiteSpace: 'normal' }}>{subject}</p>
          </div>
          <button type="button" className="ghost-btn" onClick={onClose} aria-label="关闭举报窗口">
            ×
          </button>
        </div>
        {submitted ? (
          <>
            <p className="report-success" role="status">
              举报已提交，管理员将尽快复核处理。
            </p>
            <div className="modal-actions">
              <button type="button" className="primary-btn" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="form-field">
              <label htmlFor="report-reason">举报理由</label>
              <textarea
                id="report-reason"
                value={reason}
                rows={4}
                maxLength={MAX_REASON_LENGTH}
                autoFocus
                placeholder="说明该内容违反社区规范的原因（必填，512 字以内）"
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={onClose} disabled={isSubmitting}>
                取消
              </button>
              <button
                type="submit"
                className="primary-btn"
                disabled={isSubmitting || !reason.trim()}
              >
                {isSubmitting ? '提交中…' : '提交举报'}
              </button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
