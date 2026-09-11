// ==UserScript==
// @name         执要 Agent（网页 AI 助手）
// @name:en      Zhiyao Agent (Web AI Assistant)
// @namespace    https://github.com/zhiyao-agent
// @version      1.0.0
// @description  圣人执要，四方来效——自带 API Key 的网页 AI 助手：读当前页面并对话、AI 操作网页（逐步确认）、整页翻译替换、去广告、技能快捷指令。纯本地运行，数据不经过任何第三方服务器。
// @description:en  The sage holds the essentials; all directions serve. A BYOK web AI assistant: chat about the current page, agent page actions with step-by-step confirmation, in-place page translation, ad removal. Fully local.
// @author       axron
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      api.deepseek.com
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      open.bigmodel.cn
// @connect      dashscope.aliyuncs.com
// @connect      api.siliconflow.cn
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 说明：这是「执要 Agent」扩展的用户脚本版本（脚本猫 / Tampermonkey 通用）。
 * 与扩展版的差异：没有浏览器侧边栏（改为页面内浮层）、没有 chrome.alarms 定时任务。
 * 所有数据（API Key / 设置）保存在脚本管理器本地存储，不会上传任何服务器。
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_STEPS = 10;
  var MAX_STEPS_AD_REMOVAL = 50;
  var OUTPUT_CAP_TOKENS = 4096;
  var BODY_MAX = 12000;
  var VIEWPORT_MAX = 4000;

  var INTERNAL_TOOLS = { snapshot: 1, page_source: 1, get_texts: 1, get_media: 1 };
  var DANGER_RE =
    /支付|付款|付钱|提交|下单|购买|立即购买|结算|删除|注销|清空|转账|密码|验证码|登录|登入|确认|同意|授权|签约|续费|绑定|pay|buy|submit|delete|password|login|checkout|order|transfer|confirm|agree|authorize|subscribe/i;
  var SENSITIVE_TOOLS = {
    edit_html: 1,
    set_attribute: 1,
    remove_element: 1,
    hide_element: 1,
    open_in_new_tab: 1,
    download_media: 1,
  };

  /* ============================ 存储 ============================ */

  var KEY_SETTINGS = 'zhiyao_settings';
  var KEY_SKILLS = 'zhiyao_skills';

  var DEFAULT_SETTINGS = {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    autoReadPage: true,
    autoMode: false,
  };

  function gmGet(key, fallback) {
    try {
      var v = typeof GM_getValue === 'function' ? GM_getValue(key, null) : null;
      if (v == null) return fallback;
      return typeof v === 'string' ? JSON.parse(v) : v;
    } catch (e) {
      return fallback;
    }
  }
  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(value));
    } catch (e) {
      /* 忽略存储失败 */
    }
  }

  var settings = Object.assign({}, DEFAULT_SETTINGS, gmGet(KEY_SETTINGS, {}));
  function saveSettings() {
    gmSet(KEY_SETTINGS, settings);
  }

  var installedSkillIds = gmGet(KEY_SKILLS, ['summarize', 'remove-ads', 'page-translate']);
  function saveSkills() {
    gmSet(KEY_SKILLS, installedSkillIds);
  }
  function skillOn(id) {
    return installedSkillIds.indexOf(id) >= 0;
  }

  /* ============================ 页面读取 ============================ */

  function visibleText(el) {
    var t = el.innerText || el.textContent || '';
    return String(t).replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inViewport(el, pad) {
    var r = el.getBoundingClientRect();
    return r.bottom > -pad && r.top < window.innerHeight + pad;
  }

  function readPage() {
    var clone = document.body ? document.body.cloneNode(true) : null;
    var text = '';
    if (clone) {
      var junk = clone.querySelectorAll('script, style, noscript, svg, iframe, nav, footer');
      for (var i = 0; i < junk.length; i++) junk[i].remove();
      text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }
    var vpParts = [];
    var blocks = document.querySelectorAll('h1, h2, h3, p, li, td');
    for (var j = 0; j < blocks.length && vpParts.join('\n').length < VIEWPORT_MAX; j++) {
      if (!isVisible(blocks[j]) || !inViewport(blocks[j], 0)) continue;
      var t = visibleText(blocks[j]);
      if (t) vpParts.push(t);
    }
    var sel = '';
    try {
      sel = String(window.getSelection ? window.getSelection().toString() : '').slice(0, 2000);
    } catch (e) {
      sel = '';
    }
    return {
      title: document.title || '',
      url: location.href,
      body: text.slice(0, BODY_MAX),
      bodyTruncated: text.length > BODY_MAX,
      viewport: vpParts.join('\n').slice(0, VIEWPORT_MAX),
      selection: sel,
      lang: document.documentElement.lang || navigator.language || 'en',
    };
  }

  /* ============================ 元素快照与选择器 ============================ */

  var SEL =
    'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
    '[role="checkbox"], [role="menuitem"], [role="tab"], [contenteditable="true"], summary';

  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/"/g, '\\"');
  }

  function collect() {
    var all = Array.prototype.filter.call(document.querySelectorAll(SEL), isVisible);
    var vp = all.filter(function (el) {
      return inViewport(el, 200);
    });
    var rest = all.filter(function (el) {
      return !inViewport(el, 200);
    });
    return vp.concat(rest).slice(0, 200);
  }

  function stableSelector(el) {
    if (el.id) return '#' + esc(el.id);
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + esc(name) + '"]';
    var aria = el.getAttribute('aria-label');
    if (aria && aria.length <= 60) return tag + '[aria-label="' + esc(aria) + '"]';
    var parts = [];
    var cur = el;
    for (var i = 0; cur && cur !== document.body && i < 4; i++) {
      var t = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift('#' + esc(cur.id));
        break;
      }
      var seg = t;
      if (cur.parentElement) {
        var sibs = Array.prototype.filter.call(cur.parentElement.children, function (c) {
          return c.tagName === cur.tagName;
        });
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function desc(el) {
    var tag = el.tagName.toLowerCase();
    var text = '';
    if (tag === 'input') text = el.value || el.getAttribute('placeholder') || '';
    else if (tag === 'select') {
      var o = el.options && el.options[el.selectedIndex];
      text = o ? o.text : el.value;
    } else text = visibleText(el);
    return {
      tag: tag,
      text: String(text || '').slice(0, 60),
      aria: String(el.getAttribute('aria-label') || '').slice(0, 60),
      type: String(el.getAttribute('type') || ''),
      value: String(el.value || '').slice(0, 60),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      checked: el.checked == null ? null : !!el.checked,
    };
  }

  function snapshot() {
    var els = collect();
    return {
      url: location.href,
      title: document.title,
      total: els.length,
      elements: els.map(function (el, i) {
        var r = el.getBoundingClientRect();
        var d = desc(el);
        return {
          i: i,
          tag: d.tag,
          text: d.text,
          aria: d.aria,
          type: d.type,
          value: d.value,
          disabled: d.disabled,
          checked: d.checked,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          selector: stableSelector(el),
        };
      }),
    };
  }

  function findTarget(payload) {
    if (payload.index != null && payload.index >= 0) {
      var els = collect();
      var byIndex = els[payload.index];
      if (byIndex) return { el: byIndex, via: 'index #' + payload.index };
    }
    if (payload.selector) {
      try {
        var el = document.querySelector(payload.selector);
        if (el) return { el: el, via: 'selector ' + payload.selector };
      } catch (e) {
        /* 无效选择器 */
      }
    }
    return null;
  }

  /* ============================ 页面操作执行器 ============================ */

  function mouseSequence(el, type) {
    var opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  function nativeSetValue(el, value) {
    var proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value);
    else el.value = value;
  }

  function focusAndType(el, text) {
    el.scrollIntoView({ block: 'center' });
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* ignore */
    }
    nativeSetValue(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectOption(el, text) {
    if (el.tagName.toLowerCase() !== 'select') {
      focusAndType(el, text);
      return;
    }
    var value = text;
    var match = null;
    for (var i = 0; i < el.options.length; i++) {
      var o = el.options[i];
      if (o.value === text) match = o.value;
      else if (match === null && o.text.trim() === String(text).trim()) match = o.value;
    }
    if (match !== null) value = match;
    nativeSetValue(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function sanitizeHtml(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var bad = tpl.content.querySelectorAll(
      'script, style, iframe, frame, frameset, link, meta, object, embed, form, svg, math',
    );
    for (var i = 0; i < bad.length; i++) bad[i].remove();
    var URL_ATTRS = ['href', 'src', 'xlink:href', 'formaction', 'action', 'poster'];
    var all = tpl.content.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var attrs = Array.prototype.slice.call(all[j].attributes);
      for (var k = 0; k < attrs.length; k++) {
        var a = attrs[k];
        var isUrl = URL_ATTRS.indexOf(a.name.toLowerCase()) >= 0;
        if (/^on/i.test(a.name) || (isUrl && /^\s*(javascript|vbscript|data):/i.test(a.value))) {
          all[j].removeAttribute(a.name);
        }
      }
    }
    return tpl.innerHTML;
  }

  var TEXT_SEL =
    'h1, h2, h3, h4, h5, h6, p, li, dt, dd, td, th, caption, blockquote, figcaption, ' +
    'summary, label, legend, button, a[href], [role="heading"], [role="button"]';

  function getDirectText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) t += n.textContent;
      else if (n.nodeType === 1 && /^(B|I|EM|STRONG|SPAN|A|CODE|BR|SMALL|MARK)$/i.test(n.tagName)) {
        t += n.textContent;
      }
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function collectTextEls() {
    var all = Array.prototype.filter.call(document.querySelectorAll(TEXT_SEL), isVisible);
    var vp = all.filter(function (el) {
      return inViewport(el, 100);
    });
    var rest = all.filter(function (el) {
      return !inViewport(el, 100);
    });
    var list = vp.concat(rest);
    var out = [];
    var seen = [];
    for (var i = 0; i < list.length && out.length < 1000; i++) {
      var el = list[i];
      if (seen.indexOf(el) >= 0) continue;
      var text = getDirectText(el);
      if (!text) continue;
      seen.push(el);
      out.push({ i: out.length, tag: el.tagName.toLowerCase(), text: text.slice(0, 1000), selector: stableSelector(el) });
    }
    return out;
  }

  function setTranslatedText(el, text) {
    for (var i = el.childNodes.length - 1; i >= 0; i--) {
      if (el.childNodes[i].nodeType === 3) el.removeChild(el.childNodes[i]);
    }
    el.insertBefore(document.createTextNode(String(text)), el.firstChild);
  }

  function extractTable(el) {
    var table = el.closest ? el.closest('table') : null;
    if (!table) return '';
    var rows = Array.prototype.slice.call(table.querySelectorAll('tr')).slice(0, 50);
    return rows
      .map(function (tr) {
        return Array.prototype.slice
          .call(tr.querySelectorAll('th,td'))
          .map(function (c) {
            return '"' + (c.innerText || '').trim().replace(/[\r\n]+/g, ' ').replace(/"/g, '""') + '"';
          })
          .join(',');
      })
      .join('\n');
  }

  function execAction(p) {
    try {
      if (p.tool === 'page_source') {
        var clone = document.documentElement.cloneNode(true);
        var junk = clone.querySelectorAll('script, style, noscript, svg, link[rel="stylesheet"]');
        for (var i = 0; i < junk.length; i++) junk[i].remove();
        return { ok: true, message: '已读取页面源码', data: (clone.outerHTML || '').slice(0, 20000) };
      }
      if (p.tool === 'get_texts') {
        var texts = collectTextEls();
        return { ok: true, message: '已读取 ' + texts.length + ' 个文字元素', data: JSON.stringify(texts) };
      }
      if (p.tool === 'snapshot') {
        var snap = snapshot();
        return { ok: true, message: '已读取 ' + snap.total + ' 个交互元素', data: JSON.stringify(snap) };
      }
      if (p.tool === 'translate_page') {
        var items = p.items;
        if ((!items || !items.length) && typeof p.text === 'string') {
          try {
            items = JSON.parse(p.text);
          } catch (e) {
            items = null;
          }
        }
        if (!items || !items.length) return { ok: false, message: '缺少译文清单' };
        var els2 = collectTextEls();
        var done = 0;
        var failed = 0;
        for (var m = 0; m < items.length; m++) {
          var target = els2[items[m].index];
          if (!target || !target.selector) {
            failed++;
            continue;
          }
          var elm = null;
          try {
            elm = document.querySelector(target.selector);
          } catch (e) {
            elm = null;
          }
          if (!elm) {
            failed++;
            continue;
          }
          setTranslatedText(elm, items[m].text);
          done++;
        }
        return { ok: true, message: '已替换 ' + done + ' 处文字' + (failed ? '（' + failed + ' 处未找到）' : '') };
      }
      if (p.tool === 'get_media') {
        var out = [];
        var seen = {};
        var media = document.querySelectorAll('video, audio, a[href]');
        var extRe = /\.(mp4|webm|m4v|mov|mkv|avi|ts|mp3|wav|flac|ogg|aac|m4a|opus)(\?|#|$)/i;
        for (var n = 0; n < media.length && out.length < 100; n++) {
          var node = media[n];
          var raw = node.currentSrc || node.getAttribute('src') || node.getAttribute('href') || '';
          if (!raw || !extRe.test(raw) || /\.m3u8(\?|$)/i.test(raw)) continue;
          var abs;
          try {
            abs = new URL(raw, location.href).href;
          } catch (e) {
            continue;
          }
          if (!/^https?:/i.test(abs) || seen[abs]) continue;
          seen[abs] = 1;
          out.push({ i: out.length, kind: node.tagName.toLowerCase(), url: abs });
        }
        return { ok: true, message: '发现 ' + out.length + ' 个媒体资源', data: JSON.stringify(out) };
      }

      var found = findTarget(p);
      if (!found) return { ok: false, message: '目标元素未找到（页面可能已变化，请重新分析）' };
      var el = found.el;
      if (el.disabled) return { ok: false, message: '目标元素已禁用，无法操作' };
      var d = desc(el);
      var label = d.text || d.aria || '<' + d.tag + '>';
      var before = location.href;

      switch (p.tool) {
        case 'click':
          el.scrollIntoView({ block: 'center' });
          mouseSequence(el, 'click');
          break;
        case 'type':
          if (p.text == null) return { ok: false, message: '缺少输入内容' };
          focusAndType(el, String(p.text));
          break;
        case 'select':
          if (p.text == null) return { ok: false, message: '缺少选项值' };
          selectOption(el, String(p.text));
          break;
        case 'scroll':
          window.scrollBy({ top: Number(p.amount) || 0, behavior: 'smooth' });
          break;
        case 'read_text':
          return { ok: true, message: '已读取文本', data: visibleText(el).slice(0, 4000) };
        case 'read_html':
          return { ok: true, message: '已读取 HTML', data: String(el.outerHTML || '').slice(0, 12000) };
        case 'extract_table': {
          var csv = extractTable(el);
          return csv ? { ok: true, message: '已提取表格', data: csv } : { ok: false, message: '未找到表格' };
        }
        case 'copy': {
          var txt = (el.innerText || el.value || '').trim().slice(0, 4000);
          var okCopy = false;
          try {
            if (navigator.clipboard) {
              navigator.clipboard.writeText(txt);
              okCopy = true;
            }
          } catch (e) {
            okCopy = false;
          }
          return { ok: okCopy, message: okCopy ? '已复制到剪贴板' : '复制失败（需页面处于聚焦状态）' };
        }
        case 'edit_text':
          if (p.text == null) return { ok: false, message: '缺少文本' };
          el.textContent = String(p.text);
          break;
        case 'edit_html':
          if (p.html == null) return { ok: false, message: '缺少 HTML' };
          el.innerHTML = sanitizeHtml(String(p.html));
          break;
        case 'set_attribute': {
          var name = String(p.name || '');
          var value = String(p.value == null ? '' : p.value);
          if (/^on/i.test(name) || /^(srcdoc|formaction)$/i.test(name)) {
            return { ok: false, message: '该属性被禁止' };
          }
          if (
            /^(href|src|xlink:href|action|poster)$/i.test(name) &&
            /^\s*(javascript|vbscript|data):/i.test(value)
          ) {
            return { ok: false, message: 'URL 类属性仅允许 http(s) 或相对地址' };
          }
          el.setAttribute(name, value);
          break;
        }
        case 'remove_element':
          el.remove();
          break;
        case 'hide_element':
          el.style.display = 'none';
          break;
        case 'open_in_new_tab': {
          var u = String(p.text || '');
          if (!/^https?:\/\//i.test(u)) return { ok: false, message: '只允许 http(s) 链接' };
          window.open(u, '_blank', 'noopener');
          break;
        }
        case 'download_media': {
          var du = String(p.url || '');
          if (!/^https?:\/\//i.test(du)) return { ok: false, message: '只允许 http(s) 直链' };
          var a = document.createElement('a');
          a.href = du;
          a.download = '';
          document.body.appendChild(a);
          a.click();
          a.remove();
          break;
        }
        default:
          return { ok: false, message: '未知操作：' + p.tool };
      }
      return {
        ok: true,
        message: '已执行 ' + p.tool + ' → ' + label + '（' + found.via + '）',
        urlChanged: before !== location.href,
        newUrl: location.href,
      };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  }

  /* ============================ 工具白名单 ============================ */

  var TOOLS = [
    { name: 'snapshot', description: '重新获取当前页面的交互元素快照（含序号 i、标签、文本、选择器）。操作页面前先调用。', needsTarget: false, confirm: false, parameters: { type: 'object', properties: {} } },
    { name: 'click', description: '点击页面元素。用快照中的序号 index（首选），或用 selector。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' } } } },
    { name: 'type', description: '在输入框/文本域中输入文本。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
    { name: 'select', description: '在下拉框中选择选项，text 为选项值或显示文本。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
    { name: 'scroll', description: '滚动页面，amount 为正向下、负向上（像素）。', needsTarget: false, confirm: false, parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
    { name: 'read_text', description: '读取页面元素文本。', needsTarget: true, confirm: false, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' } } } },
    { name: 'read_html', description: '读取页面元素 HTML 片段（有界截断）。', needsTarget: true, confirm: false, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' } } } },
    { name: 'page_source', description: '读取整页 HTML 源码（已去除 script/style，有界截断）。', needsTarget: false, confirm: false, parameters: { type: 'object', properties: {} } },
    { name: 'extract_table', description: '把元素所在表格提取为 CSV 文本。', needsTarget: true, confirm: false, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' } } } },
    { name: 'copy', description: '把元素文本复制到剪贴板。', needsTarget: true, confirm: false, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' } } } },
    { name: 'edit_text', description: '修改页面元素文字（仅本机生效，刷新恢复）。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
    { name: 'edit_html', description: '替换元素内部 HTML（脚本与事件属性会被自动清除）。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' }, html: { type: 'string' } }, required: ['html'] } },
    { name: 'set_attribute', description: '设置元素属性（on* / srcdoc / formaction 被禁止）。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
    { name: 'remove_element', description: '从页面移除元素（如广告区块）。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' } } } },
    { name: 'hide_element', description: '隐藏元素（display:none，可移除弹窗遮挡）。', needsTarget: true, confirm: true, parameters: { type: 'object', properties: { index: { type: 'integer' }, selector: { type: 'string' } } } },
    { name: 'get_texts', description: '获取页面文字元素清单（序号 index、标签、原文）。整页翻译前必须先调用。', needsTarget: false, confirm: false, parameters: { type: 'object', properties: {} } },
    { name: 'translate_page', description: '按清单批量替换页面文字为译文（仅本机生效）。items_json 为 [{"index":0,"text":"译文"}] 的 JSON 字符串。每批 60-100 条且单批译文不超过 4000 字；清单超过一批时必须连续调用直到全部覆盖。', needsTarget: false, confirm: true, parameters: { type: 'object', properties: { lang: { type: 'string' }, items_json: { type: 'string' } }, required: ['lang', 'items_json'] } },
    { name: 'get_media', description: '探测页面媒体直链（video/audio 与常见扩展名链接）。', needsTarget: false, confirm: false, parameters: { type: 'object', properties: {} } },
    { name: 'download_media', description: '下载一个媒体直链（http(s)）。', needsTarget: false, confirm: true, parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'open_in_new_tab', description: '在新标签页打开 http(s) 链接，text 为完整 URL。', needsTarget: false, confirm: true, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  ];

  function findTool(name) {
    for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].name === name) return TOOLS[i];
    return null;
  }

  function validateToolCall(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '工具调用不是对象' };
    var tool = findTool(raw.tool);
    if (!tool) return { ok: false, error: '不在白名单内：' + raw.tool };
    var args = raw.args && typeof raw.args === 'object' ? Object.assign({}, raw.args) : {};
    if (tool.needsTarget) {
      var hasIndex = typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0;
      var hasSel = typeof args.selector === 'string' && args.selector.length > 0;
      if (!hasIndex && !hasSel) return { ok: false, error: raw.tool + ' 需要 index 或 selector' };
      if (!hasIndex) delete args.index;
    }
    if (raw.tool === 'type' || raw.tool === 'select' || raw.tool === 'open_in_new_tab') {
      if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, error: raw.tool + ' 需要 text' };
      if (args.text.length > 2000) return { ok: false, error: 'text 过长（>2000 字符）' };
      if (raw.tool === 'open_in_new_tab' && !/^https?:\/\//i.test(args.text.trim())) {
        return { ok: false, error: 'open_in_new_tab 只允许 http(s) 链接' };
      }
    }
    if (raw.tool === 'edit_text' && (typeof args.text !== 'string' || !args.text.length || args.text.length > 2000)) {
      return { ok: false, error: 'edit_text 需要 1-2000 字符的 text' };
    }
    if (raw.tool === 'edit_html' && (typeof args.html !== 'string' || !args.html.trim() || args.html.length > 20000)) {
      return { ok: false, error: 'edit_html 需要 1-20000 字符的 html' };
    }
    if (raw.tool === 'set_attribute') {
      if (typeof args.name !== 'string' || !args.name.length || args.name.length > 64) return { ok: false, error: 'set_attribute 需要合法的属性名' };
      if (/^on/i.test(args.name) || /^(srcdoc|formaction)$/i.test(args.name)) return { ok: false, error: '该属性被禁止' };
      if (typeof args.value !== 'string' || args.value.length > 4000) return { ok: false, error: 'set_attribute 需要 value（≤4000 字符）' };
      if (/^(href|src|xlink:href|action|poster)$/i.test(args.name) && /^\s*(javascript|vbscript|data):/i.test(args.value)) {
        return { ok: false, error: 'URL 类属性仅允许 http(s) 或相对地址' };
      }
    }
    if (raw.tool === 'translate_page') {
      if (typeof args.lang !== 'string' || !args.lang.length) return { ok: false, error: 'translate_page 需要 lang' };
      var rawItems = args.items;
      if ((!Array.isArray(rawItems) || !rawItems.length) && typeof args.items_json === 'string') {
        try {
          rawItems = JSON.parse(args.items_json);
        } catch (e) {
          return { ok: false, error: 'items_json 不是合法 JSON（可能被输出长度截断）' };
        }
      }
      if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 1000) {
        return { ok: false, error: 'translate_page 需要 items_json（1-1000 条）' };
      }
      var items = [];
      for (var i = 0; i < rawItems.length; i++) {
        var it = rawItems[i];
        if (!it || typeof it !== 'object') return { ok: false, error: 'items 条目格式错误' };
        if (typeof it.index !== 'number' || !Number.isInteger(it.index) || it.index < 0) return { ok: false, error: 'items[index] 必须是整数' };
        if (typeof it.text !== 'string' || !it.text.length || it.text.length > 1500) return { ok: false, error: 'items[text] 需为 1-1500 字符' };
        items.push({ index: it.index, text: it.text });
      }
      args.items = items;
    }
    if (raw.tool === 'download_media' && (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url))) {
      return { ok: false, error: 'download_media 需要合法的 http(s) url' };
    }
    if (raw.tool === 'scroll') {
      if (typeof args.amount !== 'number' || !isFinite(args.amount)) return { ok: false, error: 'scroll 需要数值 amount' };
      args.amount = Math.max(-5000, Math.min(5000, args.amount));
    }
    return { ok: true, call: { tool: raw.tool, args: args } };
  }

  /* ============================ 技能 ============================ */

  var SKILLS = [
    {
      id: 'summarize',
      name: '网页总结',
      desc: 'TL;DR + 要点 + 行动项',
      prompt: '总结当前页面：先一句话结论，再列 3-5 条要点，最后给行动建议。',
      tools: [],
    },
    {
      id: 'page-translate',
      name: '翻译页面',
      desc: '把页面文字直接替换为译文',
      prompt: '把整个页面翻译成中文',
      tools: ['get_texts', 'translate_page'],
      instructions:
        '你是「页面翻译」助手：0) 开始前先只回复一句话，请用户把页面从上到下完整滚动一遍（懒加载内容需要滚动才出现），并请用户回复「好了」；用户回复前不要调用任何工具。1) 用户确认后调用 get_texts 获取文字元素清单。2) 把清单原文翻译为目标语言（默认中文）。3) 调用 translate_page 逐批替换（每批 60-100 条、单批译文不超过 4000 字），必须连续调用直到覆盖清单全部条目，中途不得停止；整个过程不要滚动页面。4) 完成后提示「已翻译 N 处，刷新页面即恢复原文」。',
    },
    {
      id: 'remove-ads',
      name: '去除广告',
      desc: '移除广告、弹窗、悬浮横幅',
      prompt: '去掉这个页面的广告和弹窗',
      tools: ['snapshot', 'scroll', 'remove_element', 'hide_element'],
      instructions:
        '你是「去除广告」助手：1) 用 snapshot/scroll 找出广告、弹窗、悬浮横幅、推广区块（类名或文案含 ad/ads/advert/banner/sponsor/promo，或固定悬浮层）。2) 逐个用 remove_element 或 hide_element 处理，每个操作都会经用户确认；尽量一次性清完全部广告。3) 完成后汇报移除了多少元素并提示「刷新页面即可恢复」。4) 不碰正文与功能按钮；不确定的先说明再操作。',
    },
    {
      id: 'explain',
      name: '代码解读',
      desc: '解释页面代码的逻辑与问题',
      prompt: '解释这个页面上代码的含义，指出潜在问题',
      tools: ['page_source', 'read_text'],
    },
  ];

  function buildSkillBlock() {
    var on = SKILLS.filter(function (s) {
      return skillOn(s.id);
    });
    if (!on.length) return '';
    var today = new Date();
    var lines = ['# 已启用技能（按需使用，不要强行套用）'];
    on.forEach(function (s) {
      lines.push('## ' + s.name + '（' + s.desc + '）');
      if (s.instructions) lines.push(s.instructions);
    });
    lines.push('当前时间：' + today.toLocaleString());
    return lines.join('\n');
  }

  function toOpenAITools() {
    return TOOLS.map(function (t) {
      return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
    });
  }

  /* ============================ 模型调用 ============================ */

  function apiUrl() {
    return settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  }

  function gmRequest(opts) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: opts.method || 'POST',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: 120000,
        onload: function (res) {
          resolve({ status: res.status, text: res.responseText });
        },
        onerror: function () {
          reject(new Error('网络错误：无法访问 ' + opts.url));
        },
        ontimeout: function () {
          reject(new Error('请求超时'));
        },
      });
    });
  }

  function parseToolCalls(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i];
      if (t && t.function && t.function.name) {
        out.push({ id: t.id || 'call_' + i, name: t.function.name, arguments: t.function.arguments || '{}' });
      }
    }
    return out.length ? out : null;
  }

  /** 优先 fetch 流式；CORS 失败时回退 GM_xmlhttpRequest 非流式 */
  async function callModel(messages, tools, onDelta, signal) {
    var body = { model: settings.model, messages: messages, stream: true };
    if (tools && tools.length) body.tools = tools;
    var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey };
    try {
      var res = await fetch(apiUrl(), { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal });
      if (!res.ok) {
        var errText = await res.text().catch(function () {
          return '';
        });
        throw new Error('HTTP ' + res.status + (errText ? ' ' + errText.slice(0, 200) : ''));
      }
      return await readSse(res, onDelta);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (/^HTTP /.test(String(e && e.message))) throw e; // 服务端错误不重试
      var r = await gmRequest({
        url: apiUrl(),
        headers: headers,
        data: JSON.stringify(Object.assign({}, body, { stream: false })),
      });
      if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 200));
      var json = JSON.parse(r.text);
      var msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
      var content = msg.content || '';
      if (content) onDelta(content);
      return { text: content, toolCalls: parseToolCalls(msg.tool_calls) };
    }
  }

  async function readSse(res, onDelta) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var full = '';
    var acc = {};
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('data:') !== 0) continue;
        var data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          var json = JSON.parse(data);
          var delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta && delta.content) {
            full += delta.content;
            onDelta(delta.content);
          }
          if (delta && delta.tool_calls) {
            for (var k = 0; k < delta.tool_calls.length; k++) {
              var tc = delta.tool_calls[k];
              var idx = typeof tc.index === 'number' ? tc.index : 0;
              if (!acc[idx]) acc[idx] = { id: '', name: '', args: '' };
              if (tc.id) acc[idx].id = tc.id;
              if (tc.function && tc.function.name) acc[idx].name = tc.function.name;
              if (tc.function && tc.function.arguments) acc[idx].args += tc.function.arguments;
            }
          }
        } catch (e) {
          /* 忽略无法解析的行 */
        }
      }
    }
    var calls = Object.keys(acc)
      .map(function (k) {
        return acc[k];
      })
      .filter(function (c) {
        return c.name;
      });
    return {
      text: full,
      toolCalls: calls.length
        ? calls.map(function (c, i) {
            return { id: c.id || 'call_' + i, name: c.name, arguments: c.args };
          })
        : null,
    };
  }

  async function testConnection() {
    var body = JSON.stringify({
      model: settings.model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    });
    var headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey };
    var r;
    try {
      var res = await fetch(apiUrl(), { method: 'POST', headers: headers, body: body });
      r = { status: res.status, text: await res.text() };
    } catch (e) {
      // CORS 被拦时回退 GM 请求（脚本猫 / Tampermonkey 的跨域通道）
      r = await gmRequest({ url: apiUrl(), headers: headers, data: body });
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error('HTTP ' + r.status + ' ' + String(r.text || '').slice(0, 300));
    }
    return true;
  }

  async function fetchModels() {
    var url = settings.baseUrl.replace(/\/+$/, '') + '/models';
    var headers = { Authorization: 'Bearer ' + settings.apiKey };
    var r;
    try {
      var res = await fetch(url, { headers: headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      r = { status: res.status, text: await res.text() };
    } catch (e) {
      r = await gmRequest({ method: 'GET', url: url, headers: headers });
    }
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    var json = JSON.parse(r.text);
    var list = (json.data || [])
      .map(function (m) {
        return m && m.id;
      })
      .filter(function (x) {
        return typeof x === 'string' && x;
      });
    if (!list.length) throw new Error('模型列表为空');
    return list.slice(0, 200);
  }

  /* ============================ 提示词 ============================ */

  function systemPrompt(page) {
    var lines = [
      '你是执要 Agent：浏览器页面助手。用户是「执要的圣人」，你是为他效力的助手。',
      '规则：',
      '1. 只输出纯文本，禁止使用 Markdown 标记（#、**、-、> 等）；列表用 1. 2. 3.，表格用对齐文本。',
      '2. 需要操作页面时调用提供的工具；不确定时先问，不要臆造页面内容。',
      '3. 回答简洁、直接给结论；中文提问用中文回答。',
      '4. 不代替用户执行支付/提交/删除等关键动作，除非用户明确要求。',
    ];
    if (page) {
      lines.push('');
      lines.push('当前页面：' + page.title + '（' + page.url + '）');
      if (page.selection) lines.push('用户选中的内容：' + page.selection);
      lines.push('页面正文（截取）：');
      lines.push(page.body);
      if (page.viewport) {
        lines.push('');
        lines.push('视口内文字：');
        lines.push(page.viewport);
      }
    }
    var skillBlock = buildSkillBlock();
    if (skillBlock) {
      lines.push('');
      lines.push(skillBlock);
    }
    return lines.join('\n');
  }

  function estimateTokens(text) {
    var s = String(text || '');
    var cjk = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    var other = Math.max(0, s.length - cjk);
    return Math.max(1, Math.ceil(cjk + other / 4));
  }

  /* ============================ 界面 ============================ */

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:"Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif}',
    '.bubble{position:fixed;right:18px;bottom:18px;width:44px;height:44px;border-radius:50%;background:#0d0d0d;color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.28);z-index:2147483646;border:none}',
    '.bubble:hover{transform:scale(1.06)}',
    '.panel{position:fixed;right:0;top:0;bottom:0;width:380px;background:#fff;color:#0d0d0d;box-shadow:0 0 0 1px #e3e3e3,0 8px 40px rgba(0,0,0,.18);display:flex;flex-direction:column;z-index:2147483647;font-size:14px;line-height:1.55}',
    '.panel.hidden{display:none}',
    '@media (prefers-color-scheme:dark){.panel{background:#212121;color:#ececec;box-shadow:0 0 0 1px #3c3c3c,0 8px 40px rgba(0,0,0,.5)}}',
    '::selection{background:#339cff;color:#fff}',
    '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e3e3e3}',
    '@media (prefers-color-scheme:dark){.head{border-color:#3c3c3c}}',
    '.brand{display:flex;align-items:center;gap:6px;font-weight:600}',
    '.ver{font-size:11px;color:#8e8e8e;border:1px solid #e3e3e3;border-radius:999px;padding:1px 6px}',
    '.spacer{flex:1}',
    '.icon-btn{border:none;background:transparent;cursor:pointer;color:#8e8e8e;font-size:15px;padding:4px 6px;border-radius:6px}',
    '.icon-btn:hover{background:#f4f4f4;color:#0d0d0d}',
    '@media (prefers-color-scheme:dark){.icon-btn:hover{background:#303030;color:#ececec}}',
    '.tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid #e3e3e3}',
    '@media (prefers-color-scheme:dark){.tabs{border-color:#3c3c3c}}',
    '.tab{border:none;background:transparent;color:#8e8e8e;font-size:13px;padding:4px 10px;border-radius:6px;cursor:pointer}',
    '.tab.active{background:#f4f4f4;color:#0d0d0d;font-weight:600}',
    '@media (prefers-color-scheme:dark){.tab.active{background:#303030;color:#ececec}}',
    '.msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:12px}',
    '.msg{display:flex}',
    '.msg.user{justify-content:flex-end}',
    '.bub{max-width:88%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;background:#f4f4f4}',
    '@media (prefers-color-scheme:dark){.bub{background:#303030}}',
    '.msg.user .bub{background:#0d0d0d;color:#fff}',
    '@media (prefers-color-scheme:dark){.msg.user .bub{background:#ececec;color:#1a1a1a}}',
    '.card{border:1px solid #c9c9c9;border-left:3px solid #0d0d0d;border-radius:12px;padding:10px 12px;background:#fff}',
    '@media (prefers-color-scheme:dark){.card{background:#212121;border-color:#4f4f4f;border-left-color:#ececec}}',
    '.card h4{margin:0 0 6px;font-size:13px}',
    '.row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}',
    '.btn{border:1px solid #e3e3e3;background:transparent;color:inherit;border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}',
    '.btn:hover{border-color:#c9c9c9}',
    '.btn.primary{background:#0d0d0d;color:#fff;border-color:#0d0d0d}',
    '@media (prefers-color-scheme:dark){.btn.primary{background:#ececec;color:#1a1a1a;border-color:#ececec}}',
    '.btn.danger{color:#dc2626;border-color:#dc2626}',
    '.chips{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 8px}',
    '.chip{border:1px solid #e3e3e3;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;background:transparent;color:inherit}',
    '.chip:hover{border-color:#c9c9c9}',
    '.composer{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid #e3e3e3}',
    '@media (prefers-color-scheme:dark){.composer{border-color:#3c3c3c}}',
    'textarea{flex:1;resize:none;font:inherit;font-size:14px;color:inherit;background:transparent;border:1px solid #e3e3e3;border-radius:10px;padding:8px 10px;min-height:44px;max-height:140px;outline:none}',
    'textarea:focus{border-color:#c9c9c9}',
    '.send{width:34px;height:34px;border-radius:50%;border:none;background:#0d0d0d;color:#fff;cursor:pointer;display:grid;place-items:center}',
    '@media (prefers-color-scheme:dark){.send{background:#ececec;color:#1a1a1a}}',
    '.send:disabled{opacity:.35;cursor:default}',
    '.stats{padding:0 12px 10px;font-size:11.5px;color:#8e8e8e}',
    '.notice{padding:6px 12px;font-size:12px;color:#0d0d0d;background:#f4f4f4;border-bottom:1px solid #e3e3e3}',
    '@media (prefers-color-scheme:dark){.notice{background:#303030;color:#ececec;border-color:#3c3c3c}}',
    '.err{color:#dc2626}',
    '.settings{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}',
    '.field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#8e8e8e}',
    '.field input,.field select{font:inherit;font-size:14px;color:inherit;padding:8px 10px;border:1px solid #e3e3e3;border-radius:10px;background:transparent;outline:none}',
    '.hint{font-size:12px;color:#8e8e8e;line-height:1.5}',
    '.switch{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;color:inherit}',
    '.ok{color:#10a37f}',
  ].join('\n');

  var ui = {
    host: null,
    root: null,
    panel: null,
    msgs: null,
    composer: null,
    input: null,
    stats: null,
    notice: null,
    chipWrap: null,
    view: 'chat',
  };

  var chat = {
    messages: [],
    streaming: false,
    pending: null,
    autoMode: false,
    translating: false,
    stats: null,
    startedAt: 0,
    inputTokens: 0,
    abort: null,
    lastUserText: '',
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function mount() {
    if (ui.host) return;
    var host = document.createElement('div');
    host.id = 'zhiyao-agent-host';
    host.style.cssText = 'all:initial';
    ui.host = host;
    ui.root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = CSS;
    ui.root.appendChild(style);

    // 悬浮球
    var bubble = el('button', 'bubble');
    bubble.title = '执要 Agent';
    bubble.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 128 128"><path fill-rule="evenodd" fill="currentColor" d="M 64 6 L 54 38 L 74 54 L 54 70 L 74 86 L 64 122 L 128 122 L 128 6 Z M 88 88 m -6 0 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 Z"/><circle cx="40" cy="40" r="6" fill="currentColor"/><rect x="14" y="14" width="100" height="100" rx="16" fill="none" stroke="currentColor" stroke-width="8"/><path d="M 64 6 L 54 38 L 74 54 L 54 70 L 74 86 L 64 122" fill="none" stroke="currentColor" stroke-width="8"/></svg>';
    bubble.addEventListener('click', function () {
      ui.panel.classList.toggle('hidden');
      if (!ui.panel.classList.contains('hidden')) setTimeout(scrollBottom, 0);
    });
    ui.root.appendChild(bubble);

    // 面板
    var panel = el('div', 'panel hidden');
    ui.panel = panel;

    var head = el('div', 'head');
    var brand = el('div', 'brand');
    brand.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 128 128"><path fill-rule="evenodd" fill="currentColor" d="M 64 6 L 54 38 L 74 54 L 54 70 L 74 86 L 64 122 L 128 122 L 128 6 Z M 88 88 m -6 0 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 Z"/><circle cx="40" cy="40" r="6" fill="currentColor"/><rect x="14" y="14" width="100" height="100" rx="16" fill="none" stroke="currentColor" stroke-width="8"/><path d="M 64 6 L 54 38 L 74 54 L 54 70 L 74 86 L 64 122" fill="none" stroke="currentColor" stroke-width="8"/></svg>' +
      '<span>执要 Agent</span>';
    head.appendChild(brand);
    head.appendChild(el('span', 'ver', 'v' + VERSION));
    head.appendChild(el('span', 'spacer'));
    var btnNew = el('button', 'icon-btn', '＋');
    btnNew.title = '新对话';
    btnNew.addEventListener('click', newChat);
    head.appendChild(btnNew);
    var btnClose = el('button', 'icon-btn', '✕');
    btnClose.title = '收起';
    btnClose.addEventListener('click', function () {
      panel.classList.add('hidden');
    });
    head.appendChild(btnClose);
    panel.appendChild(head);

    var tabs = el('div', 'tabs');
    [['chat', '对话'], ['settings', '设置']].forEach(function (pair) {
      var b = el('button', 'tab' + (pair[0] === 'chat' ? ' active' : ''), pair[1]);
      b.dataset.view = pair[0];
      b.addEventListener('click', function () {
        setView(pair[0]);
      });
      tabs.appendChild(b);
    });
    panel.appendChild(tabs);

    ui.notice = el('div', 'notice');
    ui.notice.style.display = 'none';
    panel.appendChild(ui.notice);

    ui.msgs = el('div', 'msgs');
    panel.appendChild(ui.msgs);

    ui.stats = el('div', 'stats');
    ui.stats.style.display = 'none';
    panel.appendChild(ui.stats);

    ui.chipWrap = el('div', 'chips');
    renderChips();
    panel.appendChild(ui.chipWrap);

    ui.composer = el('div', 'composer');
    var ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = '就当前页面提问…（Enter 发送，Shift+Enter 换行）';
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    ui.input = ta;
    ui.composer.appendChild(ta);
    var send = el('button', 'send');
    send.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1.5 12.5 7 7 12.5M12 7H1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    send.title = '发送';
    send.addEventListener('click', sendMessage);
    ui.sendBtn = send;
    ui.composer.appendChild(send);
    panel.appendChild(ui.composer);

    ui.root.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);

    renderMessages();
    updateSendState();
  }

  function scrollBottom() {
    if (ui.msgs) ui.msgs.scrollTop = ui.msgs.scrollHeight;
  }

  function setView(view) {
    ui.view = view;
    var tabs = ui.root.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.view === view);
    ui.msgs.style.display = view === 'chat' ? 'flex' : 'none';
    ui.chipWrap.style.display = view === 'chat' ? 'flex' : 'none';
    ui.composer.style.display = view === 'chat' ? 'flex' : 'none';
    ui.stats.style.display = 'none';
    var old = ui.root.querySelector('.settings');
    if (old) old.remove();
    if (view === 'settings') renderSettings();
    else {
      renderMessages();
      renderStats();
    }
  }

  function renderChips() {
    ui.chipWrap.textContent = '';
    var label = el('span', 'hint', '快捷技能：');
    ui.chipWrap.appendChild(label);
    SKILLS.forEach(function (s) {
      var b = el('button', 'chip', s.name);
      b.title = s.desc;
      b.addEventListener('click', function () {
        installedSkillIds = installedSkillIds.indexOf(s.id) >= 0 ? installedSkillIds : installedSkillIds.concat([s.id]);
        saveSkills();
        renderChips();
        void sendMessage(s.prompt, [s.id]);
      });
      ui.chipWrap.appendChild(b);
    });
  }

  function renderMessages() {
    ui.msgs.textContent = '';
    if (!chat.messages.length) {
      var tip = el('div', 'hint', '就当前页面提问吧。首次使用请到「设置」填写 API Key（仅存本机）。');
      ui.msgs.appendChild(tip);
    }
    chat.messages.forEach(function (m) {
      var row = el('div', 'msg ' + m.role);
      row.appendChild(el('div', 'bub', m.content));
      ui.msgs.appendChild(row);
    });
    if (chat.pending) {
      var card = el('div', 'card');
      card.appendChild(el('h4', null, '提议操作：' + chat.pending.summary));
      var row2 = el('div', 'row');
      var ok = el('button', 'btn primary', '确认执行');
      ok.addEventListener('click', function () {
        resolveDecision('confirm');
      });
      var auto = el('button', 'btn', '批准并自动执行');
      auto.addEventListener('click', function () {
        chat.autoMode = true;
        updateNotice();
        resolveDecision('confirm');
      });
      var no = el('button', 'btn', '取消');
      no.addEventListener('click', function () {
        resolveDecision('cancel');
      });
      row2.appendChild(ok);
      row2.appendChild(auto);
      row2.appendChild(no);
      card.appendChild(row2);
      ui.msgs.appendChild(card);
    }
    scrollBottom();
  }

  function renderStats() {
    if (!chat.stats) {
      ui.stats.style.display = 'none';
      return;
    }
    var s = chat.stats;
    var sec = Math.max(1, Math.round(s.elapsedMs / 1000));
    var text;
    if (!s.done) {
      text = '用时 ' + sec + ' 秒 · 已生成约 ' + s.outputTokens + ' tokens';
      if (s.etaSec != null && s.etaSec > 0) text += ' · 预计还需约 ' + s.etaSec + ' 秒';
    } else {
      text =
        '用时 ' + sec + ' 秒 · 输入约 ' + s.inputTokens + ' tokens · 输出约 ' + s.outputTokens +
        ' tokens · 合计约 ' + (s.inputTokens + s.outputTokens) + ' tokens';
    }
    ui.stats.textContent = text;
    ui.stats.style.display = 'block';
  }

  function updateNotice() {
    var lines = [];
    if (chat.autoMode) lines.push('任务模式：后续步骤自动执行（支付/提交/密码等仍会确认），可随时点「新对话」中止');
    if (chat.translating) lines.push('整页翻译进行中：请勿滚动页面，直到翻译完成');
    if (lines.length) {
      ui.notice.textContent = lines.join('　|　');
      ui.notice.style.display = 'block';
    } else {
      ui.notice.style.display = 'none';
    }
  }

  function updateSendState() {
    if (!ui.sendBtn) return;
    ui.sendBtn.disabled = chat.streaming;
  }

  function renderSettings() {
    var wrap = el('div', 'settings');
    function field(labelText, inputEl) {
      var f = el('label', 'field');
      f.appendChild(el('span', null, labelText));
      f.appendChild(inputEl);
      wrap.appendChild(f);
      return inputEl;
    }
    var presets = [
      ['https://api.deepseek.com/v1', 'deepseek-chat', 'DeepSeek'],
      ['https://api.openai.com/v1', 'gpt-4o-mini', 'OpenAI'],
      ['https://api.moonshot.cn/v1', 'moonshot-v1-128k', 'Kimi'],
      ['https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash', '智谱 GLM'],
      ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', '通义千问'],
      ['https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V3', 'SiliconFlow'],
    ];
    var sel = document.createElement('select');
    presets.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p[0] + '|' + p[1];
      o.textContent = p[2];
      sel.appendChild(o);
    });
    sel.value = settings.baseUrl + '|' + settings.model;
    sel.addEventListener('change', function () {
      var parts = sel.value.split('|');
      settings.baseUrl = parts[0];
      settings.model = parts[1];
      saveSettings();
      renderSettings();
    });
    field('服务商预设', sel);

    var base = document.createElement('input');
    base.value = settings.baseUrl;
    base.addEventListener('change', function () {
      settings.baseUrl = base.value.trim();
      saveSettings();
    });
    field('Base URL（OpenAI 兼容）', base);

    var key = document.createElement('input');
    key.type = 'password';
    key.value = settings.apiKey;
    key.placeholder = 'sk-...';
    key.addEventListener('change', function () {
      settings.apiKey = key.value.trim();
      saveSettings();
    });
    field('API Key（仅存本机）', key);

    var modelRow = el('div', 'row');
    var model = document.createElement('input');
    model.value = settings.model;
    model.style.flex = '1';
    model.addEventListener('change', function () {
      settings.model = model.value.trim();
      saveSettings();
    });
    var fetchBtn = el('button', 'btn', '获取模型列表');
    fetchBtn.addEventListener('click', async function () {
      fetchBtn.textContent = '获取中…';
      try {
        var models = await fetchModels();
        var pick = document.createElement('select');
        models.forEach(function (m) {
          var o = document.createElement('option');
          o.value = m;
          o.textContent = m;
          pick.appendChild(o);
        });
        pick.value = settings.model;
        pick.addEventListener('change', function () {
          settings.model = pick.value;
          saveSettings();
          model.value = pick.value;
        });
        modelRow.textContent = '';
        modelRow.appendChild(pick);
        fetchBtn.textContent = '已获取 ' + models.length + ' 个模型';
        modelRow.appendChild(fetchBtn);
      } catch (e) {
        fetchBtn.textContent = '获取失败：' + (e && e.message ? e.message : e);
      }
    });
    modelRow.appendChild(model);
    modelRow.appendChild(fetchBtn);
    var modelField = el('div', 'field');
    modelField.appendChild(el('span', null, '模型'));
    modelField.appendChild(modelRow);
    wrap.appendChild(modelField);

    var sw = el('label', 'switch');
    sw.appendChild(el('span', null, '发送前自动读取当前页面'));
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings.autoReadPage;
    cb.addEventListener('change', function () {
      settings.autoReadPage = cb.checked;
      saveSettings();
    });
    sw.appendChild(cb);
    wrap.appendChild(sw);

    var hint = el('p', 'hint');
    hint.textContent =
      '数据只存在本机（脚本管理器存储）；页面内容只发送给你自己配置的模型服务。' +
      '整页翻译与去广告由 AI 按你的指令执行，操作前会逐步确认。';
    wrap.appendChild(hint);

    // 测试连接：把失败原因（HTTP 状态 + 服务端原文）直接显示出来
    var testBtn = el('button', 'btn primary', '测试连接');
    var testOut = el('p', 'hint');
    testBtn.addEventListener('click', async function () {
      testBtn.disabled = true;
      testBtn.textContent = '测试中…';
      try {
        await testConnection();
        testOut.className = 'hint ok';
        testOut.textContent = '成功：Base URL / Key / 模型都可用。';
      } catch (e) {
        testOut.className = 'hint err';
        testOut.textContent =
          '失败：' +
          (e && e.message ? e.message : String(e)) +
          '　（若为网络/CORS 错误：到脚本猫的脚本设置里确认「跨域权限」已允许该域名）';
      }
      testBtn.disabled = false;
      testBtn.textContent = '测试连接';
    });
    wrap.appendChild(testBtn);
    wrap.appendChild(testOut);

    ui.panel.appendChild(wrap);
  }

  /* ============================ 确认流程 ============================ */

  var pendingResolve = null;

  function waitDecision() {
    return new Promise(function (resolve) {
      pendingResolve = resolve;
    });
  }

  function resolveDecision(d) {
    if (pendingResolve) {
      var r = pendingResolve;
      pendingResolve = null;
      chat.pending = null;
      renderMessages();
      r(d);
    }
  }

  /* ============================ 对话主循环 ============================ */

  function newChat() {
    if (chat.abort) chat.abort.abort();
    chat.messages = [];
    chat.pending = null;
    chat.autoMode = false;
    chat.translating = false;
    chat.stats = null;
    chat.streaming = false;
    renderMessages();
    renderStats();
    updateNotice();
    updateSendState();
  }

  function pushMsg(role, content) {
    chat.messages.push({ role: role, content: content });
    renderMessages();
  }

  function setLastAssistant(content) {
    for (var i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') {
        chat.messages[i].content = content;
        renderMessages();
        return;
      }
    }
    pushMsg('assistant', content);
  }

  function appendDelta(delta) {
    for (var i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant') {
        chat.messages[i].content += delta;
        renderMessages();
        return;
      }
    }
    pushMsg('assistant', delta);
  }

  async function sendMessage(forcedText, forceSkillIds) {
    if (chat.streaming) return;
    var text = forcedText != null ? forcedText : ui.input.value.trim();
    if (!text) return;
    if (!settings.apiKey) {
      setView('settings');
      return;
    }
    if (forcedText == null) ui.input.value = '';

    var skills = SKILLS.filter(function (s) {
      return skillOn(s.id) || (forceSkillIds && forceSkillIds.indexOf(s.id) >= 0);
    });
    var page = settings.autoReadPage ? readPage() : null;
    var history = chat.messages.slice(-12);

    pushMsg('user', text);
    pushMsg('assistant', '');
    chat.streaming = true;
    updateSendState();

    var modelMsgs = [{ role: 'system', content: systemPrompt(page) }];
    history.forEach(function (m) {
      modelMsgs.push({ role: m.role, content: m.content });
    });
    modelMsgs.push({ role: 'user', content: text });

    chat.startedAt = Date.now();
    chat.inputTokens = modelMsgs.reduce(function (sum, m) {
      return sum + estimateTokens(m.content || '') + 8;
    }, 0);
    chat.stats = { elapsedMs: 0, inputTokens: chat.inputTokens, outputTokens: 0, done: false, etaSec: null };
    renderStats();

    var timer = setInterval(function () {
      var last = chat.messages[chat.messages.length - 1];
      var out = estimateTokens(last && last.role === 'assistant' ? last.content : '');
      var elapsedMs = Date.now() - chat.startedAt;
      var rate = elapsedMs > 1000 ? out / (elapsedMs / 1000) : 0;
      var remain = Math.max(0, OUTPUT_CAP_TOKENS - out);
      chat.stats = {
        elapsedMs: elapsedMs,
        inputTokens: chat.inputTokens,
        outputTokens: out,
        done: false,
        etaSec: rate > 0 ? Math.round(remain / rate) : null,
      };
      renderStats();
    }, 500);

    var stepLimit = skills.some(function (s) {
      return s.id === 'remove-ads';
    })
      ? MAX_STEPS_AD_REMOVAL
      : MAX_STEPS;
    var abort = new AbortController();
    chat.abort = abort;
    var tools = toOpenAITools();

    try {
      var steps = 0;
      var stopped = false;
      var finalText = '';
      while (steps < stepLimit && !stopped) {
        steps++;
        var round = await callModel(modelMsgs, tools, appendDelta, abort.signal);
        var roundText = round.text || '';

        if (round.toolCalls && round.toolCalls.length) {
          var handled = await handleToolCall(round.toolCalls[0], roundText, modelMsgs);
          if (handled) {
            stopped = true;
            break;
          }
          if (INTERNAL_TOOLS[round.toolCalls[0].name]) steps--;
          continue;
        }
        finalText = roundText;
        stopped = true;
      }
      if (steps >= stepLimit && !finalText) setLastAssistant('已达到最大操作步数（' + stepLimit + ' 步），已停止。请继续描述下一步。');
      var outTokens = estimateTokens(finalText);
      chat.stats = {
        elapsedMs: Date.now() - chat.startedAt,
        inputTokens: chat.inputTokens,
        outputTokens: outTokens,
        done: true,
        etaSec: null,
      };
    } catch (e) {
      if (e && e.name === 'AbortError') setLastAssistant('已停止。');
      else {
        var message = e && e.message ? e.message : String(e);
        setLastAssistant('出错了：' + message);
        if (typeof GM_notification === 'function' && /HTTP 429|overloaded|quota/i.test(message)) {
          try {
            GM_notification({ text: '模型服务繁忙或额度不足，请稍后再试', title: '执要 Agent' });
          } catch (err) {
            /* ignore */
          }
        }
      }
    } finally {
      clearInterval(timer);
      chat.streaming = false;
      chat.translating = false;
      chat.abort = null;
      renderStats();
      updateNotice();
      updateSendState();
    }
  }

  async function handleToolCall(raw, roundText, modelMsgs) {
    var parsedArgs;
    try {
      parsedArgs = JSON.parse(raw.arguments || '{}');
    } catch (e) {
      parsedArgs = null;
    }
    modelMsgs.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: [{ id: raw.id, type: 'function', function: { name: raw.name, arguments: raw.arguments } }],
    });
    var v = parsedArgs ? validateToolCall({ tool: raw.name, args: parsedArgs }) : { ok: false, error: '参数不是合法 JSON（可能被输出长度截断）' };
    if (!v.ok) {
      setLastAssistant('（操作不完整：' + v.error + '，已让模型重试）');
      modelMsgs.push({
        role: 'tool',
        tool_call_id: raw.id,
        content: JSON.stringify({ ok: false, error: v.error, hint: '请修正参数后重试；批量翻译请减少单批条数' }),
      });
      pushMsg('assistant', '');
      return false;
    }
    var call = v.call;
    if (call.tool === 'get_texts' || call.tool === 'translate_page') {
      chat.translating = true;
      updateNotice();
    }
    if (call.tool === 'snapshot') {
      var snap = execAction({ tool: 'snapshot' });
      setLastAssistant('已读取页面交互元素');
      modelMsgs.push({ role: 'tool', tool_call_id: raw.id, content: JSON.stringify(snap) });
      pushMsg('assistant', '');
      return false;
    }
    if (INTERNAL_TOOLS[call.tool]) {
      var src = execAction({ tool: call.tool });
      setLastAssistant('操作结果：' + src.message);
      modelMsgs.push({ role: 'tool', tool_call_id: raw.id, content: JSON.stringify(src) });
      pushMsg('assistant', '');
      return false;
    }

    var def = findTool(call.tool);
    var summary = toolSummary(call);
    var argText = [call.args.text, call.args.html, call.args.name, call.args.value, call.args.url, call.args.lang]
      .filter(function (x) {
        return typeof x === 'string' && x;
      })
      .join(' ');
    var dangerous = !!SENSITIVE_TOOLS[call.tool] || DANGER_RE.test(summary) || DANGER_RE.test(argText);
    setLastAssistant(summary);
    if (!chat.autoMode || dangerous) {
      chat.pending = { summary: summary };
      renderMessages();
      var decision = await waitDecision();
      if (decision === 'cancel') {
        setLastAssistant('已取消操作。');
        modelMsgs.push({ role: 'tool', tool_call_id: raw.id, content: JSON.stringify({ ok: false, error: '用户取消了该操作' }) });
        pushMsg('assistant', '');
        return false;
      }
    }

    var result = execAction({
      tool: call.tool,
      index: call.args.index == null ? null : call.args.index,
      selector: call.args.selector,
      text: call.tool === 'translate_page' ? JSON.stringify(call.args.items || []) : call.args.text,
      amount: call.args.amount,
      html: call.args.html,
      name: call.args.name,
      value: call.args.value,
      lang: call.args.lang,
      items: call.args.items,
      url: call.args.url,
    });
    var resultText = '操作结果：' + result.message + (result.data ? '\n' + String(result.data).slice(0, 1500) : '');
    pushMsg('user', resultText);
    modelMsgs.push({ role: 'tool', tool_call_id: raw.id, content: JSON.stringify(result) });
    pushMsg('assistant', '');
    return false;
  }

  function toolSummary(call) {
    var names = {
      click: '点击',
      type: '输入',
      select: '选择',
      scroll: '滚动',
      read_text: '读取文本',
      read_html: '读取 HTML',
      edit_text: '修改文字',
      edit_html: '修改 HTML',
      set_attribute: '设置属性',
      remove_element: '移除元素',
      hide_element: '隐藏元素',
      extract_table: '提取表格',
      copy: '复制',
      translate_page: '翻译替换页面',
      get_texts: '读取文字元素',
      get_media: '探索媒体',
      download_media: '下载媒体',
      open_in_new_tab: '打开链接',
    };
    var name = names[call.tool] || call.tool;
    var extra = '';
    if (call.tool === 'type' || call.tool === 'select' || call.tool === 'open_in_new_tab') extra = '「' + call.args.text + '」';
    else if (call.tool === 'scroll') extra = ' ' + (call.args.amount || 0) + 'px';
    else if (call.tool === 'translate_page') extra = '（' + ((call.args.items || []).length) + ' 处）';
    else if (call.tool === 'download_media') extra = '：' + call.args.url;
    return '提议操作：' + name + extra;
  }

  /* ============================ 启动 ============================ */

  function boot() {
    if (!document.body) return;
    mount();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('打开 / 收起执要 Agent', function () {
        mount();
        ui.panel.classList.toggle('hidden');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
