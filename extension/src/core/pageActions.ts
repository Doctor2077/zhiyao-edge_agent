import { browser } from 'wxt/browser';
import {
  ActionRequestSchema,
  ActionResultSchema,
  SnapshotRequestSchema,
  SnapshotResponseSchema,
  type ActionRequest,
  type ActionResult,
  type SnapshotRequest,
  type SnapshotResponse,
} from './protocol';

/** 请求 background 采集当前页面的交互元素快照 */
export async function getSnapshot(
  req: Partial<Omit<SnapshotRequest, 'type'>> = {},
): Promise<SnapshotResponse> {
  const payload = SnapshotRequestSchema.parse({ type: 'GET_SNAPSHOT', ...req });
  const raw: unknown = await browser.runtime.sendMessage(payload);
  const parsed = SnapshotResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'UNKNOWN', message: 'Unexpected response from background.' };
  }
  return parsed.data;
}

/** 请求 background 在当前页面执行白名单操作 */
export async function executeAction(
  req: Omit<ActionRequest, 'type'>,
): Promise<ActionResult> {
  const payload = ActionRequestSchema.parse({ type: 'EXECUTE_ACTION', ...req });
  const raw: unknown = await browser.runtime.sendMessage(payload);
  const parsed = ActionResultSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: 'Unexpected response from background.' };
  }
  return parsed.data;
}

/** 打开新标签页（可信上下文直接调用） */
export async function openInNewTab(url: string): Promise<ActionResult> {
  try {
    await browser.tabs.create({ url });
    return { ok: true, message: '已在后台标签页打开', urlChanged: false };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}
