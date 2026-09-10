import type { ActionProposal } from '../useChat';
import { t } from '../i18n';

export default function ActionCard({
  proposal,
  onConfirm,
  onCancel,
  onApproveAuto,
}: {
  proposal: ActionProposal;
  onConfirm(): void;
  onCancel(): void;
  onApproveAuto(): void;
}) {
  const riskKey =
    proposal.risk >= 3 ? 'riskHigh' : proposal.risk === 2 ? 'riskMid' : 'riskLow';
  const riskClass =
    proposal.risk >= 3 ? 'risk-high' : proposal.risk === 2 ? 'risk-mid' : 'risk-low';

  return (
    <div className="action-card">
      <div className="action-card-head">
        <span className={`risk-badge ${riskClass}`}>{t(riskKey)}</span>
        <span className="action-card-title">{t('proposeAction')}</span>
      </div>
      <p className="action-summary">{proposal.summary}</p>
      {proposal.tool === 'type' || proposal.tool === 'select' ? (
        <pre className="action-args">{proposal.args.text}</pre>
      ) : null}
      <p className="risk-hint">{t('riskHint')}</p>
      <div className="action-card-actions">
        <button className="btn btn-primary" onClick={onConfirm}>
          {t('confirmAction')}
        </button>
        <button className="btn" onClick={onApproveAuto}>
          {t('approveAuto')}
        </button>
        <button className="btn" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
