/**
 * 网页操作执行器（按需注入，无外部依赖，禁止 import）。
 * 注入后挂载 window.__zhiyaoExec(payload)，由 background 通过 executeScript(func) 调用。
 * 白名单动作：click / type / select / scroll / read_text / read_html / extract_table / copy
 * 仅派发原生 DOM 事件，绝不执行任何注入的代码。
 */
(() => {
  'use strict';

  var SEL =
    'button, a[href], input, select, textarea, [role="button"], [role="link"], ' +
    '[role="checkbox"], [role="menuitem"], [role="tab"], [contenteditable="true"], summary';

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inViewport(el, pad) {
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight;
    return r.bottom > -pad && r.top < vh + pad;
  }

  /** 与 page-snapshot.js 相同的采集逻辑，保证 index 一致 */
  function collect() {
    var all = Array.prototype.filter.call(document.querySelectorAll(SEL), isVisible);
    var viewport = all.filter(function (el) {
      return inViewport(el, 200);
    });
    var rest = all.filter(function (el) {
      return !inViewport(el, 200);
    });
    return viewport.concat(rest);
  }

  function describeTarget(el) {
    var tag = el.tagName.toLowerCase();
    var text = '';
    if (tag === 'input') text = el.value || el.getAttribute('placeholder') || '';
    else text = (el.innerText || el.textContent || '').trim();
    return {
      tag: tag,
      text: String(text || '').slice(0, 50),
      aria: String(el.getAttribute('aria-label') || '').slice(0, 50),
    };
  }

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
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function focusAndType(el, text) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' in Element.prototype ? 'instant' : 'auto' });
    el.focus({ preventScroll: true });
    nativeSetValue(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickEl(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' in Element.prototype ? 'instant' : 'auto' });
    mouseSequence(el, 'click');
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
      else if (match === null && o.text.trim() === text.trim()) match = o.value;
    }
    if (match !== null) value = match;
    el.scrollIntoView({ block: 'center' });
    nativeSetValue(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function extractTable(el) {
    var table = el.closest ? el.closest('table') : null;
    if (!table) return '';
    var rows = Array.prototype.slice.call(table.querySelectorAll('tr')).slice(0, 50);
    return rows
      .map(function (tr) {
        return Array.prototype.slice
          .call(tr.querySelectorAll('th,td'))
          .map(function (cell) {
            var t = (cell.innerText || '').trim().replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
            return '"' + t + '"';
          })
          .join(',');
      })
      .join('\n');
  }

  function copyText(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  /** 整页 HTML 源码：去除 script/style/noscript/svg 与注释后截断，节省 token */
  function getPageSource() {
    var clone = document.documentElement.cloneNode(true);
    var junk = clone.querySelectorAll('script, style, noscript, svg, link[rel="stylesheet"]');
    for (var i = 0; i < junk.length; i++) junk[i].remove();
    // 去掉注释
    var walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    var comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    for (var j = 0; j < comments.length; j++) comments[j].parentNode && comments[j].parentNode.removeChild(comments[j]);
    var html = clone.outerHTML || '';
    // 压缩多余空白
    html = html.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    return html.slice(0, 20000);
  }

  /**
   * 清洗注入的 HTML：去 script/iframe/svg/math 等与所有 on* 事件属性、
   * javascript:/data: 等危险 URL（含 SVG 的 xlink:href）。
   */
  function sanitizeHtml(html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var bad = tpl.content.querySelectorAll(
      'script, style, iframe, frame, frameset, link, meta, object, embed, form, svg, math'
    );
    for (var i = 0; i < bad.length; i++) bad[i].remove();
    var URL_ATTRS = ['href', 'src', 'xlink:href', 'formaction', 'action', 'poster'];
    var all = tpl.content.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var k = 0; k < attrs.length; k++) {
        var a = attrs[k];
        var isUrlAttr = URL_ATTRS.indexOf(a.name.toLowerCase()) >= 0;
        var dangerous =
          /^on/i.test(a.name) ||
          (isUrlAttr && /^\s*(javascript|vbscript|data):/i.test(a.value));
        if (dangerous) el.removeAttribute(a.name);
      }
    }
    return tpl.innerHTML;
  }

  /** 媒体资源探测：video/audio 元素与常见媒体直链（排除 m3u8 分片与 DRM 平台） */
  function collectMedia() {
    var out = [];
    var seen = {};
    function add(kind, url, label) {
      if (!url || seen[url]) return;
      var abs = url;
      try {
        abs = new URL(url, location.href).href;
      } catch (e) {
        return;
      }
      if (!/^https?:/i.test(abs)) return;
      // 排除流媒体播放列表（m3u8 只是清单，不是文件）
      if (/\.m3u8(\?|$)/i.test(abs)) return;
      if (seen[abs]) return;
      seen[abs] = 1;
      out.push({
        i: out.length,
        kind: kind,
        url: abs,
        title: String(label || '').slice(0, 80),
      });
    }
    // 1) 视频/音频元素
    var media = document.querySelectorAll('video, audio');
    for (var i = 0; i < media.length; i++) {
      var el = media[i];
      var src = el.currentSrc || el.getAttribute('src') || '';
      var kind = el.tagName.toLowerCase() === 'video' ? 'video' : 'audio';
      add(kind, src, el.getAttribute('title') || el.getAttribute('aria-label') || src.split('/').pop());
      var sources = el.querySelectorAll('source');
      for (var j = 0; j < sources.length; j++) {
        add(kind, sources[j].getAttribute('src'), sources[j].getAttribute('title') || '');
      }
    }
    // 2) 直链媒体文件（视频/音频常见扩展名）
    var links = document.querySelectorAll('a[href]');
    var extRe = /\.(mp4|webm|m4v|mov|mkv|avi|ts|mp3|wav|flac|ogg|oga|aac|m4a|opus)(\?|#|$)/i;
    for (var k = 0; k < links.length && out.length < 100; k++) {
      var href = links[k].getAttribute('href') || '';
      if (extRe.test(href)) {
        add('link', href, (links[k].innerText || '').trim() || links[k].getAttribute('title') || '');
      }
    }
    return out;
  }
  /** 元素的直接文本（只取文本节点与行内元素，避免嵌套重复） */
  function getDirectText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) {
        t += n.textContent;
      } else if (n.nodeType === 1 && /^(B|I|EM|STRONG|SPAN|A|CODE|BR|SMALL|MARK)$/i.test(n.tagName)) {
        t += n.textContent;
      }
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  function stableSelector(el) {
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + name + '"]';
    var aria = el.getAttribute('aria-label');
    if (aria && aria.length <= 60) return tag + '[aria-label="' + aria + '"]';
    var parts = [];
    var cur = el;
    for (var i = 0; cur && cur !== document.body && i < 4; i++) {
      var t = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(cur.id) : cur.id));
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

  /** 文字元素清单（get_texts 与 translate_page 共用同一顺序） */
  function collectTextEls() {
    var all = Array.prototype.filter.call(document.querySelectorAll(TEXT_SEL), isVisible);
    var viewport = all.filter(function (el) {
      return inViewport(el, 100);
    });
    var rest = all.filter(function (el) {
      return !inViewport(el, 100);
    });
    var out = [];
    var seen = new Set();
    var list = viewport.concat(rest);
    for (var i = 0; i < list.length && out.length < 150; i++) {
      var el = list[i];
      if (seen.has(el)) continue;
      var text = getDirectText(el);
      if (!text || text.length < 1) continue;
      seen.add(el);
      out.push({
        i: out.length,
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 300),
        selector: stableSelector(el),
      });
    }
    return out;
  }

  /** 替换元素直接文本（保留子元素与格式），返回是否成功 */
  function setTranslatedText(el, text) {
    for (var i = el.childNodes.length - 1; i >= 0; i--) {
      if (el.childNodes[i].nodeType === 3) el.removeChild(el.childNodes[i]);
    }
    el.insertBefore(document.createTextNode(String(text)), el.firstChild);
  }

  function exec(payload) {
    // 整页源码：无需目标元素
    if (payload.tool === 'page_source') {
      var src = getPageSource();
      return { ok: true, message: '已读取页面源码', data: src, urlChanged: false, newUrl: location.href };
    }

    // 文字元素清单：无需目标元素
    if (payload.tool === 'get_texts') {
      var texts = collectTextEls();
      return {
        ok: true,
        message: '已读取 ' + texts.length + ' 个文字元素',
        data: JSON.stringify(texts),
        urlChanged: false,
        newUrl: location.href,
      };
    }

    // 媒体资源清单：无需目标元素
    if (payload.tool === 'get_media') {
      var media = collectMedia();
      return {
        ok: true,
        message: '发现 ' + media.length + ' 个媒体资源',
        data: JSON.stringify(media),
        urlChanged: false,
        newUrl: location.href,
      };
    }

    // 批量翻译替换：无需目标元素，items 按 index 定位。
    // items 优先取数组参数；若数组丢失（传输层防御），回退解析 text 中的 JSON 字符串。
    if (payload.tool === 'translate_page') {
      var items = payload.items;
      if ((!items || !items.length) && typeof payload.text === 'string') {
        try {
          items = JSON.parse(payload.text);
        } catch (e) {
          items = null;
        }
      }
      if (!items || !items.length) {
        return {
          ok: false,
          message:
            '缺少译文清单（items=' + typeof payload.items + '/' + (payload.items ? payload.items.length : 0) +
            '，text=' + typeof payload.text + '）',
        };
      }
      var els2 = collectTextEls();
      var done = 0;
      var failed = [];
      for (var m = 0; m < items.length; m++) {
        var item = items[m];
        var target = els2[item.index];
        if (!target || !target.selector) {
          failed.push(item.index);
          continue;
        }
        var elm = null;
        try {
          elm = document.querySelector(target.selector);
        } catch (e) {
          elm = null;
        }
        if (!elm) {
          failed.push(item.index);
          continue;
        }
        setTranslatedText(elm, item.text);
        done++;
      }
      return {
        ok: true,
        message: '已替换 ' + done + ' 处文字' + (failed.length ? '（' + failed.length + ' 处未找到）' : ''),
        urlChanged: false,
        newUrl: location.href,
      };
    }

    var els = collect();
    var el = null;
    var via = '';
    if (payload.index != null && payload.index >= 0) {
      el = els[payload.index] || null;
      via = 'index #' + payload.index;
    }
    if (!el && payload.selector) {
      try {
        el = document.querySelector(payload.selector);
      } catch (e) {
        el = null;
      }
      if (el) via = 'selector ' + payload.selector;
    }
    if (!el) {
      return { ok: false, message: '目标元素未找到（页面可能已变化，请重新分析）' };
    }
    if (el.disabled) {
      return { ok: false, message: '目标元素已禁用，无法操作' };
    }
    var desc = describeTarget(el);
    var label = desc.text || desc.aria || '<' + desc.tag + '>';
    var before = location.href;

    switch (payload.tool) {
      case 'click':
        clickEl(el);
        break;
      case 'type':
        if (payload.text == null) return { ok: false, message: '缺少输入内容' };
        focusAndType(el, String(payload.text));
        break;
      case 'select':
        if (payload.text == null) return { ok: false, message: '缺少选项值' };
        selectOption(el, String(payload.text));
        break;
      case 'scroll':
        window.scrollBy({ top: Number(payload.amount) || 0, behavior: 'smooth' });
        break;
      case 'read_text': {
        var txt = (el.innerText || el.textContent || '').trim().slice(0, 4000);
        return { ok: true, message: '已读取文本', data: txt, urlChanged: false, newUrl: after(before) };
      }
      case 'read_html': {
        var html = (el.outerHTML || '').slice(0, 12000);
        return { ok: true, message: '已读取 HTML', data: html, urlChanged: false, newUrl: after(before) };
      }
      case 'extract_table': {
        var csv = extractTable(el);
        if (!csv) return { ok: false, message: '未找到表格' };
        return { ok: true, message: '已提取表格', data: csv, urlChanged: false, newUrl: after(before) };
      }
      case 'copy': {
        var t2 = (el.innerText || el.textContent || el.value || '').trim().slice(0, 4000);
        var ok = copyText(t2);
        return {
          ok: ok,
          message: ok ? '已复制到剪贴板' : '复制失败',
          data: t2.slice(0, 500),
          urlChanged: false,
          newUrl: after(before),
        };
      }
      case 'edit_text': {
        if (payload.text == null) return { ok: false, message: '缺少文本' };
        el.textContent = String(payload.text);
        break;
      }
      case 'edit_html': {
        if (payload.html == null) return { ok: false, message: '缺少 HTML' };
        el.innerHTML = sanitizeHtml(String(payload.html));
        break;
      }
      case 'set_attribute': {
        var attrName = String(payload.name || '');
        var attrValue = String(payload.value == null ? '' : payload.value);
        // 与 core/tools.ts 同一套约束：事件属性、srcdoc/formaction 一律拒绝；
        // URL 类属性只允许 http(s)/相对地址，阻断 javascript:/data: 注入。
        if (/^on/i.test(attrName) || /^(srcdoc|formaction)$/i.test(attrName)) {
          return { ok: false, message: '属性被禁止' };
        }
        if (/^(href|src|xlink:href|action|poster)$/i.test(attrName) &&
            /^\s*(javascript|vbscript|data):/i.test(attrValue)) {
          return { ok: false, message: 'URL 类属性仅允许 http(s) 或相对地址' };
        }
        el.setAttribute(attrName, attrValue);
        break;
      }
      case 'remove_element':
        el.remove();
        break;
      case 'hide_element':
        el.style.display = 'none';
        break;
      default:
        return { ok: false, message: '未知操作：' + payload.tool };
    }

    var afterUrl = location.href;
    return {
      ok: true,
      message: '已执行 ' + payload.tool + ' → ' + label + '（' + via + '）',
      urlChanged: before !== afterUrl,
      newUrl: afterUrl,
    };
  }

  function after(before) {
    return location.href;
  }

  window.__zhiyaoExec = function (payload) {
    try {
      return exec(payload || {});
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  };
})();
