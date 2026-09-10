/**
 * 交互元素快照（按需注入，无外部依赖，禁止 import）。
 * 通过 chrome.scripting.executeScript 注入后，其完成值即快照 JSON。
 * 结构必须与 src/core/protocol.ts 的 SnapshotDataSchema 一致。
 */
(() => {
  'use strict';

  var MAX = 200;
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

  function escapeSel(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/"/g, '\\"');
  }

  function stableSelector(el) {
    if (el.id) return '#' + escapeSel(el.id);
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + escapeSel(name) + '"]';
    var aria = el.getAttribute('aria-label');
    if (aria && aria.length <= 60) return tag + '[aria-label="' + escapeSel(aria) + '"]';
    var parts = [];
    var cur = el;
    for (var i = 0; cur && cur !== document.body && i < 4; i++) {
      var t = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift('#' + escapeSel(cur.id));
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

  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var text = '';
    if (tag === 'input') {
      text = el.value || el.getAttribute('placeholder') || '';
    } else if (tag === 'select') {
      var opt = el.options && el.options[el.selectedIndex];
      text = opt ? opt.text : el.value;
    } else {
      text = (el.innerText || el.textContent || '').trim();
    }
    return {
      tag: tag,
      text: String(text || '').slice(0, 60),
      aria: String(el.getAttribute('aria-label') || '').slice(0, 60),
      type: String(el.getAttribute('type') || ''),
      role: String(el.getAttribute('role') || ''),
      value: String(el.value || '').slice(0, 60),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      checked: el.checked == null ? null : !!el.checked,
    };
  }

  function build() {
    var all = Array.prototype.filter.call(document.querySelectorAll(SEL), isVisible);
    var viewport = all.filter(function (el) {
      return inViewport(el, 200);
    });
    var rest = all.filter(function (el) {
      return !inViewport(el, 200);
    });
    var chosen = viewport.concat(rest).slice(0, MAX);
    var elements = chosen.map(function (el, i) {
      var r = el.getBoundingClientRect();
      var d = describe(el);
      return {
        i: i,
        tag: d.tag,
        text: d.text,
        aria: d.aria,
        type: d.type,
        role: d.role,
        value: d.value,
        disabled: d.disabled,
        checked: d.checked,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        selector: stableSelector(el),
      };
    });
    return {
      ok: true,
      url: location.href,
      title: String(document.title || '').slice(0, 200),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      total: all.length,
      truncated: all.length > MAX,
      elements: elements,
    };
  }

  try {
    return build();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})();
