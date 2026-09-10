import type { ProviderConfig } from './providers';
import type { ModelMessage } from './prompts';

export type ChatErrorCode =
  | 'HTTP_401'
  | 'HTTP_403'
  | 'HTTP_404'
  | 'HTTP_429'
  | 'HTTP_OTHER'
  | 'NEED_ORIGIN_PERMISSION'
  | 'NETWORK'
  | 'PARSE'
  | 'ABORT'
  | 'UNKNOWN';

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

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new ChatError('ABORT', 'aborted');
    throw new ChatError(
      'NEED_ORIGIN_PERMISSION',
      `Failed to fetch ${config.baseUrl}. Grant origin access or check the network.`,
    );
  }

  if (!res.ok) {
    await handleHttpError(res, signal);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return await streamSse(res, signal, handlers);
  }
  // 非流式降级：整体返回
  try {
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
  } catch {
    throw new ChatError('PARSE', 'Failed to parse the response.');
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
  handlers: StreamHandlers,
): Promise<{ text: string; toolCalls: RawToolCall[] | null }> {
  if (!res.body) {
    throw new ChatError('PARSE', 'Response has no body.');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const toolAcc = new Map<number, AccCall>();

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
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      flush(lines);
    }
    const tail = decoder.decode();
    if (tail) flush((buffer + tail).split('\n'));
  } catch (err) {
    if (signal.aborted) throw new ChatError('ABORT', 'aborted');
    throw new ChatError('NETWORK', 'Connection lost while streaming.');
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
