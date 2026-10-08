// ==UserScript==
// @name         执要 Agent · 定时任务（配套后台脚本）
// @name:en      ZhiYao Agent - Scheduled Tasks (companion background script)
// @namespace    https://github.com/zhiyao-agent
// @version      2.0.0
// @description  执要 Agent 的定时任务执行器。对应扩展版的 chrome.alarms + notifications：到点抓取指定网页、让模型判断是否值得注意、发系统通知。这是脚本猫（ScriptCat）专有的后台脚本，需与主脚本 zhiyao-agent.user.js 配套安装。
// @description:en  Scheduled-task runner for ZhiYao Agent. The userscript counterpart of the extension's chrome.alarms + notifications. ScriptCat-only background script; install alongside zhiyao-agent.user.js.
// @author       axron
// @license      MIT
// @background
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      *
// @storageName  zhiyao-agent
// ==/UserScript==

/*
 * 这是脚本猫专有的后台脚本（@background），运行在沙盒里、没有 DOM。
 * 它和主脚本 zhiyao-agent.user.js 通过同一个 @storageName 共享存储：
 *   - 主脚本写入任务表（scheduled_tasks）与设置（settings），读心跳（taskHeartbeat）
 *   - 本脚本读任务表、执行检查、把结果写回任务的 lastRunAt/lastStatus/lastMessage，
 *     并周期性写下心跳，让主脚本知道「定时任务确实在跑」
 *
 * 对应扩展版实现：extension/src/entrypoints/background.ts 的 alarms 监听 + runTaskInner。
 * 扩展用 chrome.alarms（关浏览器也在系统层保留），用户脚本没有等价物，
 * 因此这里用「常驻 + 自调度 setTimeout 循环」来逼近——只要浏览器/脚本猫在运行就会触发。
 */

(function () {
  'use strict';

  var TICK_MS = 30000; // 每 30 秒检查一次是否有任务到期
  var HEARTBEAT_MS = 30000; // 心跳间隔（主脚本用 120 秒判活）
  var PAGE_TIMEOUT_MS = 30000; // 抓取网页的超时（与扩展一致）
  var PAGE_MAX_CHARS = 6000; // 抓取正文截断（与扩展一致）
  var JUDGE_MAX_TOKENS = 400; // 判定调用的输出上限（与扩展一致）

  var KEY_TASKS = 'scheduled_tasks';
  var KEY_SETTINGS = 'settings';
  var KEY_HEARTBEAT = 'taskHeartbeat';

  /* ============================ 存储 ============================ */

  function gmGet(key, fallback) {
    try {
      var v = typeof GM_getValue === 'function' ? GM_getValue(key, null) : null;
      if (v == null) return fallback;
      if (typeof v === 'string') {
        try {
          return JSON.parse(v);
        } catch (e) {
          return v;
        }
      }
      return v;
    } catch (e) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, JSON.stringify(value));
    } catch (e) {
      /* 忽略 */
    }
  }

  function loadTasks() {
    var raw = gmGet(KEY_TASKS, []);
    return Array.isArray(raw) ? raw : [];
  }

  function loadSettings() {
    var raw = gmGet(KEY_SETTINGS, null);
    return raw && typeof raw === 'object' ? raw : {};
  }

  /* ============================ 文案 ============================ */

  var TEXT = {
    zh: {
      notConfigured: '未配置模型服务：请先在执要 Agent 面板的「设置」里添加服务商与 API Key。',
      noKey: '该服务商未配置 API Key，请到「设置」中填写。',
      fetchFailed: '抓取网页失败',
      emptyPage: '页面没有取到可读正文。',
      netError: '网络错误',
    },
    en: {
      notConfigured: 'No model provider configured: add one with an API key in the ZhiYao Agent settings first.',
      noKey: 'The active provider has no API key. Add it in Settings.',
      fetchFailed: 'Failed to fetch the page',
      emptyPage: 'No readable text found on the page.',
      netError: 'Network error',
    },
  };

  /** 语言跟随主脚本设置（同一份共享存储） */
  function tt(key) {
    var lang = loadSettings().lang;
    if (lang !== 'zh' && lang !== 'en') {
      // 未指定时按任务内容猜：默认中文（面向中文用户）
      lang = 'zh';
    }
    return (TEXT[lang] && TEXT[lang][key]) || TEXT.zh[key] || key;
  }

  /* ============================ 网络 ============================ */

  /** 统一的跨域请求（后台脚本里 GM_xmlhttpRequest 比 fetch 可靠） */
  function request(opts) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: opts.timeout || PAGE_TIMEOUT_MS,
        onload: function (res) {
          resolve({ status: res.status, text: res.responseText || '' });
        },
        onerror: function () {
          reject(new Error(tt('netError')));
        },
        ontimeout: function () {
          reject(new Error(tt('fetchFailed') + '：timeout'));
        },
      });
    });
  }

  function stripTags(html) {
    return String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 抓取网页正文（对应扩展的 fetchPageText：30s 超时、剥标签、截 6000 字） */
  async function fetchPageText(url) {
    var res = await request({ url: url, timeout: PAGE_TIMEOUT_MS });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(tt('fetchFailed') + '：HTTP ' + res.status);
    }
    var raw = res.text;
    var titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
    var title = titleMatch ? stripTags(titleMatch[1]) : '';
    // JSON 响应直接当正文用
    var text = /^\s*[[{]/.test(raw) ? raw : stripTags(raw);
    text = text.slice(0, PAGE_MAX_CHARS);
    return { title: title.slice(0, 200), text: text };
  }

  /** 让模型判断页面是否值得注意（对应 judgeWithLlm：非流式、max_tokens 400） */
  async function judgeWithLlm(task, page) {
    var settings = loadSettings();
    var providers = settings.providers || [];
    var provider = null;
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].id === settings.activeProviderId) provider = providers[i];
    }
    if (!provider) provider = providers[0] || null;
    if (!provider) throw new Error(tt('notConfigured'));
    if (!provider.baseUrl || !provider.activeModel) throw new Error(tt('notConfigured'));

    var keys = gmGet('apiKeys', {}) || {};
    var apiKey = keys[provider.id] || '';
    if (!apiKey) throw new Error(tt('noKey'));

    var body = JSON.stringify({
      model: provider.activeModel,
      messages: [
        {
          role: 'system',
          content:
            '你是网页定时监控助手。根据用户指令检查网页内容并输出结论：纯文本、不超过 200 字、不用任何 Markdown 标记、直接说结论。',
        },
        {
          role: 'user',
          content:
            '用户指令：' +
            (task.prompt || '检查页面是否有值得注意的变化') +
            '\n\n网页标题：' +
            (page.title || '') +
            '\n\n网页正文（截取）：\n' +
            page.text,
        },
      ],
      max_tokens: JUDGE_MAX_TOKENS,
      stream: false,
    });

    var res = await request({
      method: 'POST',
      url: String(provider.baseUrl).replace(/\/+$/, '') + '/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      data: body,
      timeout: 60000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error('HTTP ' + res.status + ' ' + String(res.text).slice(0, 200));
    }
    var json;
    try {
      json = JSON.parse(res.text);
    } catch (e) {
      throw new Error('响应不是合法 JSON');
    }
    var msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
    return String(msg.content || '').trim();
  }

  function notify(title, message) {
    if (typeof GM_notification !== 'function') return;
    try {
      GM_notification({
        title: String(title).slice(0, 120),
        text: String(message).slice(0, 300),
        timeout: 15000,
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ============================ 调度 ============================ */

  /** 时间字符串 'HH:MM' → 今日该时刻的毫秒时间戳（按本地时区） */
  function todayAt(hhmm) {
    var parts = String(hhmm || '').split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return null;
    var d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  /**
   * 判断任务此刻是否该跑（对应扩展的 computeSchedule + alarm 语义）。
   * daily：今天的目标时刻已过，且最后一次运行在它之前 → 补跑一次，然后等明天
   * interval：距上次运行已达到间隔（从未跑过则立即跑）
   */
  function isDue(task, now) {
    var last = task.lastRunAt || 0;
    if (task.runRequestedAt && task.runRequestedAt > last) return true; // 主脚本的「立即检查」
    if (task.scheduleType === 'interval') {
      var every = (parseInt(task.intervalMinutes, 10) || 60) * 60000;
      return now - last >= every;
    }
    var at = todayAt(task.time);
    if (at == null) return false;
    if (now < at) return false; // 今天还没到点
    return last < at; // 今天到点后还没跑过
  }

  var running = {}; // 防重入：同一任务同一时刻只跑一个

  async function runTask(task) {
    if (running[task.id]) return;
    running[task.id] = true;
    var title = '执要·' + task.name;
    var status = 'ok';
    var message = '';
    try {
      var page = await fetchPageText(task.url);
      if (!page.text) throw new Error(tt('emptyPage'));
      var verdict = await judgeWithLlm(task, page);
      message = verdict || '(empty)';
      notify(title, message);
    } catch (e) {
      status = 'error';
      message = (e && e.message) || String(e);
      notify(title + '（失败）', message);
    } finally {
      delete running[task.id];
      updateTaskRun(task.id, status, message);
      console.log('[执要 Agent] task "' + task.name + '" → ' + status + ': ' + message);
    }
  }

  /** 把运行结果写回共享存储（读改写，必须串行以免覆盖主脚本的编辑） */
  var writeChain = Promise.resolve();
  function updateTaskRun(id, status, message) {
    writeChain = writeChain.then(function () {
      var list = loadTasks();
      var changed = false;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id !== id) continue;
        list[i].lastRunAt = Date.now();
        list[i].lastStatus = status;
        list[i].lastMessage = String(message).slice(0, 300);
        // 跑完清掉「立即检查」标记
        if (list[i].runRequestedAt) delete list[i].runRequestedAt;
        changed = true;
      }
      if (changed) gmSet(KEY_TASKS, list);
    });
    return writeChain;
  }

  /* ============================ 主循环 ============================ */

  var ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      gmSet(KEY_HEARTBEAT, Date.now());

      var now = Date.now();
      var tasks = loadTasks();
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i];
        if (!task || !task.enabled) continue;
        if (!task.url || !/^https?:\/\//i.test(task.url)) continue;
        if (!isDue(task, now)) continue;
        // 顺序执行，避免同时打爆模型服务
        await runTask(task);
      }
    } catch (e) {
      console.log('[执要 Agent] tick error: ' + ((e && e.message) || e));
    } finally {
      ticking = false;
    }
  }

  function schedule() {
    setTimeout(function () {
      tick().then(schedule, schedule);
    }, TICK_MS);
  }

  /* ============================ 启动 ============================ */

  // 任务表一有变动就立刻复查一次（「立即检查」按钮能马上生效，不用等下一个 tick）
  if (typeof GM_addValueChangeListener === 'function') {
    try {
      GM_addValueChangeListener(KEY_TASKS, function () {
        setTimeout(tick, 300);
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  console.log('[执要 Agent] 定时任务后台脚本已启动（每 ' + TICK_MS / 1000 + ' 秒检查一次）');
  tick();
  schedule();
})();
