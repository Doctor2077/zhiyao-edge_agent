import { browser } from 'wxt/browser';

/**
 * 本地日志：环形缓冲（最多 500 条），持久化到 storage.local。
 * 隐私红线：不记录 API Key、不记录页面正文/对话内容；只记事件与错误摘要。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number;
  level: LogLevel;
  scope: string;
  message: string;
}

const LOGS_KEY = 'logs';
const MAX_LOGS = 500;
const FLUSH_MS = 1000;

let buffer: LogEntry[] | null = null;
let bufferPromise: Promise<LogEntry[]> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 清空代数：clearLogs 后递增，使在途的旧 flush 与旧加载结果全部作废 */
let generation = 0;

function ensureLoaded(): Promise<LogEntry[]> {
  if (buffer) return Promise.resolve(buffer);
  if (!bufferPromise) {
    bufferPromise = (async () => {
      const data = await browser.storage.local.get(LOGS_KEY);
      const loaded = Array.isArray(data[LOGS_KEY]) ? (data[LOGS_KEY] as LogEntry[]) : [];
      // 加载期间若被 clearLogs 清空（buffer 已是新数组），丢弃旧数据
      if (!buffer) buffer = loaded;
      return buffer;
    })();
  }
  return bufferPromise;
}

function scheduleFlush() {
  if (flushTimer) return;
  const gen = generation;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush(gen);
  }, FLUSH_MS);
}

async function flush(gen: number) {
  // 期间发生过 clearLogs：这次写入作废
  if (gen !== generation) return;
  if (!buffer) return;
  await browser.storage.local.set({ [LOGS_KEY]: buffer.slice(-MAX_LOGS) });
}

/** 记录一条日志（异步持久化，去抖 1s） */
export function log(level: LogLevel, scope: string, message: string): void {
  const entry: LogEntry = {
    t: Date.now(),
    level,
    scope,
    message: String(message).slice(0, 1000),
  };
  void ensureLoaded().then(() => {
    if (!buffer) return;
    buffer.push(entry);
    if (buffer.length > MAX_LOGS) buffer = buffer.slice(-MAX_LOGS);
    scheduleFlush();
  });
}

/** 读取日志（最新在前） */
export async function loadLogs(): Promise<LogEntry[]> {
  const b = await ensureLoaded();
  return [...b].reverse();
}

export async function clearLogs(): Promise<void> {
  generation++;
  buffer = [];
  bufferPromise = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await browser.storage.local.remove(LOGS_KEY);
}

export function formatLogs(entries: LogEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => {
      const ts = new Date(e.t).toISOString();
      return `[${ts}] [${e.level.toUpperCase()}] [${e.scope}] ${e.message}`;
    })
    .join('\n');
}

/** 导出为 txt 文件（浏览器下载） */
export async function exportLogs(): Promise<void> {
  const entries = await loadLogs();
  const text = formatLogs(entries) || 'no logs';
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  a.download = `zhiyao-logs-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
