/**
 * 页面读取脚本（按需注入，无外部依赖，禁止 import）。
 * 通过 chrome.scripting.executeScript 注入后，其完成值即页面数据。
 * 结构必须与 src/core/protocol.ts 的 PageDataSchema 一致。
 */
(() => {
  'use strict';

  const MAX_BODY = 12000;
  const MAX_VIEWPORT = 4000;

  /** 去除脚本/样式/导航等噪音后提取正文文本 */
  function getReadableText() {
    const doc = document;
    // 优先 <article>，其次 <main>，最后 <body>
    const candidates = [doc.querySelector('article'), doc.querySelector('main'), doc.body]
      .filter(Boolean);

    let best = null;
    let bestScore = -1;
    for (const root of candidates) {
      const text = collectText(root);
      const score = text.length;
      if (score > bestScore) {
        bestScore = score;
        best = text;
      }
    }
    return (best ?? '').trim();
  }

  /** 收集容器内可见文本（跳过脚本/样式/隐藏元素），父级文本重复去除交给分段处理 */
  function collectText(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,iframe,canvas,head').forEach((el) => el.remove());
    // 用分段近似排版：块级元素换行，提取 innerText
    const text = clone.textContent || '';
    return normalize(text);
  }

  function normalize(text) {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 视口内可见文本：只取与视口相交的块级容器 */
  function getViewportText() {
    const viewportH = window.innerHeight || 800;
    const blocks = document.querySelectorAll('p, h1, h2, h3, h4, li, td, th, div, section, span, a, button, label');
    const seen = new Set();
    const parts = [];
    for (const el of blocks) {
      if (parts.join('\n').length >= MAX_VIEWPORT) break;
      if (seen.has(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > viewportH) continue;
      if (rect.width === 0 && rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // 跳过包含大量子块的容器，避免重复文本（保留叶子级文本元素）
      if (el.children.length > 6) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 2) continue;
      seen.add(el);
      parts.push(text);
    }
    const joined = normalize(parts.join('\n'));
    return joined.slice(0, MAX_VIEWPORT);
  }

  function getSelection() {
    const sel = window.getSelection();
    return (sel ? sel.toString() : '').trim();
  }

  try {
    const doc = document;
    const body = getReadableText();
    const bodyTruncated = body.length > MAX_BODY;
    const viewportText = getViewportText();
    const viewportTruncated = viewportText.length >= MAX_VIEWPORT;

    return {
      ok: true,
      title: (doc.title || '').slice(0, 300),
      url: location.href,
      body: body.slice(0, MAX_BODY),
      bodyTruncated,
      viewport: viewportText.slice(0, MAX_VIEWPORT),
      viewportTruncated,
      selection: getSelection(),
      lang: doc.documentElement.lang || navigator.language || '',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
})();
