import { useCallback, useEffect, useState } from 'react';
import {
  clearLogs,
  exportLogs,
  formatLogs,
  loadLogs,
  type LogEntry,
} from '@/core/logger';
import { t } from '../i18n';

/** 设置页「日志」栏目：查看 / 导出 / 清空 */
export default function LogsSection() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    setLogs(await loadLogs());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = showAll ? logs : logs.slice(0, 5);

  return (
    <section className="settings-section">
      <h3>{t('logsTitle')}</h3>
      <p className="skills-hint">{t('logsHint')}</p>
      {logs.length === 0 ? (
        <p className="empty">{t('logEmpty')}</p>
      ) : (
        <>
          <p className="logs-count">{t('logCount', { n: logs.length })}</p>
          <pre className="logs-view">{formatLogs(visible)}</pre>
          {logs.length > 5 && (
            <button
              className="btn btn-small"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? t('logShowFew') : t('logShowAll')}
            </button>
          )}
        </>
      )}
      <div className="form-actions">
        <button
          className="btn btn-small btn-primary"
          disabled={logs.length === 0}
          onClick={() => void exportLogs()}
        >
          {t('logExport')}
        </button>
        <button
          className="btn btn-small btn-danger"
          disabled={logs.length === 0}
          onClick={async () => {
            await clearLogs();
            void refresh();
          }}
        >
          {t('logClear')}
        </button>
      </div>
    </section>
  );
}
