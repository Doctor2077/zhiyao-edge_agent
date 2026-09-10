import { useState } from 'react';
import { browser } from 'wxt/browser';
import { newTask, taskValid, type ScheduledTask } from '@/core/scheduledTasks';
import { t, uiLang } from '../i18n';

/** 对话页加号菜单里的「定时推送」快捷面板：预填当前页面，几步建好定时任务 */
export default function QuickTaskPanel({
  pageUrl,
  pageTitle,
  onClose,
}: {
  pageUrl: string;
  pageTitle: string;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<ScheduledTask>(() => ({
    ...newTask(),
    url: pageUrl,
    name: pageTitle
      ? `${pageTitle.slice(0, 40)}${uiLang() === 'zh' ? ' 监控' : ' watch'}`
      : '',
  }));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<ScheduledTask>) => setDraft((d) => ({ ...d, ...patch }));

  const valid = taskValid(draft);

  const save = async () => {
    setSaving(true);
    setError('');
    const res = (await browser.runtime.sendMessage({
      type: 'UPSERT_TASK',
      task: { ...draft, name: draft.name.trim(), url: draft.url.trim() },
    })) as { ok?: boolean; message?: string };
    setSaving(false);
    if (!res?.ok) {
      setError(res?.message || 'save failed');
      return;
    }
    setSaved(true);
  };

  return (
    <div className="skill-picker quick-task-panel">
      <div className="skill-picker-head">
        <span className="skill-picker-title">{t('quickTaskTitle')}</span>
        <button className="btn-icon" aria-label={t('cancel')} onClick={onClose}>
          ✕
        </button>
      </div>
      {saved ? (
        <>
          <p className="skill-picker-empty">{t('quickTaskSaved')}</p>
          <button className="btn btn-small skill-picker-manage" onClick={onClose}>
            {t('quickTaskDone')}
          </button>
        </>
      ) : (
        <div className="quick-task-form">
          <label>
            {t('taskNameLabel')}
            <input
              value={draft.name}
              placeholder={t('taskNamePlaceholder')}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label>
            {t('taskUrlLabel')}
            <input
              value={draft.url}
              placeholder={t('taskUrlPlaceholder')}
              onChange={(e) => set({ url: e.target.value })}
            />
          </label>
          <div className="quick-task-field">
            <span className="quick-task-label">{t('taskScheduleLabel')}</span>
            <div className="quick-task-schedule">
              <select
                value={draft.scheduleType}
                onChange={(e) =>
                  set({ scheduleType: e.target.value as ScheduledTask['scheduleType'] })
                }
              >
                <option value="daily">{t('taskDaily')}</option>
                <option value="interval">{t('taskInterval')}</option>
              </select>
              {draft.scheduleType === 'daily' ? (
                <input
                  type="time"
                  value={draft.time}
                  onChange={(e) => set({ time: e.target.value })}
                />
              ) : (
                <>
                  <input
                    type="number"
                    min={1}
                    max={10080}
                    value={draft.intervalMinutes}
                    onChange={(e) =>
                      set({ intervalMinutes: Math.max(1, parseInt(e.target.value, 10) || 1) })
                    }
                  />
                  <span className="quick-task-unit">{t('taskMinutesUnit')}</span>
                </>
              )}
            </div>
          </div>
          <label>
            {t('taskPromptLabel')}
            <textarea
              rows={2}
              value={draft.prompt}
              placeholder={t('taskPromptPlaceholder')}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </label>
          {error && <p className="test-result fail">{error}</p>}
          <div className="form-actions">
            <button
              className="btn btn-primary"
              disabled={!valid || saving}
              onClick={() => void save()}
            >
              {saving ? t('testing') : t('taskSave')}
            </button>
            <button className="btn" onClick={onClose}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
