import { browser } from 'wxt/browser';
import { log } from '@/core/logger';
import {
  ActionRequestSchema,
  ActionResultSchema,
  PageDataSchema,
  ReadPageRequestSchema,
  SnapshotDataSchema,
  SnapshotRequestSchema,
  GetTasksRequestSchema,
  UpsertTaskRequestSchema,
  DeleteTaskRequestSchema,
  ToggleTaskRequestSchema,
  RunTaskNowRequestSchema,
  type ActionRequest,
  type ActionResult,
  type PageReadError,
  type ReadPageRequest,
  type ReadPageResponse,
  type SnapshotError,
  type SnapshotRequest,
  type SnapshotResponse,
} from '@/core/protocol';
import {
  computeSchedule,
  loadTasks,
  saveTasks,
  taskAlarmName,
  type ScheduledTask,
} from '@/core/scheduledTasks';
import { chatEndpoint } from '@/core/chatEngine';
import { getApiKey, loadSettings } from '@/core/settings';

export default defineBackground(() => {
  // 点击工具栏图标即打开侧边栏；页面读取依赖 host_permissions（所有 http(s) 网站），
  // 因此无论侧边栏从何处打开，都能立即读取当前网页。
  if (typeof browser.sidePanel?.setPanelBehavior === 'function') {
    browser.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  } else if (typeof browser.sidePanel?.open === 'function') {
    browser.action.onClicked.addListener((tab) => {
      browser.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    });
  }

  // ---- 定时任务：闹钟生命周期 ----
  // 闹钟触发 → 执行对应任务（SW 被唤醒，需在 promise 结束前保持存活）。
  browser.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith('task:')) return;
    const id = alarm.name.slice('task:'.length);
    void (async () => {
      const tasks = await loadTasks();
      const task = tasks.find((t) => t.id === id && t.enabled);
      if (task) await runTask(task);
    })();
  });
  // 浏览器重启 / 扩展安装后重同步（alarms 虽持久化，重同步防漂移与配置变更）。
  browser.runtime.onStartup.addListener(() => void syncTaskAlarms());
  browser.runtime.onInstalled.addListener(() => void syncTaskAlarms());

  // sidepanel → background 消息路由
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const snapshot = SnapshotRequestSchema.safeParse(msg);
    if (snapshot.success) {
      handleSnapshot(snapshot.data)
        .then(sendResponse)
        .catch((err) => sendResponse(fail('UNKNOWN', err)));
      return true;
    }

    const action = ActionRequestSchema.safeParse(msg);
    if (action.success) {
      handleAction(action.data)
        .then(sendResponse)
        .catch((err) => sendResponse(fail('UNKNOWN', err)));
      return true;
    }

    const read = ReadPageRequestSchema.safeParse(msg);
    if (read.success) {
      handleReadPage(read.data)
        .then(sendResponse)
        .catch((err) => sendResponse(fail('UNKNOWN', err)));
      return true;
    }

    // ---- 定时任务消息 ----
    const getTasks = GetTasksRequestSchema.safeParse(msg);
    if (getTasks.success) {
      loadTasks()
        .then((tasks) => sendResponse({ tasks }))
        .catch((err) => sendResponse({ ok: false, message: String(err), tasks: [] }));
      return true;
    }

    const upsertTask = UpsertTaskRequestSchema.safeParse(msg);
    if (upsertTask.success) {
      handleUpsertTask(upsertTask.data.task)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, message: String(err), tasks: [] }));
      return true;
    }

    const deleteTask = DeleteTaskRequestSchema.safeParse(msg);
    if (deleteTask.success) {
      handleDeleteTask(deleteTask.data.id)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, message: String(err), tasks: [] }));
      return true;
    }

    const toggleTask = ToggleTaskRequestSchema.safeParse(msg);
    if (toggleTask.success) {
      handleToggleTask(toggleTask.data.id, toggleTask.data.enabled)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, message: String(err), tasks: [] }));
      return true;
    }

    const runNow = RunTaskNowRequestSchema.safeParse(msg);
    if (runNow.success) {
      handleRunNow(runNow.data.id)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, message: String(err), tasks: [] }));
      return true;
    }
    return; // 不处理其他消息
  });
});

function fail(code: PageReadError['code'], err: unknown): PageReadError {
  return {
    ok: false,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id == null) throw new Error('NO_TAB: no active tab');
  return tab.id;
}

/** http(s) 页面返回 origin（用于「授权访问」按钮）；edge:// 等特殊页面返回空串 */
async function tabOrigin(tabId: number): Promise<string> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.url) return '';
    const u = new URL(tab.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {
    // ignore
  }
  return '';
}

function isNoAccess(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Cannot access|permission|Extension manifest must request|NO_TAB/i.test(message);
}

const NO_ACCESS_MESSAGE =
  'No access to this tab. Click the toolbar icon to open the panel, or grant access to this site.';

async function handleReadPage(req: ReadPageRequest): Promise<ReadPageResponse> {
  let tabId: number;
  try {
    tabId = await getActiveTabId();
  } catch (err) {
    return { ok: false, code: 'NO_TAB', message: String(err) };
  }
  try {
    const injected = await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content/page-reader.js'],
    });
    const result = injected[0]?.result;
    return PageDataSchema.parse(result);
  } catch (err) {
    if (isNoAccess(err)) {
      log('warn', 'background', `read page no access: ${String(err)}`);
      return {
        ok: false,
        code: 'NO_ACCESS',
        message: NO_ACCESS_MESSAGE,
        origin: await tabOrigin(tabId),
      };
    }
    log('error', 'background', `read page failed: ${String(err)}`);
    return { ok: false, code: 'INJECT_FAILED', message: String(err) };
  }
}

async function handleSnapshot(req: SnapshotRequest): Promise<SnapshotResponse> {
  let tabId: number;
  try {
    tabId = await getActiveTabId();
  } catch (err) {
    return { ok: false, code: 'NO_TAB', message: String(err) };
  }
  try {
    const injected = await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content/page-snapshot.js'],
    });
    const result = injected[0]?.result;
    return SnapshotDataSchema.parse(result);
  } catch (err) {
    if (isNoAccess(err)) {
      const e: SnapshotError = {
        ok: false,
        code: 'NO_ACCESS',
        message: NO_ACCESS_MESSAGE,
        origin: await tabOrigin(tabId),
      };
      log('warn', 'background', `snapshot no access: ${String(err)}`);
      return e;
    }
    log('error', 'background', `snapshot failed: ${String(err)}`);
    const e: SnapshotError = { ok: false, code: 'INJECT_FAILED', message: String(err) };
    return e;
  }
}

async function handleAction(req: ActionRequest): Promise<ActionResult> {
  // 下载媒体：由后台直接用浏览器下载器执行，无需注入页面
  if (req.tool === 'download_media') {
    const url = req.url ?? '';
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, message: '无效的下载地址' };
    }
    try {
      await browser.downloads.download({ url, saveAs: false });
      log('info', 'action', `download_media started: ${url.slice(0, 120)}`);
      return { ok: true, message: '已开始下载（可在浏览器下载列表查看）' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'action', `download_media failed: ${msg}`);
      return { ok: false, message: `下载失败：${msg}` };
    }
  }

  const tabId = await getActiveTabId();
  // 1. 注入执行器（定义 window.__zhiyaoExec）
  await browser.scripting.executeScript({
    target: { tabId },
    files: ['/content/page-actions.js'],
  });
  // 2. 传参调用
  const payload = {
    tool: req.tool,
    index: req.index,
    selector: req.selector,
    text: req.text,
    amount: req.amount,
    html: req.html,
    name: req.name,
    value: req.value,
    lang: req.lang,
    items: req.items,
    url: req.url,
  };
  const [res] = await browser.scripting.executeScript({
    target: { tabId },
    func: (args: unknown) => (globalThis as { __zhiyaoExec?: (a: unknown) => unknown }).__zhiyaoExec?.(args),
    args: [payload],
  });
  const parsed = ActionResultSchema.safeParse(res?.result);
  if (!parsed.success) {
    return { ok: false, message: '执行器未返回有效结果' };
  }
  return parsed.data;
}

// ==================== 定时任务：闹钟同步与任务执行 ====================

/**
 * 任务存储变更串行队列：load→改→save 是读改写，
 * runTask 与增删改并发时旧快照会覆盖新写（丢状态/复活已删任务）。
 * 所有涉及 scheduled_tasks 的变更都经此链串行执行。
 */
let taskChain: Promise<unknown> = Promise.resolve();
function enqueueTask<T>(fn: () => Promise<T>): Promise<T> {
  const p = taskChain.then(fn, fn);
  taskChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** 全量重建任务闹钟：清空 task:* 后按当前配置重建（增删改/启停后调用） */
async function syncTaskAlarms(): Promise<void> {
  const tasks = await loadTasks();
  const existing = await browser.alarms.getAll();
  const mine = existing.filter((a) => a.name.startsWith('task:'));
  for (const alarm of mine) {
    await browser.alarms.clear(alarm.name);
  }
  for (const task of tasks) {
    if (!task.enabled) continue;
    const sched = computeSchedule(task);
    if (!sched) continue;
    if (sched.when !== undefined) {
      browser.alarms.create(taskAlarmName(task.id), {
        when: sched.when,
        periodInMinutes: sched.periodInMinutes,
      });
    } else {
      browser.alarms.create(taskAlarmName(task.id), {
        delayInMinutes: sched.periodInMinutes,
        periodInMinutes: sched.periodInMinutes,
      });
    }
  }
}

async function freshTasks(): Promise<ScheduledTask[]> {
  const tasks = await loadTasks();
  return tasks;
}

async function handleUpsertTask(task: ScheduledTask) {
  return enqueueTask(async () => {
    const tasks = await loadTasks();
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) tasks[idx] = task;
    else tasks.push(task);
    await saveTasks(tasks);
    await syncTaskAlarms();
    log('info', 'task', `saved: ${task.name}`);
    return { ok: true, message: 'saved', tasks: await freshTasks() };
  });
}

async function handleDeleteTask(id: string) {
  return enqueueTask(async () => {
    const tasks = await loadTasks();
    const next = tasks.filter((t) => t.id !== id);
    await saveTasks(next);
    await syncTaskAlarms();
    log('info', 'task', `deleted: ${id}`);
    return { ok: true, message: 'deleted', tasks: await freshTasks() };
  });
}

async function handleToggleTask(id: string, enabled: boolean) {
  return enqueueTask(async () => {
    const tasks = await loadTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    const cur = idx >= 0 ? tasks[idx] : undefined;
    if (cur) tasks[idx] = { ...cur, enabled };
    await saveTasks(tasks);
    await syncTaskAlarms();
    log('info', 'task', `toggled: ${id} -> ${enabled}`);
    return { ok: true, message: 'toggled', tasks: await freshTasks() };
  });
}

async function handleRunNow(id: string) {
  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return { ok: false, message: '任务不存在', tasks: await freshTasks() };
  // 后台执行，不阻塞消息响应
  void runTask(task);
  log('info', 'task', `run now requested: ${task.name}`);
  return { ok: true, message: 'started', tasks: await freshTasks() };
}

/** 更新任务的最近一次运行状态 */
async function updateTaskRun(
  id: string,
  patch: Pick<ScheduledTask, 'lastRunAt' | 'lastStatus' | 'lastMessage'>,
): Promise<void> {
  const tasks = await loadTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const cur = tasks[idx];
  if (!cur) return;
  tasks[idx] = {
    ...cur,
    lastRunAt: patch.lastRunAt,
    lastStatus: patch.lastStatus,
    lastMessage: patch.lastMessage,
  };
  await saveTasks(tasks);
}

/** 拉取页面文本：HTML 剥标签，JSON 直接截取；30s 超时 */
async function fetchPageText(url: string): Promise<{ title: string; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml,application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    if (contentType.includes('json')) {
      return { title: url, text: raw.slice(0, 6000) };
    }
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let text = raw.replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
    text = text.replace(/\s+/g, ' ').trim();
    return {
      title: (titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim(),
      text: text.slice(0, 6000),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 调用用户配置的模型做检查判断（非流式，纯文本结论） */
async function judgeWithLlm(task: ScheduledTask, page: { title: string; text: string }) {
  const settings = await loadSettings();
  const provider = settings.providers.find(
    (p) => p.id === settings.activeProviderId && p.enabled,
  );
  if (!provider) {
    throw new Error('未配置模型服务：请先在设置中添加服务商（定时任务需要调用你的模型）');
  }
  const apiKey = await getApiKey(provider.id, settings.rememberKeys);
  if (!apiKey) {
    throw new Error(
      '未找到 API Key：若密钥设为「仅本次会话」，浏览器重启后会清除，请重新在设置中填写',
    );
  }
  const system =
    '你是网页定时监控助手。根据用户指令检查网页内容并输出结论：纯文本、不超过 200 字、不用任何 Markdown 标记、直接说结论。';
  const user = `用户指令：${task.prompt || '检查页面是否有值得注意的变化'}\n\n网页标题：${page.title}\n\n网页正文（截取）：\n${page.text}`;
  const res = await fetch(chatEndpoint(provider.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: provider.activeModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 400,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`模型调用失败 HTTP ${res.status}${body ? ` ${body}` : ''}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('模型返回为空');
  }
  return content.trim();
}

/** 本地系统通知（始终发送） */
async function localNotify(title: string, message: string): Promise<void> {
  try {
    await browser.notifications.create(
      `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: title.slice(0, 120),
        message: message.slice(0, 300),
      },
    );
  } catch (err) {
    log('warn', 'notify', `local notification failed: ${String(err)}`);
  }
}

/** 执行一个定时任务：拉页面 → AI 判断 → 本地通知 → 记录结果（经队列串行，防写竞态） */
async function runTask(task: ScheduledTask): Promise<void> {
  return enqueueTask(() => runTaskInner(task));
}

async function runTaskInner(task: ScheduledTask): Promise<void> {
  const started = Date.now();
  const title = `执要·${task.name}`;
  try {
    log('info', 'task', `run start: ${task.name} (${task.url.slice(0, 100)})`);
    const page = await fetchPageText(task.url);
    const verdict = await judgeWithLlm(task, page);
    await localNotify(title, verdict.slice(0, 300));
    await updateTaskRun(task.id, {
      lastRunAt: started,
      lastStatus: 'ok',
      lastMessage: verdict.slice(0, 300),
    });
    log('info', 'task', `run ok: ${task.name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'task', `run failed: ${task.name}: ${message}`);
    await localNotify(`${title}（失败）`, message.slice(0, 300));
    await updateTaskRun(task.id, {
      lastRunAt: started,
      lastStatus: 'error',
      lastMessage: message.slice(0, 300),
    });
  }
}
