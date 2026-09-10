import type { Skill } from './skills';

/** 会话展示消息（不含 system） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 发送给模型的完整消息（含 function calling 的 tool 消息） */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** 页面上下文（来自 background 的 READ_PAGE 响应） */
export interface PageContext {
  title: string;
  url: string;
  body: string;
  bodyTruncated: boolean;
  viewport: string;
  viewportTruncated: boolean;
  selection: string;
  lang: string;
}

export type Lang = 'zh' | 'en';

export function detectLang(uiLang?: string): Lang {
  return uiLang?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const SYSTEM_PROMPTS: Record<Lang, string> = {
  zh: [
    '你是嵌入 Edge 侧边栏的网页助手「执要 Agent」。',
    '规则：',
    '1. 优先基于【当前页面】提供的内容回答；页面没有提供的信息，如实说明并给出可在页面上查看的位置。',
    '2. 当用户要求对页面执行操作时：先调用 snapshot 工具获取交互元素列表，再选择最匹配的元素（用序号 index）调用对应工具。',
    '3. 每次只调用一个工具；执行结果会以【操作结果】消息回传，你再决定下一步。',
    '4. 用户未要求操作时不要调用任何工具，直接回答问题。',
    '5. 输出一律使用纯文本，不使用任何 Markdown 标记：不用 **、#、-、> 等符号；列表用「1. 2. 3.」编号；强调靠句子本身；表格用对齐的空格文本或逐行列出；代码单独成段呈现。',
    '6. 回答简洁、准确，使用与用户提问相同的语言；不要编造页面中不存在的内容。',
  ].join('\n'),
  en: [
    'You are the webpage assistant "ZhiYao Agent" embedded in the Edge sidebar.',
    'Rules:',
    '1. Answer based primarily on the [Current page] content provided; if the page does not contain the information, say so honestly.',
    '2. When the user asks to perform page actions: first call the snapshot tool to get the list of interactive elements, then pick the best match (use its index) and call the corresponding tool.',
    '3. Call only one tool at a time; the result comes back as an [Action result] message, then you decide the next step.',
    '4. Never call tools unless the user asks for an action; answer questions directly.',
    '5. Always reply in plain text with NO Markdown: no **, #, -, >, etc. Use numbered lists like "1. 2. 3."; let sentences carry the emphasis; render tables as space-aligned text or line-by-line; show code as plain blocks.',
    '6. Be concise and accurate, reply in the user\'s language; never fabricate content.',
  ].join('\n'),
};

export function buildSystemPrompt(lang: Lang): string {
  return SYSTEM_PROMPTS[lang];
}

export function buildContextBlock(page: PageContext, lang: Lang): string {
  const zh = lang === 'zh';
  const lines: string[] = [];
  lines.push(zh ? '【当前页面】' : '[Current page]');
  lines.push(`${zh ? '标题' : 'Title'}: ${page.title || '-'}`);
  lines.push(`${zh ? '网址' : 'URL'}: ${page.url || '-'}`);
  if (page.body) {
    lines.push('');
    lines.push(
      `${zh ? '【页面正文' : '[Page body'}${page.bodyTruncated ? (zh ? '（截断）' : ' (truncated)') : ''}${zh ? '】' : ']'}`,
    );
    lines.push(page.body);
  }
  if (page.viewport) {
    lines.push('');
    lines.push(
      `${zh ? '【视口可见文本' : '[Viewport text'}${page.viewportTruncated ? (zh ? '（截断）' : ' (truncated)') : ''}${zh ? '】' : ']'}`,
    );
    lines.push(page.viewport);
  }
  if (page.selection) {
    lines.push('');
    lines.push(`${zh ? '【用户选中的文本】' : '[Selected text]'}`);
    lines.push(page.selection);
  }
  return lines.join('\n');
}

export interface BuildMessagesOptions {
  page?: PageContext | null;
  /** 历史消息（不含 system），取最近若干轮 */
  history?: ChatMessage[];
  userMessage: string;
  lang: Lang;
  /** 已启用的技能（指令注入系统提示词） */
  skills?: Skill[];
}

export function buildSkillBlock(skill: Skill, lang: Lang): string {
  const zh = lang === 'zh';
  const name = zh ? skill.name : (skill.nameEn || skill.name);
  const lines = [`## ${name}`, skill.instructions];
  if (skill.whenToUse) {
    lines.push(`${zh ? '适用场景' : 'When to use'}: ${skill.whenToUse}`);
  }
  return lines.join('\n');
}

export function buildMessages(opts: BuildMessagesOptions): ModelMessage[] {
  const { page, history = [], userMessage, lang, skills = [] } = opts;
  let system = buildSystemPrompt(lang);
  if (skills.length > 0) {
    const blocks = skills.map((s) => buildSkillBlock(s, lang)).join('\n\n');
    system += `\n\n${lang === 'zh' ? '【已启用的技能】' : '[Enabled skills]'}\n${blocks}`;
  }
  const messages: ModelMessage[] = [{ role: 'system', content: system }];
  if (page) {
    messages.push({ role: 'user', content: buildContextBlock(page, lang) });
  }
  messages.push(...history.slice(-12));
  messages.push({ role: 'user', content: userMessage });
  return messages;
}
