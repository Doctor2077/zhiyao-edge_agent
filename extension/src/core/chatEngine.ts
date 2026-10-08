import type { ProviderConfig } from './providers';
import type { ModelMessage } from './prompts';

export type ChatErrorCode =
  | 'HTTP_401'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_429'
  | 'HTTP_OTHER'
  | 'NEED_ORIGIN_PERMISSION'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PARSE'
  | 'ABORT'
  | 'UNKNOWN';

/** 空闲超时：流式期间超过该时长没有任何数据即判定卡死 */
const IDLE_TIMEOUT_MS = 30000;
/** 首包超时：发出请求后等待响应头的上限 */
const FIRST_BYTE_TIMEOUT_MS = 45000;

export class ChatError extends Error {
  code: ChatErrorCode;
  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 模型返回的原始工具调用（OpenAI 兼容格式） */
export interface RawToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamHandlers {
  onDelta(text: string): void;
  onDone(fullText: string, toolCalls?: RawToolCall[] | null): void;
  onError(err: ChatError): void;
}

export interface StreamChatOptions {
  config: ProviderConfig;
  apiKey: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  handlers: StreamHandlers;
  /** 传 tools 启用 function calling */
  tools?: OpenAITool[];
}

export function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 流式直连 OpenAI 兼容 /chat/completions；非流式响应自动降级；支持 function calling。 */
export async function streamChat(opts: StreamChatOptions): Promise<{
  text: string;
  toolCalls: RawToolCall[] | null;
}> {
  const { config, apiKey, messages, signal, handlers, tools } = opts;
  const url = chatEndpoint(config.baseUrl);

  const body: Record<string, unknown> = {
    model: config.activeModel,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) body.tools = tools;

  // 超时保护：外部 signal 与内部超时共用一条中止通道
  const inner = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => inner.abort();
  if (signal.aborted) inner.abort();
  else signal.addEventListener('abort', onOuterAbort, { once: true });
  let firstTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true;
    inner.abort();
  }, FIRST_BYTE_TIMEOUT_MS);

  const clearFirstTimer = () => {
    if (firstTimer) clearTimeout(firstTimer);
    firstTimer = null;
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: inner.signal,
    });
    clearFirstTimer();
  } catch (err) {
    clearFirstTimer();
    signal.removeEventListener('abort', onOuterAbort);
    if (timedOut) {
      throw new ChatError(
        'TIMEOUT',
        `No response within ${Math.round(FIRST_BYTE_TIMEOUT_MS / 1000)}s.`,
      );
    }
    if (signal.aborted) throw new ChatError('ABORT', 'aborted');
    throw new ChatError(
      'NEED_ORIGIN_PERMISSION',
      `Failed to fetch ${config.baseUrl}. Grant origin access or check the network.`,
    );
  }

  if (!res.ok) {
    clearFirstTimer();
    signal.removeEventListener('abort', onOuterAbort);
    await handleHttpError(res, signal);
  }

  const contentType = res.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('text/event-stream')) {
      return await streamSse(
        res,
        inner.signal,
        signal,
        handlers,
        () => {
          timedOut = true;
        },
        () => timedOut,
      );
    }
    // 非流式降级：整体返回
    const json = await res.json();
    const choice = json?.choices?.[0];
    const toolCalls: RawToolCall[] | null = parseToolCalls(choice?.message?.tool_calls);
    const content: string = choice?.message?.content ?? '';
    if (toolCalls && toolCalls.length > 0) {
      handlers.onDone('', toolCalls);
      return { text: '', toolCalls };
    }
    if (content) handlers.onDelta(content);
    handlers.onDone(content, null);
    return { text: content, toolCalls: null };
  } catch (err) {
    if (err instanceof ChatError) throw err;
    if (timedOut) {
      throw new ChatError(
        'TIMEOUT',
        `Stream stalled for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s.`,
      );
    }
    throw new ChatError('PARSE', 'Failed to parse the response.');
  } finally {
    signal.removeEventListener('abort', onOuterAbort);
  }
}

async function handleHttpError(res: Response, signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw new ChatError('ABORT', 'aborted');
  const bodyText = (await res.text().catch(() => '')).slice(0, 300);
  const byStatus: Record<number, [ChatErrorCode, string]> = {
    401: ['HTTP_401', 'Invalid API key. Check the key in Settings.'],
    403: ['HTTP_403', 'Access denied. Check the API key and account quota.'],
    404: ['HTTP_404', 'Endpoint or model not found. Check Base URL and model name.'],
    429: ['HTTP_429', 'Rate limited or insufficient quota. Try again later.'],
  };
  const [code, message] = byStatus[res.status] ?? [
    'HTTP_OTHER',
    `Request failed (HTTP ${res.status}).`,
  ];
  throw new ChatError(code, bodyText ? `${message} ${bodyText}` : message);
}

interface AccCall {
  id: string;
  name: string;
  args: string;
}

async function streamSse(
  res: Response,
  signal: AbortSignal,
  outerSignal: AbortSignal,
  handlers: StreamHandlers,
  markTimedOut: () => void,
  isTimedOut: () => boolean,
): Promise<{ text: string; toolCalls: RawToolCall[] | null }> {
  if (!res.body) {
    throw new ChatError('PARSE', 'Response has no body.');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const toolAcc = new Map<number, AccCall>();
  // 空闲超时：每收到数据就重新计时
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      markTimedOut();
      reader.cancel().catch(() => {});
    }, IDLE_TIMEOUT_MS);
  };
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  armIdle();

  const flush = (lines: string[]) => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta;
        const content: string = delta?.content ?? '';
        if (content) {
          full += content;
          handlers.onDelta(content);
        }
        const tcDeltas: unknown[] = delta?.tool_calls ?? [];
        for (const tc of tcDeltas) {
          if (typeof tc !== 'object' || tc === null) continue;
          const t = tc as {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          const idx = typeof t.index === 'number' ? t.index : 0;
          let acc = toolAcc.get(idx);
          if (!acc) {
            acc = { id: '', name: '', args: '' };
            toolAcc.set(idx, acc);
          }
          if (t.id) acc.id = t.id;
          if (t.function?.name) acc.name = t.function.name;
          if (t.function?.arguments) acc.args += t.function.arguments;
        }
      } catch {
        // 忽略无法解析的行
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      flush(lines);
    }
    const tail = decoder.decode();
    if (tail) flush((buffer + tail).split('\n'));
  } catch (err) {
    if (isTimedOut()) {
      throw new ChatError(
        'TIMEOUT',
        `Stream stalled for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s.`,
      );
    }
    if (signal.aborted || outerSignal.aborted) throw new ChatError('ABORT', 'aborted');
    throw new ChatError('NETWORK', 'Connection lost while streaming.');
  } finally {
    clearIdle();
  }

  const calls: RawToolCall[] = Array.from(toolAcc.values())
    .filter((c) => c.name)
    .map((c) => ({ id: c.id || crypto.randomUUID(), name: c.name, arguments: c.args }));
  if (calls.length > 0) {
    handlers.onDone(full, calls);
    return { text: full, toolCalls: calls };
  }
  handlers.onDone(full, null);
  return { text: full, toolCalls: null };
}

function parseToolCalls(raw: unknown): RawToolCall[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: RawToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    if (t.function?.name) {
      out.push({
        id: t.id || crypto.randomUUID(),
        name: t.function.name,
        arguments: t.function.arguments ?? '{}',
      });
    }
  }
  return out.length > 0 ? out : null;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
}

export interface FetchModelsResult {
  ok: boolean;
  models?: string[];
  message: string;
}

/** 从 OpenAI 兼容的 /models 端点拉取模型列表（设置页「获取模型列表」用） */
export async function fetchModels(
  config: ProviderConfig,
  apiKey: string,
): Promise<FetchModelsResult> {
  try {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, message: `HTTP ${res.status}${text ? ` ${text}` : ''}` };
    }
    const json = (await res.json()) as { data?: unknown };
    const data = json?.data;
    if (!Array.isArray(data)) {
      return { ok: false, message: 'Response is not an OpenAI-compatible model list.' };
    }
    const models = data
      .map((m) => (m as { id?: unknown })?.id)
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .slice(0, 200);
    if (models.length === 0) {
      return { ok: false, message: 'Model list is empty.' };
    }
    return { ok: true, models, message: `${models.length} models` };
  } catch {
    return {
      ok: false,
      message:
        'Cannot reach the /models endpoint. Grant origin access or check the URL.',
    };
  }
}

/** 发送一条最小请求验证 Key / Base URL / 模型名与网络可达性 */
export async function testConnection(
  config: ProviderConfig,
  apiKey: string,
): Promise<TestConnectionResult> {
  const started = Date.now();
  try {
    const res = await fetch(chatEndpoint(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.activeModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      const byStatus: Record<number, string> = {
        401: 'Invalid API key.',
        403: 'Access denied.',
        404: 'Endpoint or model not found.',
        429: 'Rate limited.',
      };
      return {
        ok: false,
        latencyMs,
        message: `${byStatus[res.status] ?? `HTTP ${res.status}`}${text ? ` ${text}` : ''}`,
      };
    }
    return { ok: true, latencyMs, message: 'OK' };
  } catch {
    return {
      ok: false,
      message:
        'Cannot reach this endpoint. Grant origin access (browser prompt) or check the URL.',
    };
  }
}
