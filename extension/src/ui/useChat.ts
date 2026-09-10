import { useCallback, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { ChatError, streamChat, type RawToolCall } from '@/core/chatEngine';
import { demoStream } from '@/core/demo';
import { readCurrentPage } from '@/core/pageReader';
import {
  executeAction,
  getSnapshot,
  openInNewTab,
} from '@/core/pageActions';
import {
  buildMessages,
  detectLang,
  type ChatMessage,
  type ModelMessage,
  type PageContext,
} from '@/core/prompts';
import {
  createSession,
  saveSession,
  type Session,
} from '@/core/sessions';
import { estimateTokens } from '@/core/tokenEstimate';
import { log } from '@/core/logger';
import {
  elementDesc,
  findTool,
  toOpenAITools,
  validateToolCall,
  type RiskLevel,
  type ToolCall,
} from '@/core/tools';
import type { SnapshotElement } from '@/core/protocol';
import type { Skill } from '@/core/skills';
import { t, uiLang } from './i18n';
import { useSettings } from './SettingsContext';

const MAX_STEPS = 10;

/** 危险动作关键词：即使在任务模式下也必须二次确认 */
const DANGER_RE =
  /支付|付款|付钱|提交|下单|购买|立即购买|结算|删除|注销|清空|转账|密码|验证码|登录|登入|确认|同意|授权|签约|续费|绑定|pay|buy|submit|delete|password|login|checkout|order|transfer|confirm|agree|authorize|subscribe/i;

/**
 * 敏感工具：即使在任务模式下也必须逐步确认。
 * 覆盖结构修改（edit_html/set_attribute/remove/hide，DOM 注入面）与
 * 外部副作用（打开新页/下载），比纯文本关键词兜底更可靠。
 */
const SENSITIVE_TOOLS = new Set([
  'edit_html',
  'set_attribute',
  'remove_element',
  'hide_element',
  'open_in_new_tab',
  'download_media',
]);

const TOOL_KEYS: Record<string, string> = {
  click: 'toolClick',
  type: 'toolType',
  select: 'toolSelect',
  scroll: 'toolScroll',
  read_text: 'toolReadText',
  read_html: 'toolReadHtml',
  page_source: 'toolPageSource',
  extract_table: 'toolExtractTable',
  copy: 'toolCopy',
  edit_text: 'toolEditText',
  edit_html: 'toolEditHtml',
  set_attribute: 'toolSetAttr',
  remove_element: 'toolRemoveEl',
  hide_element: 'toolHideEl',
  get_texts: 'toolGetTexts',
  translate_page: 'toolTranslatePage',
  get_media: 'toolGetMedia',
  download_media: 'toolDownloadMedia',
  open_in_new_tab: 'toolOpenTab',
};

export interface ActionProposal {
  tool: string;
  args: { index?: number | null; selector?: string; text?: string; amount?: number };
  risk: RiskLevel;
  summary: string;
  elementDesc: string;
  needsConfirm: boolean;
}

export interface UseChatResult {
  messages: ChatMessage[];
  streaming: boolean;
  demo: boolean;
  error: string | null;
  errorOrigin: string | null;
  pageContext: PageContext | null;
  tokens: number | null;
  sessionId: string | null;
  pendingAction: ActionProposal | null;
  actionLog: string[];
  /** 当前错误是否为页面访问权限问题（授权成功后自动重发） */
  pageAccessError: boolean;
  /** 当前会话关联的网站（host + 标题），加载历史会话时显示 */
  sessionSite: string | null;
  /** 任务模式：本次任务后续步骤自动执行（危险动作仍会确认） */
  autoMode: boolean;
  /** 批准当前操作并开启自动执行 */
  approveAutoAction(): void;
  send(text: string, forceSkills?: Skill[]): Promise<void>;
  stop(): void;
  retryLast(): void;
  newChat(): void;
  loadSession(session: Session): void;
  clearError(): void;
  confirmAction(): void;
  cancelAction(): void;
}

export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return '';
  }
}

/** 会话关联网站的展示标签（host + 页面标题） */
export function sessionSiteLabel(session: Session): string | null {
  if (!session.url) return null;
  try {
    const host = new URL(session.url).hostname;
    return session.siteTitle ? `${host} · ${session.siteTitle}` : host;
  } catch {
    return session.url;
  }
}

function tryParseJsonTool(text: string): { tool: string; args: unknown } | null {
  const s = text.trim();
  if (!s.startsWith('{')) return null;
  const end = s.indexOf('}');
  if (end < 0) return null;
  try {
    const obj = JSON.parse(s.slice(0, end + 1)) as {
      tool?: unknown;
      args?: unknown;
    };
    if (typeof obj.tool === 'string' && typeof obj.args === 'object' && obj.args !== null) {
      return { tool: obj.tool, args: obj.args };
    }
  } catch {
    return null;
  }
  return null;
}

export function useChat(): UseChatResult {
  const { settings, activeProvider, apiKeys, installedSkills } = useSettings();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorOrigin, setErrorOrigin] = useState<string | null>(null);
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionProposal | null>(null);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [pageAccessError, setPageAccessError] = useState(false);
  /** 当前会话所关联的网站（历史加载时显示） */
  const [sessionSite, setSessionSite] = useState<string | null>(null);
  const [autoMode, setAutoMode] = useState(false);

  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const siteRef = useRef<{ url?: string; siteTitle?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const decisionRef = useRef<null | ((d: 'confirm' | 'cancel') => void)>(null);
  const snapshotRef = useRef<SnapshotElement[] | null>(null);
  const autoModeRef = useRef(false);
  autoModeRef.current = autoMode;
  const lastTextRef = useRef<string>('');

  const waitDecision = useCallback(
    () =>
      new Promise<'confirm' | 'cancel'>((resolve) => {
        decisionRef.current = resolve;
      }),
    [],
  );

  const confirmAction = useCallback(() => {
    decisionRef.current?.('confirm');
    decisionRef.current = null;
    setPendingAction(null);
  }, []);

  const cancelAction = useCallback(() => {
    decisionRef.current?.('cancel');
    decisionRef.current = null;
    setPendingAction(null);
  }, []);

  /** 批准当前操作，并开启任务模式（后续步骤自动执行，危险动作除外） */
  const approveAutoAction = useCallback(() => {
    setAutoMode(true);
    decisionRef.current?.('confirm');
    decisionRef.current = null;
    setPendingAction(null);
  }, []);

  /** 更新最后一个助手气泡 */
  const setLastAssistant = useCallback((content: string) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.role === 'assistant') {
          next[i] = { ...next[i]!, content };
          return next;
        }
      }
      next.push({ role: 'assistant', content });
      return next;
    });
  }, []);

  const appendAssistantDelta = useCallback((delta: string) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.role === 'assistant') {
          next[i] = { ...next[i]!, content: next[i]!.content + delta };
          return next;
        }
      }
      next.push({ role: 'assistant', content: delta });
      return next;
    });
  }, []);

  const appendAssistantBubble = useCallback(() => {
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
  }, []);

  const appendUserBubble = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: 'user', content }]);
  }, []);

  const persistSession = useCallback(
    async (_userText: string, assistantText: string, ctx: PageContext | null) => {
      let sid = sessionIdRef.current;
      if (!sid) {
        siteRef.current = ctx ? { url: ctx.url, siteTitle: ctx.title } : null;
        sid = createSession('Untitled', siteRef.current ?? undefined).id;
        setSessionId(sid);
      }
      // 当前轮的 user/assistant 气泡已经写入 messagesRef，直接以其为准，
      // 避免把 userText/assistantText 二次追加（历史末轮翻倍的根因）。
      const msgs: { role: 'user' | 'assistant'; content: string }[] =
        messagesRef.current
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      // 异常路径兜底：若没有 assistant 气泡或内容为空，补写终稿（不产生重复）
      const last = msgs[msgs.length - 1];
      if (assistantText) {
        if (!last || last.role !== 'assistant') {
          msgs.push({ role: 'assistant', content: assistantText });
        } else if (!last.content) {
          msgs[msgs.length - 1] = { role: 'assistant', content: assistantText };
        }
      }
      const session: Session = {
        id: sid,
        title: 'Untitled',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        url: siteRef.current?.url,
        siteTitle: siteRef.current?.siteTitle,
        messages: msgs,
      };
      // 用第一条用户消息作为会话标题
      if (!session.title || session.title === 'Untitled') {
        const firstUser = session.messages.find((m) => m.role === 'user');
        if (firstUser) session.title = firstUser.content.slice(0, 60);
      }
      await saveSession(session);
    },
    [],
  );

  const buildProposal = useCallback(
    (call: ToolCall): ActionProposal => {
      const def = findTool(call.tool);
      const risk = def?.risk ?? 3;
      const el = elementDesc(call.args, snapshotRef.current);
      const name = TOOL_KEYS[call.tool] ? t(TOOL_KEYS[call.tool]!) : call.tool;
      let extra = '';
      if (call.tool === 'type' || call.tool === 'select' || call.tool === 'open_in_new_tab') {
        extra = `「${call.args.text}」`;
      } else if (call.tool === 'scroll') {
        extra = ` ${call.args.amount ?? 0}px`;
      } else if (call.tool === 'translate_page') {
        const items = call.args.items ?? [];
        const preview = items
          .slice(0, 2)
          .map((i) => i.text)
          .join(' / ');
        extra = `（${items.length} 处${preview ? `，示例：${preview}` : ''}）`;
      } else if (call.tool === 'download_media') {
        extra = `：${call.args.url ?? ''}`;
      }
      const summary = `${t('proposeAction')}：${name}${el ? ` → ${el}` : ''}${extra}`;
      return {
        tool: call.tool,
        args: call.args,
        risk,
        summary,
        elementDesc: el,
        needsConfirm: def?.confirmRequired ?? true,
      };
    },
    [],
  );

  const send = useCallback(
    async (text: string, forceSkills?: Skill[]) => {
      if (streaming) return;
      const lang = uiLang();
      lastTextRef.current = text;
      setError(null);
      setErrorOrigin(null);
      setPageAccessError(false);
      setAutoMode(false); // 每次新任务默认关闭任务模式

      // 1. 读取页面上下文（无权限时中止并引导授权）
      let ctx: PageContext | null = null;
      if (settings.autoReadPage) {
        const res = await readCurrentPage();
        if (res.ok) {
          ctx = {
            title: res.title,
            url: res.url,
            body: res.body,
            bodyTruncated: res.bodyTruncated,
            viewport: res.viewport,
            viewportTruncated: res.viewportTruncated,
            selection: res.selection,
            lang: res.lang,
          };
        } else if (res.code === 'NO_ACCESS') {
          log('warn', 'page', `no access: origin=${res.origin ?? ''}`);
          setError(t('readPageNoAccess'));
          setErrorOrigin(res.origin ?? '');
          setPageAccessError(true);
          return; // 中止发送：先授权或重开面板
        } else {
          log('warn', 'page', `read failed: ${res.message}`);
          setError(t('readPageFailed'));
        }
      }
      setPageContext(ctx);

      const history = messagesRef.current.filter((m) => m.role !== 'system').slice(-12);
      const cfg = activeProvider;
      const key = cfg ? (apiKeys[cfg.id] ?? '') : '';
      const useDemo = (!cfg || !key) && settings.demoMode;
      if (!cfg && !settings.demoMode) {
        setError(t('errorNoProvider'));
        return;
      }
      if (cfg && !key && !settings.demoMode) {
        setError(t('errorNoKey'));
        return;
      }

      appendUserBubble(text);
      appendAssistantBubble();
      setStreaming(true);
      setDemo(useDemo);
      const ac = new AbortController();
      abortRef.current = ac;
      const signal = ac.signal;

      // 已启用技能 + 快捷触发的强制技能（去重）
      const enabledSkills = installedSkills.filter((s) =>
        settings.enabledSkillIds.includes(s.id),
      );
      const allSkills = forceSkills?.length
        ? [
            ...enabledSkills,
            ...forceSkills.filter(
              (f) => !enabledSkills.some((e) => e.id === f.id),
            ),
          ]
        : enabledSkills;

      const modelMsgs: ModelMessage[] = buildMessages({
        page: ctx,
        history,
        userMessage: text,
        lang: detectLang(ctx?.lang ?? browser.i18n.getUILanguage()),
        skills: allSkills,
      });

      const reportError = (err: ChatError) => {
        log('error', 'chat', `${err.code}: ${err.message}`);
        if (err.code === 'NEED_ORIGIN_PERMISSION' && cfg) {
          setErrorOrigin(originOf(cfg.baseUrl));
          setError(t('errorNeedOrigin', { origin: originOf(cfg.baseUrl) }));
        } else if (err.code === 'ABORT') {
          setError(t('errorAborted'));
        } else {
          setError(err.message || t('errorGeneric'));
        }
      };

      const handleToolCall = async (
        raw: RawToolCall | null,
        roundText: string,
        jsonMode: boolean,
      ): Promise<boolean> => {
        // 解析 + 白名单校验
        let call: ToolCall;
        if (raw) {
          try {
            const parsedArgs = JSON.parse(raw.arguments || '{}');
            const v = validateToolCall({ tool: raw.name, args: parsedArgs });
            if (!v.ok || !v.call) {
              log('warn', 'tools', `invalid call ${raw.name}: ${v.error}`);
              setLastAssistant('（模型返回了无效操作，已忽略）');
              return true;
            }
            call = v.call;
          } catch {
            setLastAssistant('（模型返回了无法解析的操作，已忽略）');
            return true;
          }
          modelMsgs.push({
            role: 'assistant',
            content: roundText || null,
            tool_calls: [
              {
                id: raw.id,
                type: 'function',
                function: { name: raw.name, arguments: raw.arguments },
              },
            ],
          });
        } else {
          const parsed = tryParseJsonTool(roundText);
          if (!parsed) return false;
          const v = validateToolCall(parsed);
          if (!v.ok || !v.call) {
            setLastAssistant('（模型返回了无效操作，已忽略）');
            return true;
          }
          call = v.call;
          modelMsgs.push({ role: 'assistant', content: roundText });
        }

        // snapshot：内部自动执行，无需确认
        if (call.tool === 'snapshot') {
          const snap = await getSnapshot();
          if (snap.ok) {
            snapshotRef.current = snap.elements;
            setLastAssistant(t('snapshotDone', { n: snap.elements.length }));
            modelMsgs.push({
              role: raw ? 'tool' : 'user',
              tool_call_id: raw?.id,
              content: JSON.stringify({
                ok: true,
                total: snap.total,
                truncated: snap.truncated,
                elements: snap.elements,
              }),
            });
          } else {
            setLastAssistant(t('readPageFailed'));
            if (snap.code === 'NO_ACCESS') {
              setError(t('readPageNoAccess'));
              setErrorOrigin(snap.origin ?? '');
              setPageAccessError(true);
              return true; // 停止循环，等待授权
            }
            modelMsgs.push({
              role: raw ? 'tool' : 'user',
              tool_call_id: raw?.id,
              content: JSON.stringify({ ok: false, error: snap.message }),
            });
          }
          appendAssistantBubble();
          return false; // 继续循环
        }

        // 只读且免确认的工具：page_source / get_texts / get_media 直接执行回传
        if (
          call.tool === 'page_source' ||
          call.tool === 'get_texts' ||
          call.tool === 'get_media'
        ) {
          const src = await executeAction({ tool: call.tool });
          setLastAssistant(t('actionResult') + '：' + src.message);
          appendAssistantBubble();
          modelMsgs.push({
            role: raw ? 'tool' : 'user',
            tool_call_id: raw?.id,
            content: JSON.stringify(src),
          });
          return false; // 继续循环
        }

        // 需要确认的操作：弹卡片（任务模式下非危险动作自动执行）
        const proposal = buildProposal(call);
        setLastAssistant(proposal.summary);
        // 危险判断三路并进：敏感工具恒确认 + 摘要/元素描述 + 工具参数值
        // （set_attribute 的 name/value、edit_html 的 html 等不在摘要中，单独扫描）
        const argText = [
          call.args.text,
          call.args.html,
          call.args.name,
          call.args.value,
          call.args.url,
          call.args.lang,
        ]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(' ');
        const dangerous =
          SENSITIVE_TOOLS.has(call.tool) ||
          DANGER_RE.test(proposal.summary) ||
          DANGER_RE.test(proposal.elementDesc) ||
          DANGER_RE.test(argText);
        if (!autoModeRef.current || dangerous) {
          setPendingAction(proposal);
          const decision = await waitDecision();
          if (decision === 'cancel') {
            setLastAssistant(t('actionCancelled'));
            return true; // 停止循环
          }
        }

        // 执行
        let result;
        if (call.tool === 'open_in_new_tab') {
          result = await openInNewTab(call.args.text ?? '');
        } else {
          result = await executeAction({
            tool: call.tool,
            index: call.args.index ?? null,
            selector: call.args.selector,
            text:
              call.tool === 'translate_page'
                ? JSON.stringify(call.args.items ?? [])
                : call.args.text,
            amount: call.args.amount,
            html: call.args.html,
            name: call.args.name,
            value: call.args.value,
            lang: call.args.lang,
            items: call.args.items,
            url: call.args.url,
          });
        }
        const resultText =
          t('actionResult') +
          '：' +
          result.message +
          (result.data ? `\n${result.data.slice(0, 1500)}` : '');
        log(
          result.ok ? 'info' : 'warn',
          'action',
          `${call.tool} → ${result.message}`,
        );
        appendUserBubble(resultText);
        setActionLog((prev) => [...prev, result.message]);
        modelMsgs.push({
          role: raw ? 'tool' : 'user',
          tool_call_id: raw?.id,
          content: jsonMode || !raw ? `【操作结果】${resultText}` : JSON.stringify(result),
        });
        appendAssistantBubble();
        return false; // 继续循环
      };

      try {
        let finalText = '';
        let steps = 0;
        let stopped = false;

        while (steps < MAX_STEPS && !stopped) {
          steps++;

          if (useDemo) {
            // 演示模式：含关键字时模拟一次点击操作走查
            if (steps === 1 && /演示操作|demo action/i.test(text)) {
              const proposal: ActionProposal = {
                tool: 'click',
                args: { index: 0, selector: '#demo-button' },
                risk: 2,
                summary: `${t('proposeAction')}：${t('toolClick')} → ${t('demoTarget')}`,
                elementDesc: t('demoTarget'),
                needsConfirm: true,
              };
              setPendingAction(proposal);
              setLastAssistant(proposal.summary);
              const decision = await waitDecision();
              if (decision === 'cancel') {
                setLastAssistant(t('actionCancelled'));
                stopped = true;
                break;
              }
              appendUserBubble(`${t('actionResult')}：${t('demoResult')}`);
              appendAssistantBubble();
              // 下一轮给出演示文本回复
              const demoText = await demoStream({
                userMessage: text,
                lang,
                signal,
                onDelta: appendAssistantDelta,
                onDone: () => {},
              });
              finalText = demoText;
              stopped = true;
              break;
            }
            finalText = await demoStream({
              userMessage: text,
              lang,
              signal,
              onDelta: appendAssistantDelta,
              onDone: () => {},
            });
            stopped = true;
            break;
          }

          const { text: roundText, toolCalls } = await streamChat({
            config: cfg!,
            apiKey: key,
            messages: modelMsgs,
            signal,
            tools: toOpenAITools(),
            handlers: {
              onDelta: appendAssistantDelta,
              onDone: () => {},
              onError: reportError,
            },
          });

          if (toolCalls && toolCalls.length > 0) {
            const shouldStop = await handleToolCall(toolCalls[0]!, roundText, false);
            if (shouldStop) {
              stopped = true;
              break;
            }
            continue;
          }

          // JSON 模式降级
          const handled = await handleToolCall(null, roundText, true);
          if (handled) {
            stopped = true;
            break;
          }

          finalText = roundText;
          stopped = true;
        }

        if (steps >= MAX_STEPS && !finalText && !stopped) {
          setLastAssistant(t('agentMaxSteps'));
        }
        if (finalText) setTokens(estimateTokens(finalText));
        await persistSession(text, finalText, ctx);
      } catch (err) {
        if (err instanceof ChatError) reportError(err);
        else if (err instanceof DOMException && err.name === 'AbortError') {
          setError(t('errorAborted'));
        } else {
          // 未知错误：记录原始异常并透出 message，避免只显示「出错了。」无法排障
          const message = err instanceof Error ? err.message : String(err);
          log('error', 'chat', `unexpected: ${message}`);
          setError(`${t('errorGeneric')} ${message}`.trim());
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [
      streaming,
      settings,
      activeProvider,
      apiKeys,
      installedSkills,
      appendUserBubble,
      appendAssistantBubble,
      appendAssistantDelta,
      setLastAssistant,
      buildProposal,
      persistSession,
      waitDecision,
    ],
  );

  const stop = useCallback(() => {
    decisionRef.current?.('cancel');
    abortRef.current?.abort();
  }, []);

  /** 授权成功后重发上一次的消息 */
  const retryLast = useCallback(() => {
    const t = lastTextRef.current;
    if (t) void send(t);
  }, [send]);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    decisionRef.current = null;
    setMessages([]);
    setError(null);
    setErrorOrigin(null);
    setPageContext(null);
    setTokens(null);
    setSessionId(null);
    setPendingAction(null);
    setActionLog([]);
    setPageAccessError(false);
    setAutoMode(false);
    setSessionSite(null);
    siteRef.current = null;
    snapshotRef.current = null;
  }, []);

  const loadSession = useCallback((session: Session) => {
    abortRef.current?.abort();
    decisionRef.current = null;
    setMessages(
      session.messages.map((m) => ({ role: m.role, content: m.content })),
    );
    setSessionId(session.id);
    siteRef.current = session.url
      ? { url: session.url, siteTitle: session.siteTitle }
      : null;
    setSessionSite(sessionSiteLabel(session));
    setError(null);
    setErrorOrigin(null);
    setPageContext(null);
    setTokens(null);
    setPendingAction(null);
    setActionLog([]);
    setPageAccessError(false);
    setAutoMode(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setErrorOrigin(null);
    setPageAccessError(false);
  }, []);

  return {
    messages,
    streaming,
    demo,
    error,
    errorOrigin,
    pageContext,
    tokens,
    sessionId,
    pendingAction,
    actionLog,
    pageAccessError,
    sessionSite,
    autoMode,
    send,
    stop,
    retryLast,
    newChat,
    loadSession,
    clearError,
    confirmAction,
    cancelAction,
    approveAutoAction,
  };
}
