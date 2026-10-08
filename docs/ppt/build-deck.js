/**
 * 执要 Agent 演示 PPT 生成脚本
 * ------------------------------------------------------------
 * 复用 ppt-craft-master 技能的生成引擎（设计令牌 / 安全区防溢出 / 版式库），
 * 在其上做两件技能本身不提供的事：
 *   1) 自定义封面（带品牌图标）与整页截图版式（保持 16:10 原始比例，不拉伸）
 *   2) 覆盖为品牌纯黑白配色（技能内置 27 套配色里没有纯黑白方案）
 *
 * 用法：node docs/ppt/build-deck.js
 */
const path = require('path');
const SKILL = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.claude', 'skills', 'ppt-craft-master', 'scripts', 'generate.js'
);
const { PPTGenerator } = require(SKILL);

// ---- 品牌配色：纯黑白（对齐 docs/brand/README.md 的 ChatGPT 式单色体系）----
// accent 取中灰：既要能在深色页（封面/章节/金句）上可见，也要能在白色页上画流程箭头。
const MONO = {
  name: '执要黑白',
  primary: '111111',   // 深色页底色 / 深色卡片
  secondary: 'F2F2F2', // 浅色卡片填充 / 深色页上的副标题文字
  accent: '6E6E6E', // 比初版加深一档：双栏页第二列表头是「白字铺灰底」，9A9A9A 对比度只有 2.8:1
  mode: 'light',
  text: '111111',
  textLight: '6E6E6E',
  bgLight: 'FFFFFF'
};

const W = 13.33, H = 7.5;
const SHOT = path.join(__dirname, '..', 'store', 'assets', 'shot-1-chat.png');
const LOGO = path.join(__dirname, '..', 'brand', 'bw3', 'logo-D1-icon-300.png');

class Deck extends PPTGenerator {
  constructor(options = {}) {
    super(options);
    // ⚠️ 必补的修复之二：技能所有坐标常量（W=13.33 / H=7.5）是按 16:9 宽屏写的，
    // 但构造函数设的是 pptxgenjs 的 LAYOUT_16x9 —— 它的实际尺寸是 10×5.625in，
    // 于是右边缘与下边缘的内容全部跑到画布外被裁掉（目录后两条、流程第 5 步、卡片第 4 张）。
    // 必须换成 LAYOUT_WIDE（13.333×7.5in）才能与坐标系统对齐。
    this.pptx.layout = 'LAYOUT_WIDE';
    this.colors = MONO;
  }

  // ⚠️ 必补的修复：技能内部 5 处用 'rectangle'、render_flow 用 'rightTriangle'，
  // 都不是 pptxgenjs 的合法 ShapeType 键，库会把它们原样写成 prst="rectangle" /
  // prst="rightTriangle" —— 非法预设几何名会让 PowerPoint 判定整个文件损坏
  // （0x80070570）并拒绝打开。这里统一归一化为合法名，不必改动技能本体。
  shape(slide, type, o = {}) {
    const ALIAS = { rectangle: 'rect', rightTriangle: 'rtTriangle' };
    return super.shape(slide, ALIAS[type] || type, o);
  }

  // ⚠️ 必补的修复之三：原版 render_centerRadiate 把 (px-cx, py-cy) 直接当宽高画辐条连线，
  // 指向左侧/上方的辐条会算出负的 <a:ext cx/cy> —— 负尺寸同样会让 PowerPoint 判文件损坏。
  // 这里改用「绝对左上角 + 绝对值宽高」重画，其余保持技能原设计。
  render_centerRadiate(p, data) {
    const s = this.newSlide(this.pageBg());
    this.topBand(s);
    this.titleBar(s, p.title);
    const cx = W / 2, cy = 4.2;
    this.shape(s, 'ellipse', { x: cx - 0.9, y: cy - 0.9, w: 1.8, h: 1.8, fill: { color: this.colors.primary } });
    this.safeText(s, data.center || p.title, {
      x: cx - 0.9, y: cy - 0.9, w: 1.8, h: 1.8, fontSize: 14, bold: true,
      color: 'FFFFFF', align: 'center', valign: 'middle', budget: 16
    });
    const spokes = data.spokes || [];
    const n = spokes.length, R = 2.6;
    spokes.forEach((sp, i) => {
      const a = (-90 + i * (360 / n)) * Math.PI / 180;
      const px = cx + R * Math.cos(a), py = cy + R * Math.sin(a);
      this.shape(s, 'line', {
        x: Math.min(cx, px), y: Math.min(cy, py),
        w: Math.abs(px - cx), h: Math.abs(py - cy),
        line: { color: this.colors.accent, width: 2 }
      });
      this.shape(s, 'roundRect', { x: px - 1.2, y: py - 0.5, w: 2.4, h: 1.0, rectRadius: 0.08, fill: { color: this.colors.secondary } });
      this.safeText(s, sp.title || '', {
        x: px - 1.1, y: py - 0.4, w: 2.2, h: 0.8, fontSize: 12, bold: true,
        color: this.colors.primary, align: 'center', valign: 'middle', budget: 22
      });
    });
  }

  // 自定义封面：品牌图标 + 衬线感大标题 + 细分割线
  render_coverBrand(p) {
    const s = this.newSlide(MONO.primary);
    this.decorCircle(s, 9.6, -1.6, 5.4, MONO.accent, 92);
    this.decorCircle(s, -1.4, 4.8, 4.6, MONO.accent, 92);
    s.addImage({ path: LOGO, x: (W - 1.15) / 2, y: 1.30, w: 1.15, h: 1.15 });
    this.safeText(s, p.title, {
      x: 0.8, y: 2.70, w: W - 1.6, h: 1.10, fontSize: 52, bold: true,
      color: 'FFFFFF', align: 'center', budget: 20
    });
    this.safeText(s, p.subtitle, {
      x: 0.8, y: 3.92, w: W - 1.6, h: 0.70, fontSize: 22,
      color: MONO.secondary, align: 'center', budget: 30
    });
    this.shape(s, 'rectangle', { x: (W - 2.4) / 2, y: 4.86, w: 2.4, h: 0.03, fill: { color: MONO.accent } });
    this.safeText(s, 'Zhiyao Agent  ·  Edge 侧边栏网页 AI 助手  ·  BYOK 纯本地', {
      x: 0.8, y: 5.12, w: W - 1.6, h: 0.6, fontSize: 13, color: MONO.accent, align: 'center'
    });
  }

  // 自定义整页截图版式：按 16:10 原始比例居中，避免被拉伸变形
  render_heroShot(p, data) {
    const s = this.newSlide(this.pageBg());
    this.topBand(s);
    this.titleBar(s, p.title);
    const iw = 8.0, ih = 5.0, x = (W - iw) / 2, y = 1.45;
    this.shape(s, 'roundRect', {
      x: x - 0.035, y: y - 0.035, w: iw + 0.07, h: ih + 0.07,
      rectRadius: 0.03, fill: { color: 'FFFFFF' }, line: { color: 'DEDEDE', width: 1 }
    });
    s.addImage({ path: data.image, x, y, w: iw, h: ih });
    if (data.caption) {
      this.safeText(s, data.caption, {
        x: 0.8, y: y + ih + 0.06, w: W - 1.6, h: 0.45,
        fontSize: 12, color: this.pageTextLight(), align: 'center', budget: 70
      });
    }
  }
}

// ============================================================
// 叙事结构：钩子（痛点）→ 张力（它是什么 / 能做什么）→ 释放（凭什么 / 总结）
// 相邻页版式不重复；密度页后接透气页（金句 / 章节页）
// ============================================================
const SLIDES = [
  { layout: 'coverBrand', title: '执要 Agent', subtitle: '圣人执要 · 四方来效' },

  {
    layout: 'toc', title: '目录', data: {
      toc: [
        { title: '问题：AI 与网页之间，隔着一次复制粘贴' },
        { title: '它是什么：住在侧边栏里的网页助手' },
        { title: '核心技能：读懂、动手、技能商店' },
        { title: '安全设计：每一步都由你点头' },
        { title: '为什么不一样：无后端 · BYOK · 数据不出本机' },
        { title: '工程实现与总结' }
      ]
    }
  },

  { layout: 'quote', data: { quote: 'AI 会思考，却看不见你眼前的这一页。', source: '一个每天被忽略的断层' } },

  {
    layout: 'flow', title: '让 AI 看懂一个网页，今天要走五步', data: {
      steps: ['选中内容', '复制', '切到 AI 标签页', '粘贴并提问', '把答案抄回网页']
    }
  },

  { layout: 'section', section: 'PART 01', title: '它是什么' },

  {
    layout: 'zPattern', title: '一个住在侧边栏里的网页助手', data: {
      items: [
        { title: '打开即读', desc: '自动读取当前页正文、视口与选区，不必先复制粘贴，打开面板信息已经就位。' },
        { title: '同屏对话', desc: '答案与页面并排显示，视线不用在标签页之间来回跳，追问也不会丢上下文。' },
        { title: '动手操作', desc: '不止于回答：点击、输入、滚动、改写文字，让它替你完成页面上的机械劳动。' },
        { title: '完全本地', desc: '无后端、无账号体系，API Key 与对话记录只留在你自己的浏览器里。' }
      ]
    }
  },

  {
    layout: 'heroShot', title: '打开侧边栏，它已经读完了这一页', data: {
      image: SHOT,
      caption: '真实界面：正文 4,213 字 · 视口 386 字 · 选区 0 字 · 约 128 tokens'
    }
  },

  {
    layout: 'threeColumn', title: '三件事，构成它的全部', data: {
      cols: [
        { title: '读懂', desc: '正文、视口、选区三档读取，页面脚本只在用户操作时按需注入，不做常驻内容脚本。换言之：你没提问的时候，它什么也看不见。' },
        { title: '动手', desc: '20 个白名单工具，覆盖页面读取、交互操作、内容改写、页面净化与资源下载五类。默认每一步都先预览、再由你确认，它才真正动手。' },
        { title: '技能', desc: '24 个内置技能，点击即装即用，也支持导入 JSON 自定义。技能本质是注入给模型的指令包，不含任何可执行代码。' }
      ]
    }
  },

  { layout: 'section', section: 'PART 02', title: '秀一下技能' },

  {
    layout: 'cardList', title: '20 个白名单工具，能做的不只是「说说」', data: {
      cards: [
        { title: '页面读取', desc: '快照、正文、HTML、页面源码、表格提取 —— 5 个' },
        { title: '交互操作', desc: '点击、输入、下拉选择、滚动、复制 —— 5 个' },
        { title: '内容改写', desc: '改写文字、改写 HTML、写入属性 —— 3 个' },
        { title: '页面净化', desc: '移除元素、隐藏元素、整页替换翻译 —— 3 个' },
        { title: '资源与下载', desc: '提取文本、探测媒体、下载媒体、新标签打开 —— 4 个' }
      ]
    }
  },

  {
    layout: 'doubleColumn', title: '每一步，都由你点头', data: {
      cols: [
        {
          title: '逐步确认（默认）',
          points: ['每个动作先预览、再执行', '危险动作永远强确认', '支付 / 提交 / 密码单独拦截', '随时中止，页面不留痕', '只作用于当前标签页', '所有动作记入本地运行日志']
        },
        {
          title: '任务模式（可选）',
          points: ['批准并自动执行，减少打断', '多步任务一次授权', '边界由白名单兜底', '危险动作依然强确认', '适合批量填表、连续翻页', '随时可叫停，退回逐步确认']
        }
      ],
      conclusion: '自动化与可控性，从来不是二选一。'
    }
  },

  {
    layout: 'cardGrid', title: '技能商店：装一个技能，多一种用法', data: {
      cards: [
        { title: '网页总结', desc: '把长文压成三句话，先看结论，再决定要不要读下去。' },
        { title: '去 AI 味', desc: '把机器腔改回人话，删掉那些套话，发出去前先过一遍。' },
        { title: '整页翻译', desc: '直接把页面文字替换为译文，刷新即恢复原样，不留痕。' },
        { title: '论文精读', desc: '拆结构、提方法、找局限，站在审稿人的角度先读一遍。' },
        { title: '财报解读', desc: '从表格里读出趋势与异常，而不是把数字原样抄一遍。' },
        { title: '去除广告', desc: '把广告和弹窗从页面上拿掉，只留下你真正要读的内容。' }
      ]
    }
  },

  {
    layout: 'centerRadiate', title: '还有一些，用过就回不去', data: {
      center: '读懂当前页',
      spokes: [
        { title: '整页翻译' },
        { title: '媒体下载' },
        { title: '定时任务' },
        { title: '本地历史' },
        { title: '选区即问' }
      ]
    }
  },

  { layout: 'section', section: 'PART 03', title: '凭什么不一样' },

  {
    layout: 'comparison', title: '同样问一句，数据去了哪里？', data: {
      cols: [
        {
          title: '常见的云端网页助手',
          points: ['页面内容必须先上传到厂商服务器', '账号体系绑定，用量与留存不透明', 'API Key 由厂商统一代管', '数据是否留作训练由对方决定', '想换模型，通常得换一个产品']
        },
        {
          title: '执要 Agent（本地直连）',
          points: ['页面内容只发往你自己配置的模型', '无账号、无埋点、无遥测', 'API Key 只存在本机浏览器里', '对话与页面数据不上传任何服务器', '换模型只需改一行配置']
        }
      ]
    }
  },

  {
    layout: 'bigNumber', title: '四个数字，说明它的取舍', data: {
      numbers: [
        { value: '0', label: '后端服务器' },
        { value: '20', label: '白名单工具' },
        { value: '24', label: '内置技能' },
        { value: '2', label: '中英双语' }
      ]
    }
  },

  {
    layout: 'cardList', title: '工程实现：把边界写进架构里', data: {
      cards: [
        { title: 'WXT 0.21', desc: '现代浏览器扩展框架，一份配置直出 Manifest V3 产物，构建链路干净。' },
        { title: 'React 18', desc: '侧边栏界面用 React 18 + TypeScript 编写，核心逻辑全程类型约束。' },
        { title: 'zod', desc: '工具参数与后台消息协议全部用 zod 做运行时校验，非法输入进不来。' },
        { title: '按需注入', desc: '不注册常驻内容脚本，仅在用户操作时注入页面读取与执行脚本。' }
      ]
    }
  },

  { layout: 'quote', data: { quote: '把 AI 放进浏览器，不是多开一个标签页，而是让它看见你看见的东西。', source: '执要 Agent' } },

  {
    layout: 'summary', title: '一页总结', data: {
      cards: [
        { title: '它是什么', desc: 'Edge 侧边栏里的网页 AI 助手，打开面板即读懂当前页。' },
        { title: '能做什么', desc: '对话、操作页面、技能商店、整页翻译、媒体下载、定时任务。' },
        { title: '怎么放心', desc: '默认逐步确认，危险动作永远强确认，白名单兜底。' },
        { title: '数据去哪', desc: '只发给你自己配置的模型，Key 与记录只存本机。' },
        { title: '怎么装', desc: 'edge://extensions 加载 .output/edge-mv3，无需账号。' },
        { title: '怎么用', desc: '自带任意 OpenAI 兼容 API Key，填上即可开始。' }
      ]
    }
  },

  {
    layout: 'contact', title: '谢谢观看', data: {
      contact: [
        '执要 Agent（Zhiyao Agent）· 圣人执要，四方来效',
        '反馈 / 定制：3538982885@qq.com',
        'MIT License · 无埋点 · 无遥测'
      ]
    }
  }
];

(async () => {
  const gen = new Deck({
    title: '执要 Agent · 产品演示',
    author: '执要 Agent',
    palette: 'midnight' // 仅用于初始化，构造函数里会覆盖为品牌纯黑白
  });

  SLIDES.forEach((sl, i) => {
    const page = { layout: sl.layout, title: sl.title, subtitle: sl.subtitle, section: sl.section };
    try {
      gen.render(page, sl.data || {});
    } catch (e) {
      console.error(`❌ 第 ${i + 1} 页（${sl.layout}）渲染失败：${e.message}`);
      process.exitCode = 1;
      throw e;
    }
  });

  const out = path.join(__dirname, '执要Agent-演示.pptx');
  await gen.save(out);
  console.log(`   共 ${SLIDES.length} 页（设计稿页数）`);
})();
