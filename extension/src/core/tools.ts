import type { SnapshotElement } from './protocol';

export type RiskLevel = 1 | 2 | 3;

export interface ToolDef {
  name: string;
  /** 模型可读的中文描述（function calling 用） */
  description: string;
  /** 风险等级：1=只读/内部，2=修改/点击，3=高风险（提交/删除类语义由模型上下文判断，此处按动作定级） */
  risk: RiskLevel;
  /** 是否需要定位目标元素（index/selector） */
  needsTarget: boolean;
  /** 是否需要用户逐步确认（snapshot 为内部自动执行） */
  confirmRequired: boolean;
  /** function calling 参数 schema */
  parameters: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'snapshot',
    description:
      '重新获取当前页面的交互元素快照（列表，含每个元素的序号 i、标签、文本、位置、选择器）。在需要操作页面前先调用。',
    risk: 1,
    needsTarget: false,
    confirmRequired: false,
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'click',
    description: '点击页面元素。用快照中的序号 index（首选），或用 selector。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '快照中元素的序号 i' },
        selector: { type: 'string', description: 'CSS 选择器（index 不可用时）' },
      },
    },
  },
  {
    name: 'type',
    description: '在输入框/文本域中输入文本。text 为要输入的完整内容。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '快照中元素的序号 i' },
        selector: { type: 'string' },
        text: { type: 'string', description: '要输入的完整文本' },
      },
      required: ['text'],
    },
  },
  {
    name: 'select',
    description: '在下拉框中选择选项，或为其他控件设置值。text 为选项值或显示文本。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        selector: { type: 'string' },
        text: { type: 'string', description: '选项的值或显示文本' },
      },
      required: ['text'],
    },
  },
  {
    name: 'scroll',
    description: '滚动页面。amount 为正向下滚动，为负向上滚动（像素）。',
    risk: 1,
    needsTarget: false,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { amount: { type: 'number', description: '滚动像素，正=向下' } },
      required: ['amount'],
    },
  },
  {
    name: 'read_text',
    description: '读取页面元素的文本内容。',
    risk: 1,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, selector: { type: 'string' } },
    },
  },
  {
    name: 'read_html',
    description: '读取页面元素的 HTML 片段（有界截断）。',
    risk: 1,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, selector: { type: 'string' } },
    },
  },
  {
    name: 'page_source',
    description:
      '读取整页 HTML 源码（已去除 script/style 等无关内容，有界截断）。用户要求查看源代码、排查页面结构时使用。',
    risk: 1,
    needsTarget: false,
    confirmRequired: false,
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'extract_table',
    description: '把元素所在表格提取为 CSV 文本。',
    risk: 1,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, selector: { type: 'string' } },
    },
  },
  {
    name: 'copy',
    description: '把元素的文本内容复制到剪贴板。',
    risk: 1,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, selector: { type: 'string' } },
    },
  },
  {
    name: 'edit_text',
    description:
      '修改页面元素的文字内容（仅本机生效，刷新即恢复）。text 为新的完整文字。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        selector: { type: 'string' },
        text: { type: 'string', description: '新的完整文字内容' },
      },
      required: ['text'],
    },
  },
  {
    name: 'edit_html',
    description:
      '替换页面元素的内部 HTML（仅本机生效；脚本与事件属性会被自动清除）。html 为新的 HTML 片段。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        selector: { type: 'string' },
        html: { type: 'string', description: '新的 HTML 片段' },
      },
      required: ['html'],
    },
  },
  {
    name: 'set_attribute',
    description: '设置页面元素的属性（如 class、style、href；on 开头的事件属性被禁止）。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        selector: { type: 'string' },
        name: { type: 'string', description: '属性名（on* 事件属性被拒绝）' },
        value: { type: 'string', description: '属性值' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'remove_element',
    description: '从页面移除元素（如广告区块、干扰横幅；仅本机生效）。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, selector: { type: 'string' } },
    },
  },
  {
    name: 'hide_element',
    description: '隐藏页面元素（display:none，可移除弹窗遮挡；仅本机生效）。',
    risk: 2,
    needsTarget: true,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, selector: { type: 'string' } },
    },
  },
  {
    name: 'get_texts',
    description:
      '获取页面上文字元素的清单（序号 index、标签、原文）。整页翻译替换前必须先调用本工具取得原文。',
    risk: 1,
    needsTarget: false,
    confirmRequired: false,
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'translate_page',
    description:
      '按清单批量把页面文字替换为译文（仅本机生效，刷新恢复）。lang 为目标语言；items_json 为 [{index, text}] 的 JSON 字符串，index 对应 get_texts 返回的序号，text 为该元素的完整译文。每批建议 80-100 条；清单总数超过一批时，必须连续多次调用本工具，直到覆盖清单全部条目。',
    risk: 2,
    needsTarget: false,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        lang: { type: 'string', description: '目标语言，如 中文/English' },
        items_json: {
          type: 'string',
          description: '译文清单的 JSON 字符串，如 [{"index":0,"text":"你好"}]',
        },
      },
      required: ['lang', 'items_json'],
    },
  },
  {
    name: 'get_media',
    description:
      '探测页面上的媒体资源（video/audio 元素与 .mp4/.mp3 等直链），返回清单（序号、类型、URL）。下载前必须先调用本工具。',
    risk: 1,
    needsTarget: false,
    confirmRequired: false,
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'download_media',
    description:
      '用浏览器下载器下载一个媒体直链。url 为 get_media 返回清单中的完整 http(s) 地址。仅支持页面直接提供的资源；不支持 DRM/流媒体分片。',
    risk: 2,
    needsTarget: false,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '媒体文件的完整 http(s) 直链' },
      },
      required: ['url'],
    },
  },
  {
    name: 'open_in_new_tab',
    description: '在新标签页打开一个 http(s) 链接。text 为完整 URL。',
    risk: 2,
    needsTarget: false,
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '完整 http(s) URL' } },
      required: ['text'],
    },
  },
];

export interface ToolCallArgs {
  index?: number | null;
  selector?: string;
  text?: string;
  amount?: number;
  html?: string;
  name?: string;
  value?: string;
  lang?: string;
  items?: Array<{ index: number; text: string }>;
  url?: string;
}

export interface ToolCall {
  tool: string;
  args: ToolCallArgs;
}

export interface ToolCallValidation {
  ok: boolean;
  call?: ToolCall;
  error?: string;
}

export function findTool(name: string): ToolDef | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/** 白名单校验：模型输出必须落在注册表中，参数必须符合约束 */
export function validateToolCall(raw: unknown): ToolCallValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: '工具调用不是对象' };
  }
  const name = (raw as { tool?: unknown }).tool;
  if (typeof name !== 'string') {
    return { ok: false, error: '缺少工具名' };
  }
  const tool = findTool(name);
  if (!tool) {
    return { ok: false, error: `不在白名单内：${name}` };
  }
  const argsRaw = (raw as { args?: unknown }).args;
  const args: ToolCallArgs =
    typeof argsRaw === 'object' && argsRaw !== null
      ? { ...(argsRaw as Record<string, unknown>) }
      : {};

  if (tool.needsTarget) {
    const hasIndex =
      typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0;
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    if (!hasIndex && !hasSelector) {
      return { ok: false, error: `${name} 需要 index 或 selector` };
    }
    if (!hasIndex) delete args.index;
  }
  if (name === 'type' || name === 'select' || name === 'open_in_new_tab') {
    if (typeof args.text !== 'string' || args.text.trim().length === 0) {
      return { ok: false, error: `${name} 需要 text` };
    }
    if (args.text.length > 2000) {
      return { ok: false, error: 'text 过长（>2000 字符）' };
    }
    // 新标签页只允许 http(s)，防止 data:/file:/chrome: 等协议
    if (name === 'open_in_new_tab' && !/^https?:\/\//i.test(args.text.trim())) {
      return { ok: false, error: 'open_in_new_tab 只允许 http(s) 链接' };
    }
  }
  if (name === 'edit_text') {
    if (typeof args.text !== 'string' || args.text.length === 0) {
      return { ok: false, error: 'edit_text 需要 text' };
    }
    if (args.text.length > 2000) {
      return { ok: false, error: 'text 过长（>2000 字符）' };
    }
  }
  if (name === 'edit_html') {
    if (typeof args.html !== 'string' || args.html.trim().length === 0) {
      return { ok: false, error: 'edit_html 需要 html' };
    }
    if (args.html.length > 20000) {
      return { ok: false, error: 'html 过长（>20000 字符）' };
    }
  }
  if (name === 'set_attribute') {
    if (typeof args.name !== 'string' || args.name.length === 0 || args.name.length > 64) {
      return { ok: false, error: 'set_attribute 需要合法的属性名' };
    }
    // 事件属性、srcdoc/formaction 一律拒绝（srcdoc 可注入同源脚本）
    if (/^on/i.test(args.name) || /^(srcdoc|formaction)$/i.test(args.name)) {
      return { ok: false, error: '该属性被禁止' };
    }
    if (typeof args.value !== 'string' || args.value.length > 4000) {
      return { ok: false, error: 'set_attribute 需要 value（≤4000 字符）' };
    }
    // URL 类属性只允许 http(s)/相对地址，阻断 javascript:/data: 注入
    if (
      /^(href|src|xlink:href|action|poster)$/i.test(args.name) &&
      /^\s*(javascript|vbscript|data):/i.test(args.value)
    ) {
      return { ok: false, error: 'URL 类属性仅允许 http(s) 或相对地址' };
    }
  }
  if (name === 'translate_page') {
    if (typeof args.lang !== 'string' || args.lang.length === 0 || args.lang.length > 16) {
      return { ok: false, error: 'translate_page 需要 lang' };
    }
    // 接受两种形态：items（数组，兼容旧行为）或 items_json（字符串，推荐传输形态）
    let rawItems: unknown = args.items;
    const itemsJson = (args as { items_json?: unknown }).items_json;
    if ((!Array.isArray(rawItems) || rawItems.length === 0) && typeof itemsJson === 'string') {
      try {
        rawItems = JSON.parse(itemsJson);
      } catch {
        return { ok: false, error: 'items_json 不是合法的 JSON 字符串' };
      }
    }
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 1000) {
      return { ok: false, error: 'translate_page 需要 items_json（1-1000 条）' };
    }
    const items: Array<{ index: number; text: string }> = [];
    for (const it of rawItems) {
      if (typeof it !== 'object' || it === null) {
        return { ok: false, error: 'items 条目格式错误' };
      }
      const o = it as { index?: unknown; text?: unknown };
      if (typeof o.index !== 'number' || !Number.isInteger(o.index) || o.index < 0) {
        return { ok: false, error: 'items[index] 必须是整数' };
      }
      if (typeof o.text !== 'string' || o.text.length === 0 || o.text.length > 1500) {
        return { ok: false, error: 'items[text] 需为 1-1500 字符' };
      }
      items.push({ index: o.index, text: o.text });
    }
    args.items = items;
  }
  if (name === 'download_media') {
    if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) {
      return { ok: false, error: 'download_media 需要合法的 http(s) url' };
    }
    if (args.url.length > 2000) {
      return { ok: false, error: 'url 过长' };
    }
  }
  if (name === 'scroll') {
    if (typeof args.amount !== 'number' || !Number.isFinite(args.amount)) {
      return { ok: false, error: 'scroll 需要数值 amount' };
    }
    args.amount = Math.max(-5000, Math.min(5000, args.amount));
  }
  return { ok: true, call: { tool: name, args } };
}

/** 从快照找目标元素描述（确认卡片用） */
export function elementDesc(
  args: ToolCallArgs,
  elements?: SnapshotElement[] | null,
): string {
  if (typeof args.index === 'number' && elements) {
    const el = elements[args.index];
    if (el) {
      const label = el.text || el.aria || `<${el.tag}>`;
      return `${label} (${el.tag}${el.selector ? ', ' + el.selector : ''})`;
    }
  }
  if (args.selector) return args.selector;
  return '';
}

/** function calling 的 tools 参数 */
export function toOpenAITools(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
