import { z } from 'zod';
import { browser } from 'wxt/browser';
import type { ChatMessage } from './prompts';

export const SessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 对话发生时的页面地址 */
  url: z.string().optional(),
  /** 对话发生时的页面标题 */
  siteTitle: z.string().optional(),
  messages: z.array(
    z.object({ role: z.enum(['user', 'assistant']), content: z.string() }),
  ),
});
export type Session = z.infer<typeof SessionSchema>;

const SESSIONS_KEY = 'sessions';
const MAX_SESSIONS = 100;

export async function loadSessions(): Promise<Session[]> {
  const data = await browser.storage.local.get(SESSIONS_KEY);
  const parsed = z.array(SessionSchema).safeParse(data[SESSIONS_KEY]);
  return parsed.success ? parsed.data : [];
}

export async function saveSession(session: Session): Promise<void> {
  const sessions = await loadSessions();
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.unshift(session);
  // 裁剪最旧的会话，控制存储占用
  const trimmed = sessions.slice(0, MAX_SESSIONS);
  await browser.storage.local.set({ [SESSIONS_KEY]: trimmed });
}

export async function deleteSession(id: string): Promise<void> {
  const sessions = await loadSessions();
  await browser.storage.local.set({
    [SESSIONS_KEY]: sessions.filter((s) => s.id !== id),
  });
}

export async function clearSessions(): Promise<void> {
  await browser.storage.local.remove(SESSIONS_KEY);
}

export function createSession(
  title: string,
  site?: { url?: string; siteTitle?: string },
): Session {
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: site?.url,
    siteTitle: site?.siteTitle,
    messages: [],
  };
}

export function appendMessages(session: Session, messages: ChatMessage[]): Session {
  const isDialogue = (
    m: ChatMessage,
  ): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system';
  const next: Session = {
    ...session,
    updatedAt: Date.now(),
    messages: [...session.messages, ...messages.filter(isDialogue)],
  };
  // 用第一条用户消息作为会话标题
  if (!next.title || next.title === 'Untitled') {
    const firstUser = next.messages.find((m) => m.role === 'user');
    if (firstUser) next.title = firstUser.content.slice(0, 60);
  }
  return next;
}
