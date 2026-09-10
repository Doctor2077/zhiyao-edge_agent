import { useCallback, useEffect, useState } from 'react';
import {
  clearSessions,
  deleteSession,
  loadSessions,
  type Session,
} from '@/core/sessions';
import { sessionSiteLabel } from '../useChat';
import { t } from '../i18n';
import BrandMark from '../BrandMark';

export default function HistoryView({
  onOpenSession,
}: {
  onOpenSession(session: Session): void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);

  const refresh = useCallback(async () => {
    setSessions(await loadSessions());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dateLabel = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="history">
      <div className="history-head">
        <h2>{t('historyTitle')}</h2>
        {sessions.length > 0 && (
          <button
            className="btn btn-small"
            onClick={async () => {
              await clearSessions();
              void refresh();
            }}
          >
            {t('clearHistory')}
          </button>
        )}
      </div>
      {sessions.length === 0 && (
        <div className="empty">
          <span className="empty-mark">
            <BrandMark size={30} />
          </span>
          <p>{t('historyEmpty')}</p>
        </div>
      )}
      <ul className="session-list">
        {sessions.map((s) => {
          const site = sessionSiteLabel(s);
          return (
            <li key={s.id}>
              <button className="session-item" onClick={() => onOpenSession(s)}>
                {site && <span className="session-site">🌐 {site}</span>}
                <span className="session-title">{s.title || t('untitled')}</span>
                <span className="session-date">{dateLabel(s.updatedAt)}</span>
              </button>
              <button
                className="btn-icon"
                aria-label={t('deleteSession')}
                title={t('deleteSession')}
                onClick={async () => {
                  await deleteSession(s.id);
                  void refresh();
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
