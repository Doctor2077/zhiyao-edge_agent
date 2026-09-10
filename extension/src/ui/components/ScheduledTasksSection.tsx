import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { newTask, taskValid, type ScheduledTask } from '@/core/scheduledTasks';
import { t } from '../i18n';

/** 设置页「定时任务」栏目：任务列表 + 新建/编辑表单，CRUD 全部走 background */
export default function ScheduledTasksSection() {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    const res = (await browser.runtime.sendMessage({ type: 'GET_TASKS' })) as {
      tasks?: ScheduledTask[];
    };
    if (res?.tasks) setTasks(res.tasks);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!tasks) return null;

  const op = async (payload: unknown) => {
    const res = (await browser.runtime.sendMessage(payload)) as {
      ok?: boolean;
      tasks?: ScheduledTask[];
    };
    // 仅以 ok 为准：schema 拒绝时返回 ok:false + 空 tasks，不能误当成功清空列表
    if (res?.ok && res.tasks) setTasks(res.tasks);
  };

  const runNow = async (id: string) => {
    setRunning((p) => ({ ...p, [id]: true }));
    await op({ type: 'RUN_TASK_NOW', id });
    setRunning((p) => ({ ...p, [id]: false }));
    setTimeout(() => void refresh(), 2500); // 稍后回读执行结果
  };

  const scheduleText = (task: ScheduledTask) =>
    task.scheduleType === 'daily'
      ? `${t('taskDaily')} ${task.time}`
      : `${t('taskInterval')} ${task.intervalMinutes} ${t('taskMinutesUnit')}`;

  const lastRunText = (task: ScheduledTask) => {
    if (!task.lastRunAt) return `${t('taskLastRun')}：${t('taskNever')}`;
    const d = new Date(task.lastRunAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const when = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const status = task.lastStatus === 'error' ? t('taskFailed') : t('taskOk');
    return `${t('taskLastRun')}：${when}（${status}）`;
  };

  return (
    <section className="settings-section">
      <h3>{t('tasksTitle')}</h3>
      <p className="skills-hint">{t('tasksHint')}</p>

      {tasks.length === 0 && <p className="empty">{t('taskEmpty')}</p>}

      {tasks.map((task) => (
        <div key={task.id} className="task-row">
          <div className="task-main">
            <span className="provider-name">{task.name}</span>
            <span className="provider-sub">{scheduleText(task)}</span>
            <span className="provider-sub">{task.url}</span>
            <span className="provider-sub">{lastRunText(task)}</span>
            {task.lastMessage && (
              <span className="provider-sub task-last-msg">{task.lastMessage}</span>
            )}
          </div>
          <div className="task-actions">
            <button
              className="btn btn-small btn-primary"
              disabled={running[task.id]}
              title={t('taskRunNow')}
              onClick={() => void runNow(task.id)}
            >
              {running[task.id] ? t('taskRunning') : t('taskRunNow')}
            </button>
            <button
              className="btn btn-small"
              onClick={() => setEditing(task)}
            >
              {t('taskEdit')}
            </button>
            <button
              className="btn btn-small btn-danger"
              onClick={() => void op({ type: 'DELETE_TASK', id: task.id })}
            >
              {t('taskDelete')}
            </button>
            <label className="switch task-switch" title={t('taskEnabled')}>
              <input
                type="checkbox"
                checked={task.enabled}
                onChange={(e) =>
                  void op({ type: 'TOGGLE_TASK', id: task.id, enabled: e.target.checked })
                }
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
            </label>
          </div>
        </div>
      ))}

      {!editing && (
        <div className="form-actions">
          <button className="btn btn-primary" onClick={() => setEditing(newTask())}>
            {t('taskAdd')}
          </button>
        </div>
      )}

      {editing && (
        <TaskForm
          key={editing.id}
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={async (task) => {
            await op({ type: 'UPSERT_TASK', task });
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function TaskForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: ScheduledTask;
  onSave(task: ScheduledTask): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<ScheduledTask>(initial);
  const set = (patch: Partial<ScheduledTask>) => setDraft((d) => ({ ...d, ...patch }));
  const valid = taskValid(draft);

  return (
    <div className="task-form provider-form">
      <h3>{t('taskEditTitle')}</h3>
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
      <label>
        {t('taskScheduleLabel')}
        <select
          value={draft.scheduleType}
          onChange={(e) =>
            set({ scheduleType: e.target.value as ScheduledTask['scheduleType'] })
          }
        >
          <option value="daily">{t('taskDaily')}</option>
          <option value="interval">{t('taskInterval')}</option>
        </select>
      </label>
      {draft.scheduleType === 'daily' ? (
        <label>
          {t('taskTimeLabel')}
          <input
            type="time"
            value={draft.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </label>
      ) : (
        <label>
          {`${t('taskInterval')}（${t('taskMinutesUnit')}）`}
          <input
            type="number"
            min={1}
            max={10080}
            value={draft.intervalMinutes}
            onChange={(e) =>
              set({ intervalMinutes: Math.max(1, parseInt(e.target.value, 10) || 1) })
            }
          />
        </label>
      )}
      <label>
        {t('taskPromptLabel')}
        <textarea
          rows={3}
          value={draft.prompt}
          placeholder={t('taskPromptPlaceholder')}
          onChange={(e) => set({ prompt: e.target.value })}
        />
      </label>
      <div className="form-actions">
        <button
          className="btn btn-primary"
          disabled={!valid}
          onClick={() => onSave({ ...draft, name: draft.name.trim(), url: draft.url.trim() })}
        >
          {t('taskSave')}
        </button>
        <button className="btn" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
