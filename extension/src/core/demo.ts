import type { Lang } from './prompts';

export interface DemoStreamOptions {
  userMessage: string;
  lang: Lang;
  signal: AbortSignal;
  onDelta(text: string): void;
  onDone(fullText: string): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 演示模式：本地 mock 流式回复（供无 Key 走查与商店认证测试） */
export async function demoStream(opts: DemoStreamOptions): Promise<string> {
  const { userMessage, lang, signal, onDelta, onDone } = opts;
  const zh = lang === 'zh';
  const lines = zh
    ? [
        '【演示模式】当前未配置模型服务，以下为本地模拟回复。',
        '',
        `你刚才说：「${userMessage}」`,
        '',
        '配置真实模型后，我会：',
        '1. 读取当前网页的正文、视口可见文本与选中内容；',
        '2. 基于页面内容回答你的问题；',
        '3. 未来版本中，在你逐次确认后协助操作网页。',
        '',
        '请点击右上角「设置」，添加你的 API Key（DeepSeek、OpenAI、Kimi 等均支持）。',
      ]
    : [
        '[Demo mode] No provider is configured, so this reply is simulated locally.',
        '',
        `You said: "${userMessage}"`,
        '',
        'Once a real provider is configured, I will:',
        '1. Read the current page body, viewport text, and your selection;',
        '2. Answer questions based on the page content;',
        '3. In a future version, assist with page actions after your step-by-step confirmation.',
        '',
        'Open Settings (top-right) to add your API key (DeepSeek, OpenAI, Kimi, etc.).',
      ];

  const full = lines.join('\n');
  // 分块模拟流式输出
  const chunkSize = 6;
  for (let i = 0; i < full.length; i += chunkSize) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const chunk = full.slice(i, i + chunkSize);
    onDelta(chunk);
    await sleep(12);
  }
  onDone(full);
  return full;
}
