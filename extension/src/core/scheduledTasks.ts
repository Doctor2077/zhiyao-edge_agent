import { z } from 'zod';
import { browser } from 'wxt/browser';

/**
 * 定时任务：chrome.alarms 驱动的「定时检查网页 → AI 判断 → 推送通知」。
 * 本文件只负责任务模型与存储（无 UI / 无 alarms 依赖），调度由 background 接线。
 * 隐私红线：任务本身（名称/地址/指令）仅存本机，不经过任何服务器。
 */

export const ScheduledTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  url: z
    .string()
    .min(1)
    .refine((v) => /^https?:\/\//i.test(v), 'must be an http(s) URL'),
  /** daily=每天固定时刻；interval=每隔 N 分钟 */
  scheduleType: z.enum(['daily', 'interval']),
  /** daily 模式：本地时间 'HH:MM'（00:00-23:59） */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** interval 模式：分钟数（最小 1，最大 7 天） */
  intervalMinutes: z.number().int().min(1).max(10080),
  /** 给 AI 的检查指令（如「检查价格是否变化」） */
  prompt: z.string().max(500),
  enabled: z.boolean().default(true),
  lastRunAt: z.number().optional(),
  lastStatus: z.enum(['ok', 'error']).optional(),
  lastMessage: z.string().optional(),
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

/** 新建任务的默认草稿 */
export function newTask(): ScheduledTask {
  return {
    id: crypto.randomUUID(),
    name: '',
    url: '',
    scheduleType: 'daily',
    time: '09:00',
    intervalMinutes: 60,
    prompt: '',
    enabled: true,
  };
}

/** 表单级校验：与 ScheduledTaskSchema 的边界保持一致（超限会被 schema 拒绝） */
export function taskValid(task: ScheduledTask): boolean {
  const name = task.name.trim();
  return (
    name.length >= 1 &&
    name.length <= 60 &&
    /^https?:\/\//i.test(task.url.trim()) &&
    (task.scheduleType !== 'daily' || /^([01]\d|2[0-3]):[0-5]\d$/.test(task.time)) &&
    task.intervalMinutes >= 1 &&
    task.intervalMinutes <= 10080 &&
    task.prompt.length <= 500
  );
}

const TASKS_KEY = 'scheduled_tasks';

export async function loadTasks(): Promise<ScheduledTask[]> {
  const data = await browser.storage.local.get(TASKS_KEY);
  const raw = data[TASKS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: ScheduledTask[] = [];
  for (const item of raw) {
    const parsed = ScheduledTaskSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  await browser.storage.local.set({ [TASKS_KEY]: tasks });
}

/** 每个任务对应一个 alarm 名 */
export function taskAlarmName(id: string): string {
  return `task:${id}`;
}

export interface TaskSchedule {
  /** 首次触发时间（ms epoch），仅 daily 模式 */
  when?: number;
  /** 重复周期（分钟） */
  periodInMinutes: number;
}

/** 计算任务的下一次触发与周期；daily 时间非法时返回 null */
export function computeSchedule(
  task: ScheduledTask,
  now: Date = new Date(),
): TaskSchedule | null {
  if (task.scheduleType === 'interval') {
    const minutes = Math.round(task.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) return null;
    return { periodInMinutes: minutes };
  }
  const parts = task.time.split(':');
  const h = parseInt(parts[0] ?? '', 10);
  const m = parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return { when: next.getTime(), periodInMinutes: 1440 };
}
