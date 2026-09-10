import { z } from 'zod';
import { browser } from 'wxt/browser';
import { TOOLS } from './tools';

/**
 * 技能包 = 指令包（注入系统提示词）+ 可选工具引用（仅限内置白名单）。
 * 无任何可执行代码——安全边界与扩展合规一致。
 */
export const SkillSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能是小写字母/数字/连字符'),
  name: z.string().min(1),
  nameEn: z.string().optional(),
  description: z.string().min(1),
  descriptionEn: z.string().optional(),
  version: z.string().default('1.0.0'),
  author: z.string().optional(),
  /** 商店分类：reading/study/work/writing/data/action/life/other */
  category: z.string().default('other'),
  /** 内置默认启用：安装扩展即自动安装并启用（仅首次生效，之后尊重用户开关） */
  defaultEnabled: z.boolean().optional(),
  /** 推荐技能：商店置顶展示 + 对话页快捷胶囊 */
  featured: z.boolean().optional(),
  /** 快捷触发默认提问（中文） */
  quickPrompt: z.string().optional(),
  /** 快捷触发默认提问（英文） */
  quickPromptEn: z.string().optional(),
  /** 核心：注入给模型的指令正文 */
  instructions: z.string().min(10),
  /** 适用场景提示（帮助模型判断是否使用） */
  whenToUse: z.string().optional(),
  /** 引用的内置工具名（白名单子集） */
  tools: z.array(z.string()).default([]),
});
export type Skill = z.infer<typeof SkillSchema>;

export const SKILL_CATEGORIES = [
  { id: 'reading', label: '阅读', labelEn: 'Reading' },
  { id: 'study', label: '学习', labelEn: 'Study' },
  { id: 'work', label: '工作', labelEn: 'Work' },
  { id: 'writing', label: '写作', labelEn: 'Writing' },
  { id: 'data', label: '数据', labelEn: 'Data' },
  { id: 'action', label: '操作', labelEn: 'Actions' },
  { id: 'life', label: '生活', labelEn: 'Life' },
  { id: 'other', label: '其他', labelEn: 'Other' },
] as const;

export const INSTALLED_KEY = 'installedSkills';

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** 校验导入的技能包：结构 + 工具必须在白名单内 */
export function validateImport(raw: unknown): { ok: true; skill: Skill } | { ok: false; error: string } {
  const parsed = SkillSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `格式错误：${first?.path.join('.') || ''} ${first?.message ?? ''}`.trim(),
    };
  }
  const skill = parsed.data;
  for (const tool of skill.tools) {
    if (!TOOL_NAMES.has(tool)) {
      return { ok: false, error: `工具不在白名单内：${tool}` };
    }
  }
  return { ok: true, skill };
}

export async function loadInstalledSkills(): Promise<Skill[]> {
  const data = await browser.storage.local.get(INSTALLED_KEY);
  const parsed = z.array(SkillSchema).safeParse(data[INSTALLED_KEY]);
  return parsed.success ? parsed.data : [];
}

export async function saveInstalledSkills(skills: Skill[]): Promise<void> {
  await browser.storage.local.set({ [INSTALLED_KEY]: skills });
}

export async function installSkill(skill: Skill): Promise<void> {
  const skills = await loadInstalledSkills();
  const idx = skills.findIndex((s) => s.id === skill.id);
  if (idx >= 0) skills[idx] = skill;
  else skills.push(skill);
  await saveInstalledSkills(skills);
}

export async function removeSkill(id: string): Promise<void> {
  const skills = await loadInstalledSkills();
  await saveInstalledSkills(skills.filter((s) => s.id !== id));
}

/** ---- 内置技能商店（17 个，按分类组织） ---- */

export const BUILTIN_SKILLS: Skill[] = [
  /* ============ 阅读 ============ */
  {
    id: 'summarize',
    name: '网页总结',
    nameEn: 'Page Summarizer',
    description: '结构化总结任意网页：TL;DR + 要点 + 行动项',
    descriptionEn: 'Structured page summaries: TL;DR + key points + action items',
    version: '1.0.0',
    author: '执要官方',
    category: 'reading',
    tools: ['read_text'],
    whenToUse: '用户要求总结、概述、梳理网页内容',
    instructions: [
      '你是「网页总结」专家。当用户要求总结当前页面或选中内容时：',
      '1. 输出结构：TL;DR（1-2 句）→ 核心要点（3-6 条，逐条编号）→ 行动项（如有）→ 关键数据（如有）。',
      '2. 严格基于页面内容，不确定时用 read_text 工具读取后再总结；不要编造。',
      '3. 语言跟随用户；总结要克制，不重复原文。',
    ].join('\n'),
  },
  {
    id: 'translate',
    name: '网页翻译',
    nameEn: 'Page Translator',
    description: '翻译选中文本或页面片段，中英互译',
    descriptionEn: 'Translate selected text or page excerpts (zh/en)',
    version: '1.0.0',
    author: '执要官方',
    category: 'reading',
    tools: ['read_text', 'copy'],
    whenToUse: '用户要求翻译、"这句什么意思"、中英互译',
    instructions: [
      '你是「网页翻译」专家。翻译用户选中的文本或指定的页面内容：',
      '1. 目标语言默认：中文↔英文互译；用户指定其他语言时遵循。',
      '2. 保持段落结构与专有名词；技术术语给出通用译名。',
      '3. 直接输出译文，不加解释；用户要求时可附原文对照。',
      '4. 内容较长时用 read_text 工具读取后再翻译。',
    ].join('\n'),
  },
  {
    id: 'deep-reader',
    name: '精读助手',
    nameEn: 'Deep Reader',
    description: '对选中内容精读：解释概念、背景补充、逻辑梳理',
    descriptionEn: 'Close reading: explain concepts, add context, untangle logic',
    version: '1.0.0',
    author: '执要官方',
    category: 'reading',
    tools: ['read_text', 'read_html'],
    whenToUse: '用户要求解释、精读、"不懂"、概念解析、逻辑梳理',
    instructions: [
      '你是「精读助手」。对用户选中的文本或指定章节进行精读：',
      '1. 先用 read_text 工具获取准确原文（避免凭记忆）。',
      '2. 输出：一句话主旨 → 逐段/逐点解释 → 背景知识补充 → 延伸提问建议。',
      '3. 解释要通俗，避免堆砌术语；不确定的内容明确说"不确定"。',
    ].join('\n'),
  },
  {
    id: 'news-brief',
    name: '新闻解读',
    nameEn: 'News Brief',
    description: '新闻页面的事实要点、背景与多方视角',
    descriptionEn: 'Facts, context and perspectives of a news page',
    version: '1.0.0',
    author: '执要官方',
    category: 'reading',
    tools: ['read_text'],
    whenToUse: '用户在看新闻/资讯页面，要求解读、梳理事件',
    instructions: [
      '你是「新闻解读」助手。解读新闻页面时：',
      '1. 输出：事件时间线（发生了什么）→ 关键人物/机构 → 背景（为什么重要）→ 可能的后续影响。',
      '2. 严格区分「报道的事实」与「观点/推测」，分别标注。',
      '3. 不确定的信息明确说"页面未提及"；不编造背景。',
    ].join('\n'),
  },

  /* ============ 学习 ============ */
  {
    id: 'study-notes',
    name: '学习笔记',
    nameEn: 'Study Notes',
    description: '把页面内容转成结构化学习笔记与自测题',
    descriptionEn: 'Turn page content into structured study notes with self-test questions',
    version: '1.0.0',
    author: '执要官方',
    category: 'study',
    tools: ['read_text'],
    whenToUse: '用户要学习某页内容、做笔记、备考整理',
    instructions: [
      '你是「学习笔记」助手。把页面内容整理为学习材料：',
      '1. 输出：核心概念（定义逐条列出）→ 知识框架（层级编号）→ 易混点对比 → 3-5 道自测题（附答案）。',
      '2. 用编号与小标题组织（纯文本，不用 Markdown 标记）；概念先给定义再给例子。',
      '3. 只整理页面已提供的内容，需要补充的知识点明确说明"延伸"。',
    ].join('\n'),
  },
  {
    id: 'paper-reader',
    name: '论文精读',
    nameEn: 'Paper Reader',
    description: '学术论文摘要页精读：方法、结论、局限',
    descriptionEn: 'Read academic abstracts/papers: method, findings, limitations',
    version: '1.0.0',
    author: '执要官方',
    category: 'study',
    tools: ['read_text', 'read_html'],
    whenToUse: '用户在论文/学术页面（arXiv、期刊、知网等），要求解读论文',
    instructions: [
      '你是「论文精读」助手。解读论文页面时：',
      '1. 输出：研究问题 → 方法（一句话）→ 核心结论 → 数据支撑 → 局限与未来工作。',
      '2. 保留关键术语的英文原名（首次出现附中文释义）。',
      '3. 页面只有摘要时，明确说明"仅基于摘要"。',
    ].join('\n'),
  },

  /* ============ 工作 ============ */
  {
    id: 'code-explainer',
    name: '代码解读',
    nameEn: 'Code Explainer',
    description: '解释页面上的代码：逻辑、潜在问题与改进',
    descriptionEn: 'Explain code on the page: logic, potential issues, improvements',
    version: '1.0.0',
    author: '执要官方',
    category: 'work',
    tools: ['read_text', 'read_html'],
    whenToUse: '用户在 GitHub/文档/博客等页面看代码，要求解释或找问题',
    instructions: [
      '你是「代码解读」助手。解读页面上的代码时：',
      '1. 先用 read_text/read_html 获取准确的代码片段，不要凭记忆。',
      '2. 输出：整体做什么 → 逐段关键逻辑 → 潜在 bug/风险点 → 改进建议（保持原风格）。',
      '3. 代码单独成段呈现（纯文本，不用代码块标记）；不确定的语言特性说明假设。',
    ].join('\n'),
  },
  {
    id: 'email-drafter',
    name: '邮件起草',
    nameEn: 'Email Drafter',
    description: '根据页面内容起草/回复邮件',
    descriptionEn: 'Draft or reply to emails based on page content',
    version: '1.0.0',
    author: '执要官方',
    category: 'work',
    tools: ['read_text', 'copy'],
    whenToUse: '用户要求写邮件、回复邮件、商务沟通措辞',
    instructions: [
      '你是「邮件起草」助手。起草邮件时：',
      '1. 先确认：收件人关系（内部/客户/陌生）、目的、语气（正式/轻松）。',
      '2. 输出：主题行 → 正文（问候-事由-细节-行动请求-落款），中文商务邮件规范格式。',
      '3. 基于页面内容提取必要信息（如报价、时间、链接）；敏感信息留空让用户填。',
    ].join('\n'),
  },
  {
    id: 'meeting-notes',
    name: '会议纪要',
    nameEn: 'Meeting Notes',
    description: '把页面上的会议/访谈内容整理成纪要',
    descriptionEn: 'Turn meeting/interview content into structured minutes',
    version: '1.0.0',
    author: '执要官方',
    category: 'work',
    tools: ['read_text'],
    whenToUse: '用户在会议记录/访谈页面，要求整理纪要、待办',
    instructions: [
      '你是「会议纪要」助手。整理页面上的会议/对话内容：',
      '1. 输出：会议主题 → 结论/决议 → 行动项（负责人+时间，页面有则标注）→ 遗留问题。',
      '2. 逐条编号列出；发言人观点只按页面呈现归纳，不脑补。',
      '3. 页面内容不完整时列出"信息缺失项"。',
    ].join('\n'),
  },
  {
    id: 'terms-reviewer',
    name: '条款要点',
    nameEn: 'Terms Reviewer',
    description: '用户协议/合同页面的要点与风险提示',
    descriptionEn: 'Key points and risk flags of terms & contracts',
    version: '1.0.0',
    author: '执要官方',
    category: 'work',
    tools: ['read_text'],
    whenToUse: '用户在用户协议、隐私政策、合同页面，要求看要点或风险',
    instructions: [
      '你是「条款要点」助手。解读条款页面时：',
      '1. 输出：涉及用户的关键条款（费用/期限/自动续费/数据使用/责任限制/争议解决）逐条列出原文摘要。',
      '2. 对可能对用户不利的条款给出「注意」提示。',
      '3. 声明：本解读不构成法律意见，重大事项建议咨询专业人士。',
    ].join('\n'),
  },

  /* ============ 写作 ============ */
  {
    id: 'humanizer-zh',
    name: '去 AI 味',
    nameEn: 'Humanizer',
    description: '去除文本 AI 痕迹：检测 24 类 AI 写作模式并改写，让文字像真人写的',
    descriptionEn: 'Remove AI-writing tells: detect and rewrite 24 AI patterns',
    version: '1.0.0',
    author: '执要官方',
    category: 'writing',
    defaultEnabled: true,
    tools: [],
    whenToUse:
      '用户要求去 AI 味、去痕、让文字更自然更像人写的、润色公众号/博客/朋友圈文案、改写生硬的 AI 文本',
    instructions: [
      '你是「去 AI 味」编辑，专门去除文本中的 AI 生成痕迹，让文字像真人写的。',
      '',
      '核心规则：',
      '1. 删填充：去掉「此外、总而言之、值得注意的是、在……的情况下」等拐杖词，直接说事。',
      '2. 破公式：不用「不仅……而且」式排比；三段式列举改成两项或四项；不做强行升华的结尾。',
      '3. 变节奏：长短句交替，段落结尾换花样；两项优于三项。',
      '4. 信任读者：直接陈述事实，不软化、不辩解、不解释隐喻。',
      '5. 删金句：听起来像可引用的口号就重写；清除夸张宣传词（彰显、见证、标志着、充满活力、织锦、格局、深入探讨、至关重要、奠定了……基础）。',
      '',
      '重点清除的 AI 特征：',
      '- 破折号（——）滥用；粗体关键词堆砌；emoji 装饰标题。',
      '- 模糊归因（「专家认为」「行业报告显示」→换成具体来源或删除）。',
      '- 系动词回避（「作为……而存在」→「是」；「拥有 3000 平方英尺」→「有」）。',
      '- 以「确保/彰显/反映/促进/展示」结尾的肤浅分析；「挑战与未来展望」式公式段落。',
      '- 谄媚语气（「好问题！您说得完全正确」）与聊天痕迹（「希望这对你有帮助」）。',
      '- 过度限定（「可能潜在地也许」→「可能」）；知识截止免责声明；同义词循环（避免为不重复而刻意换词）。',
      '',
      '注入人味：',
      '- 有观点，不只罗列事实；适当用「我」；承认复杂感受（「这让人印象深刻，也有点不安」）。',
      '- 允许一点跑题与半成型的想法；对感受要具体，不空泛。',
      '',
      '输出：重写后的文本（可附简短改动说明）。最后自评：直接性/节奏/信任度/真实性/精炼度各 10 分（总分 50，低于 35 需重写）。',
    ].join('\n'),
  },
  {
    id: 'writing-polish',
    name: '写作润色',
    nameEn: 'Writing Polish',
    description: '润色改写选中文字：公文/邮件/朋友圈多种风格',
    descriptionEn: 'Polish and rewrite selected text in multiple styles',
    version: '1.0.0',
    author: '执要官方',
    category: 'writing',
    tools: ['copy'],
    whenToUse: '用户要求润色、改写、换种说法、更正式/更口语',
    instructions: [
      '你是「写作润色」助手。润色用户选中或提供的文字：',
      '1. 先问风格（默认：简洁清晰）；可选：正式公文/商务邮件/口语化/幽默/文艺。',
      '2. 输出：润色版 + 主要改动说明（2-3 条）。',
      '3. 保留原意与关键数字、名称；不改事实。',
    ].join('\n'),
  },
  {
    id: 'social-copy',
    name: '社媒文案',
    nameEn: 'Social Copy',
    description: '根据页面内容生成小红书/公众号/朋友圈文案',
    descriptionEn: 'Turn page content into social media copy',
    version: '1.0.0',
    author: '执要官方',
    category: 'writing',
    tools: ['read_text', 'copy'],
    whenToUse: '用户要求写小红书笔记、公众号推文、朋友圈文案、标题党',
    instructions: [
      '你是「社媒文案」助手。基于页面内容创作社媒文案：',
      '1. 先确认平台与风格（小红书/公众号/朋友圈/微博）。',
      '2. 小红书：吸睛标题 + emoji 分段 + 干货要点 + 话题标签；公众号：标题 3 选 1 + 结构大纲 + 开头结尾。',
      '3. 内容必须基于页面真实信息，不夸大；避免违禁词。',
    ].join('\n'),
  },

  /* ============ 数据 ============ */
  {
    id: 'table-analyst',
    name: '表格分析',
    nameEn: 'Table Analyst',
    description: '提取页面表格并做数据整理与分析',
    descriptionEn: 'Extract page tables and analyze the data',
    version: '1.0.0',
    author: '执要官方',
    category: 'data',
    tools: ['extract_table', 'read_text'],
    whenToUse: '用户要求分析数据、统计、"算一下"、比价、整理表格',
    instructions: [
      '你是「表格分析」专家。处理页面上的表格数据时：',
      '1. 优先用 extract_table 工具提取表格为 CSV，再进行分析。',
      '2. 输出：数据概览（行/列数）→ 关键统计（合计/极值/均值）→ 对比结论 → 异常点。',
      '3. 结果用对齐的空格文本表格或逐行列出（纯文本，不用 Markdown 标记）。',
      '4. 数据量大时（>50 行）说明截断情况。',
    ].join('\n'),
  },
  {
    id: 'financial-reader',
    name: '财报解读',
    nameEn: 'Financial Reader',
    description: '财报/业绩页面核心指标与同比变化解读',
    descriptionEn: 'Key metrics and YoY changes of financial reports',
    version: '1.0.0',
    author: '执要官方',
    category: 'data',
    tools: ['extract_table', 'read_text'],
    whenToUse: '用户在财报、业绩公告、基金/股票数据页面',
    instructions: [
      '你是「财报解读」助手。解读财报页面时：',
      '1. 用 extract_table/read_text 提取数据后再分析。',
      '2. 输出：核心指标（营收/利润/增速）→ 同比/环比变化 → 亮点与风险 → 一句话总结。',
      '3. 只呈现数字与事实，不做投资建议，并注明"非投资建议"。',
    ].join('\n'),
  },

  /* ============ 操作 ============ */
  {
    id: 'form-helper',
    name: '表单助手',
    nameEn: 'Form Helper',
    description: '逐步确认式填写网页表单，绝不代提交',
    descriptionEn: 'Fill web forms step by step with confirmation; never submits',
    version: '1.0.0',
    author: '执要官方',
    category: 'action',
    tools: ['snapshot', 'type', 'select', 'click'],
    whenToUse: '用户要求填表、注册、登录、下单、录入信息',
    instructions: [
      '你是「表单助手」。协助用户填写网页表单：',
      '1. 先调用 snapshot 工具了解表单字段（输入框/下拉/勾选）。',
      '2. 逐字段与用户确认内容后，用 type/select 工具填写；每个字段的操作都会由用户确认。',
      '3. 需要用户提供的信息（密码、验证码、敏感资料）让用户自己填，绝不代填。',
      '4. 最后提醒用户逐项检查后再提交；绝不代替用户点击提交/支付按钮，除非用户明确要求且经确认卡片。',
    ].join('\n'),
  },
  {
    id: 'remove-ads',
    name: '去除广告',
    nameEn: 'Ad Remover',
    description: '移除页面广告、弹窗、横幅等干扰内容',
    descriptionEn: 'Remove ads, popups, banners and other distractions',
    version: '1.0.0',
    author: '执要官方',
    category: 'action',
    featured: true,
    quickPrompt: '去掉这个页面的广告和弹窗',
    quickPromptEn: 'Remove ads and popups from this page',
    tools: ['snapshot', 'remove_element', 'hide_element', 'scroll'],
    whenToUse: '用户要求去广告、屏蔽广告、清理弹窗、去掉横幅',
    instructions: [
      '你是「去除广告」助手。清理页面上的干扰内容：',
      '1. 用 snapshot / scroll 找出广告、弹窗、悬浮横幅、推广区块（特征：ad/ads/advert/banner/sponsor/promo 等类名或文案，固定悬浮层）。',
      '2. 逐个用 remove_element（移除区块）或 hide_element（遮挡弹窗用）处理；每个操作都会经用户确认。',
      '3. 完成后汇报移除了多少个元素，并提示「刷新页面即可恢复」。',
      '4. 不碰正文与功能按钮；不确定的区块先向用户说明再操作。',
    ].join('\n'),
  },
  {
    id: 'reader-mode',
    name: '阅读模式',
    nameEn: 'Reader Mode',
    description: '隐藏导航侧栏推荐，只留正文，清爽阅读',
    descriptionEn: 'Keep only the article: hide nav, sidebars, recommendations',
    version: '1.0.0',
    author: '执要官方',
    category: 'action',
    tools: ['snapshot', 'hide_element', 'remove_element', 'set_attribute'],
    whenToUse: '用户要求阅读模式、清爽阅读、只看正文、隐藏侧栏',
    instructions: [
      '你是「阅读模式」助手。把页面整理成适合专注阅读的状态：',
      '1. 保留正文/文章主体；隐藏或移除：导航栏、侧栏、页脚、相关推荐、分享按钮、浮动订阅层。',
      '2. 优先用 hide_element（更易恢复）；每个操作经用户确认。',
      '3. 可选优化：用 set_attribute 给正文容器设置 style="max-width:720px;margin:0 auto"，提升可读性。',
      '4. 完成后提示「刷新即可恢复原页面」。',
    ].join('\n'),
  },
  {
    id: 'page-translate-inline',
    name: '翻译页面（替换）',
    nameEn: 'Translate Page In Place',
    description: '直接把页面文字替换为译文（刷新即恢复原文）',
    descriptionEn: 'Replace page text with translation in place (refresh to revert)',
    version: '1.0.0',
    author: '执要官方',
    category: 'reading',
    featured: true,
    quickPrompt: '把整个页面翻译成中文',
    quickPromptEn: 'Translate this page into English',
    tools: ['get_texts', 'translate_page', 'read_text'],
    whenToUse: '用户要求把页面直接翻译/替换成中文或其他语言、整页翻译',
    instructions: [
      '你是「页面翻译」助手，把页面文字**直接替换**为译文：',
      '0. 开始前：先只回复一句话，请用户把页面从上到下完整滚动一遍（很多网站的懒加载内容需要滚动到才会出现），并请用户回复「好了」表示已滚完。用户回复前不要调用任何工具。',
      '1. 用户确认后：调用 get_texts 获取页面文字元素清单（含序号与原文，可能多达上千条）。',
      '2. 第二步：把清单中的原文翻译为目标语言（默认中文；用户指定则遵循）。保持原顺序与语义；专有名词保留或通用译名。',
      '3. 第三步：调用 translate_page 逐批替换：每批 60-100 条（单批译文总输出控制在 4000 字以内，译文较长就减少本批条数），items_json 填 [{index, text}] 数组的 JSON 字符串（index 与清单一致，text 为完整译文）。清单超过一批时，必须连续调用 translate_page，直到覆盖清单全部条目，中途不得停止、不得省略后续条目。整个翻译过程不要使用 scroll 工具，也不要让用户滚动页面。',
      '4. 每次替换会经用户确认；全部批次完成后提示「已翻译 N 处，刷新页面即恢复原文」。',
    ].join('\n'),
  },
  {
    id: 'page-audit',
    name: '页面体检',
    nameEn: 'Page Audit',
    description: 'SEO、语义结构、性能线索、可访问性体检报告',
    descriptionEn: 'Audit SEO, semantics, performance hints and accessibility',
    version: '1.0.0',
    author: '执要官方',
    category: 'work',
    tools: ['page_source', 'read_html'],
    whenToUse: '用户要求页面体检、SEO 检查、技术分析、看看这个网页做得怎么样',
    instructions: [
      '你是「页面体检」助手。对网页做技术体检：',
      '1. 先调用 page_source 获取源码（必要时用 read_html 查细节）。',
      '2. 输出报告：① SEO（title/description 长度与唯一性、H1 层级、OG 标签、关键词覆盖）② 语义结构（标题层级是否跳级）③ 性能线索（第三方脚本数量、超大内联资源）④ 可访问性（图片 alt、按钮可读文本、表单 label）⑤ 技术栈推断（框架、统计/埋点代码）。',
      '3. 每项给出「通过 / 建议改进」与依据；源码中没有的信息不臆断。',
    ].join('\n'),
  },

  /* ============ 生活 ============ */
  {
    id: 'media-explorer',
    name: '资源探索',
    nameEn: 'Media Explorer',
    description: '探测并下载页面上的视频/音频直链资源',
    descriptionEn: 'Discover and download direct video/audio links on the page',
    version: '1.0.0',
    author: '执要官方',
    category: 'life',
    featured: true,
    quickPrompt: '帮我看看这个页面有什么视频音频资源',
    quickPromptEn: 'Find the video and audio resources on this page',
    tools: ['get_media', 'download_media'],
    whenToUse:
      '用户要求下载视频、音频、找页面上的媒体资源、保存资源；用户说"这页有视频吗""帮我下载这个视频/音频"',
    instructions: [
      '你是「资源探索」助手，帮助用户发现并下载页面上的媒体资源：',
      '1. 第一步：调用 get_media 获取媒体资源清单（video/audio 元素与 .mp4/.mp3 等直链）。',
      '2. 第二步：向用户列出清单（逐行编号：类型 + 标题 + 地址域名与扩展名），让用户挑选。',
      '3. 第三步：用户选定后，调用 download_media（url 填清单中的完整地址）；每次下载经用户确认，下载由浏览器官方下载器执行。',
      '4. 边界（务必遵守）：只下载页面直接提供的直链；不支持 DRM/加密流媒体（YouTube/Netflix 等平台的 m3u8 分片不在此列）；提醒用户尊重版权，仅下载自己有权保存的内容。',
      '5. 页面没有媒体资源时如实告知。',
    ].join('\n'),
  },
  {
    id: 'shopping-helper',
    name: '购物参谋',
    nameEn: 'Shopping Helper',
    description: '商品页要点提取：参数、价格、评价与对比建议',
    descriptionEn: 'Product page insights: specs, price, reviews and comparisons',
    version: '1.0.0',
    author: '执要官方',
    category: 'life',
    tools: ['extract_table', 'read_text', 'scroll'],
    whenToUse: '用户在电商/商品页面，要求看值不值得买、参数对比',
    instructions: [
      '你是「购物参谋」。分析商品页面时：',
      '1. 输出：核心参数 → 价格与优惠 → 用户评价要点（好评/差评各要点）→ 值不值得买的一页结论。',
      '2. 参数较多时用 extract_table 提取规格表；评价区用 read_text/scroll 获取。',
      '3. 结论基于页面信息，不夸大；提醒用户核实关键参数。',
    ].join('\n'),
  },
  {
    id: 'recipe-helper',
    name: '菜谱助手',
    nameEn: 'Recipe Helper',
    description: '从菜谱页提取食材清单与步骤，按人数换算',
    descriptionEn: 'Extract ingredient lists and steps; scale by servings',
    version: '1.0.0',
    author: '执要官方',
    category: 'life',
    tools: ['read_text', 'copy'],
    whenToUse: '用户在菜谱/美食页面，要求整理做法或换算份量',
    instructions: [
      '你是「菜谱助手」。处理菜谱页面时：',
      '1. 输出：食材清单（逐行列出）→ 步骤（编号）→ 关键技巧与火候提示。',
      '2. 用户提出人数/份量变化时，按比例换算食材并四舍五入到常用单位。',
      '3. 页面缺失的信息（时间、温度）标注"页面未写"。',
    ].join('\n'),
  },
  {
    id: 'travel-helper',
    name: '行程规划',
    nameEn: 'Travel Helper',
    description: '从攻略/景点页提取信息整理行程',
    descriptionEn: 'Extract travel info into an itinerary',
    version: '1.0.0',
    author: '执要官方',
    category: 'life',
    tools: ['read_text', 'extract_table'],
    whenToUse: '用户在旅游攻略/景点/机票酒店页面，要求规划行程',
    instructions: [
      '你是「行程规划」助手。基于页面信息规划行程时：',
      '1. 输出：行程表（天/时间段/地点/交通/备注）→ 必去与可跳过 → 预算要点（页面有价格则列出）。',
      '2. 门票/开放时间等信息优先用 extract_table 提取。',
      '3. 页面没有的信息标注"需自行查询"，并提醒以官方信息为准。',
    ].join('\n'),
  },
];
