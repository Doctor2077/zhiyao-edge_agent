import { browser } from 'wxt/browser';
import {
  ReadPageRequestSchema,
  ReadPageResponseSchema,
  type ReadPageRequest,
  type ReadPageResponse,
} from './protocol';

/** 请求 background 读取当前活动标签页的页面上下文 */
export async function readCurrentPage(
  req: Partial<Omit<ReadPageRequest, 'type'>> = {},
): Promise<ReadPageResponse> {
  const payload = ReadPageRequestSchema.parse({ type: 'READ_PAGE', ...req });
  const raw: unknown = await browser.runtime.sendMessage(payload);
  const parsed = ReadPageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'Unexpected response from background.',
    };
  }
  return parsed.data;
}
