import { z } from 'zod';
import { ScheduledTaskSchema, type ScheduledTask } from './scheduledTasks';

/** sidepanel → background：读取当前页面的请求 */
export const ReadPageRequestSchema = z.object({
  type: z.literal('READ_PAGE'),
  includeBody: z.boolean().default(true),
  includeViewport: z.boolean().default(true),
  maxBodyChars: z.number().int().positive().default(12000),
  maxViewportChars: z.number().int().positive().default(4000),
});
export type ReadPageRequest = z.infer<typeof ReadPageRequestSchema>;

export const PageDataSchema = z.object({
  ok: z.literal(true),
  title: z.string(),
  url: z.string(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  viewport: z.string(),
  viewportTruncated: z.boolean(),
  selection: z.string(),
  lang: z.string(),
});
export type PageData = z.infer<typeof PageDataSchema>;

export const PageReadErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum(['NO_ACCESS', 'NO_TAB', 'INJECT_FAILED', 'UNKNOWN']),
  message: z.string(),
  /** http(s) 页面时给出 origin，供「授权访问」按钮使用；edge:// 等特殊页面为空 */
  origin: z.string().optional(),
});
export type PageReadError = z.infer<typeof PageReadErrorSchema>;

export const ReadPageResponseSchema = z.discriminatedUnion('ok', [
  PageDataSchema,
  PageReadErrorSchema,
]);
export type ReadPageResponse = z.infer<typeof ReadPageResponseSchema>;

/** ---- M2：交互元素快照 ---- */

export const SnapshotRequestSchema = z.object({
  type: z.literal('GET_SNAPSHOT'),
  maxElements: z.number().int().positive().default(200),
});
export type SnapshotRequest = z.infer<typeof SnapshotRequestSchema>;

export const SnapshotElementSchema = z.object({
  /** 快照内序号（模型引用用，最稳） */
  i: z.number().int(),
  tag: z.string(),
  text: z.string(),
  aria: z.string(),
  type: z.string(),
  role: z.string(),
  value: z.string(),
  disabled: z.boolean(),
  checked: z.boolean().nullable(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  selector: z.string(),
});
export type SnapshotElement = z.infer<typeof SnapshotElementSchema>;

export const SnapshotDataSchema = z.object({
  ok: z.literal(true),
  url: z.string(),
  title: z.string(),
  viewport: z.object({ w: z.number(), h: z.number() }),
  total: z.number(),
  truncated: z.boolean(),
  elements: z.array(SnapshotElementSchema),
});
export type SnapshotData = z.infer<typeof SnapshotDataSchema>;

export const SnapshotErrorSchema = z.object({
  ok: z.literal(false),
  code: z.enum(['NO_ACCESS', 'NO_TAB', 'INJECT_FAILED', 'UNKNOWN']),
  message: z.string(),
  origin: z.string().optional(),
});
export type SnapshotError = z.infer<typeof SnapshotErrorSchema>;

export const SnapshotResponseSchema = z.discriminatedUnion('ok', [
  SnapshotDataSchema,
  SnapshotErrorSchema,
]);
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;

/** ---- M2：网页操作执行 ---- */

export const ActionRequestSchema = z.object({
  type: z.literal('EXECUTE_ACTION'),
  tool: z.string(),
  index: z.number().int().nullable().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  amount: z.number().optional(),
  html: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  lang: z.string().optional(),
  items: z
    .array(z.object({ index: z.number().int(), text: z.string() }))
    .optional(),
  url: z.string().optional(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  urlChanged: z.boolean().optional(),
  newUrl: z.string().optional(),
  data: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

/** ---- 定时任务 ---- */

export const GetTasksRequestSchema = z.object({ type: z.literal('GET_TASKS') });
export type GetTasksRequest = z.infer<typeof GetTasksRequestSchema>;

export const UpsertTaskRequestSchema = z.object({
  type: z.literal('UPSERT_TASK'),
  task: ScheduledTaskSchema,
});
export type UpsertTaskRequest = z.infer<typeof UpsertTaskRequestSchema>;

export const DeleteTaskRequestSchema = z.object({
  type: z.literal('DELETE_TASK'),
  id: z.string().min(1),
});
export type DeleteTaskRequest = z.infer<typeof DeleteTaskRequestSchema>;

export const ToggleTaskRequestSchema = z.object({
  type: z.literal('TOGGLE_TASK'),
  id: z.string().min(1),
  enabled: z.boolean(),
});
export type ToggleTaskRequest = z.infer<typeof ToggleTaskRequestSchema>;

export const RunTaskNowRequestSchema = z.object({
  type: z.literal('RUN_TASK_NOW'),
  id: z.string().min(1),
});
export type RunTaskNowRequest = z.infer<typeof RunTaskNowRequestSchema>;

export const TasksResponseSchema = z.object({
  tasks: z.array(ScheduledTaskSchema),
});
export type TasksResponse = z.infer<typeof TasksResponseSchema>;

export const TaskOpResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  tasks: z.array(ScheduledTaskSchema),
});
export type TaskOpResponse = z.infer<typeof TaskOpResponseSchema>;
