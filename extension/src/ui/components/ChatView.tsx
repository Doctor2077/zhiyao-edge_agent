import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { BUILTIN_SKILLS, type Skill } from '@/core/skills';
import { t, uiLang } from '../i18n';
import type { UseChatResult } from '../useChat';
import { useSettings } from '../SettingsContext';
import { langLabel } from './langLabel';
import ActionCard from './ActionCard';
import SkillPicker from './SkillPicker';
import QuickTaskPanel from './QuickTaskPanel';

export default function ChatView({
  chat,
  onOpenSettings,
  onOpenSkills,
}: {
  chat: UseChatResult;
  onOpenSettings(): void;
  onOpenSkills(): void;
}) {
  const { settings } = useSettings();
  /** 加号菜单状态：menu=两入口菜单；skills=技能面板；task=定时推送面板 */
  const [plusPanel, setPlusPanel] = useState<'menu' | 'skills' | 'task' | null>(null);
  const skillCtx = useSettings();
  const featured = BUILTIN_SKILLS.filter((s) => s.featured);
  const installedIds = new Set(skillCtx.installedSkills.map((s) => s.id));

  // ---- 消息区自动下翻：跟随输出滚动；用户上翻阅读时不打扰 ----
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const handleMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // 初次挂载（含恢复历史会话）直接滚到底部
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // 内容变化（新消息 / 流式增量）：停在底部则跟随，最后一条是用户消息则强制跟随
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const last = chat.messages[chat.messages.length - 1];
    if (stickToBottomRef.current || last?.role === 'user') {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat.messages]);

  const runQuick = async (s: Skill) => {
    // 未安装则自动安装；并启用（本消息用 forceSkills 保证立即生效）
    if (!installedIds.has(s.id)) {
      await skillCtx.installSkill(structuredClone(s));
    }
    void skillCtx.toggleSkill(s.id, true);
    const prompt =
      uiLang() === 'zh'
        ? (s.quickPrompt ?? s.name)
        : (s.quickPromptEn ?? s.quickPrompt ?? s.name);
    void chat.send(prompt, [s]);
  };

  const grantOrigin = async () => {
    if (!chat.errorOrigin) return;
    try {
      const granted = await browser.permissions.request({
        origins: [`${chat.errorOrigin}/*`],
      });
      if (granted) {
        chat.clearError();
        // 页面访问权限问题：授权成功后自动重发上一条消息
        if (chat.pageAccessError) chat.retryLast();
      }
    } catch {
      // 用户拒绝授权：保持错误提示
    }
  };

  const showChip = settings.previewBeforeSend && chat.pageContext != null;

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <button
          className="chat-new-btn"
          onClick={chat.newChat}
          aria-label={t('newChat')}
          title={t('newChat')}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M7 1.5V12.5M1.5 7H12.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      </div>
      {chat.error && (
        <div className="banner banner-error">
          <span>
            <span className="banner-icon">!</span>
            {chat.error}
          </span>
          {chat.errorOrigin && (
            <button className="btn btn-small" onClick={grantOrigin}>
              {t('grantOrigin')}
            </button>
          )}
        </div>
      )}
      {chat.demo && (
        <div className="banner banner-demo">
          <span>
            <span className="banner-icon">✦</span>
            {t('demoNotice')}
          </span>
        </div>
      )}
      {chat.autoMode && (
        <div className="banner banner-auto">
          <span>
            <span className="banner-icon">▶</span>
            {t('autoRunning')}
          </span>
        </div>
      )}

      <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        {chat.messages.length === 0 && (
          <div className="empty">
            <span className="empty-mark">✦</span>
            <p>{t('emptyChat')}</p>
            <button className="btn btn-primary" onClick={onOpenSettings}>
              {t('navSettings')}
            </button>
          </div>
        )}
        {chat.messages.map((m, i) => {
          const isLast = i === chat.messages.length - 1;
          return (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">
                {m.content}
                {chat.streaming && isLast && m.role === 'assistant' && (
                  <span className="cursor">▌</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showChip && (
        <div className="page-chip">
          <span>📄</span>
          {t('pageContextChip', {
            body: chat.pageContext!.body.length,
            viewport: chat.pageContext!.viewport.length,
            selection: chat.pageContext!.selection.length,
          })}
        </div>
      )}

      {!showChip && chat.sessionSite && (
        <div className="page-chip">
          <span>🌐</span>
          {chat.sessionSite}
        </div>
      )}

      {chat.pendingAction && (
        <ActionCard
          proposal={chat.pendingAction}
          onConfirm={chat.confirmAction}
          onCancel={chat.cancelAction}
          onApproveAuto={chat.approveAutoAction}
        />
      )}

      {plusPanel === 'menu' && (
        <div className="skill-picker composer-menu">
          <button
            className="composer-menu-item"
            onClick={() => setPlusPanel('skills')}
          >
            <span className="composer-menu-icon">✦</span>
            <span className="skill-picker-info">
              <span className="skill-picker-name">{t('menuSkills')}</span>
              <span className="skill-picker-desc">{t('menuSkillsDesc')}</span>
            </span>
          </button>
          <button
            className="composer-menu-item"
            onClick={() => setPlusPanel('task')}
          >
            <span className="composer-menu-icon">⏱</span>
            <span className="skill-picker-info">
              <span className="skill-picker-name">{t('menuTask')}</span>
              <span className="skill-picker-desc">{t('menuTaskDesc')}</span>
            </span>
          </button>
        </div>
      )}

      {plusPanel === 'skills' && (
        <SkillPicker
          onClose={() => setPlusPanel(null)}
          onManage={() => {
            setPlusPanel(null);
            onOpenSkills();
          }}
        />
      )}

      {plusPanel === 'task' && (
        <QuickTaskPanel
          pageUrl={chat.pageContext?.url ?? ''}
          pageTitle={chat.pageContext?.title ?? ''}
          onClose={() => setPlusPanel(null)}
        />
      )}

      <QuickSkills featured={featured} installedIds={installedIds} onRun={runQuick} />

      <Composer
        streaming={chat.streaming}
        plusActive={plusPanel !== null}
        onTogglePlus={() => setPlusPanel((v) => (v ? null : 'menu'))}
        onSend={(text) => void chat.send(text)}
        onStop={chat.stop}
      />
      {chat.tokens != null && (
        <div className="tokens">{t('tokensUsed', { tokens: chat.tokens })}</div>
      )}
    </div>
  );
}

function QuickSkills({
  featured,
  installedIds,
  onRun,
}: {
  featured: Skill[];
  installedIds: Set<string>;
  onRun(skill: Skill): void;
}) {
  return (
    <div className="quick-skills">
      <span className="quick-skills-label">{t('quickSkills')}</span>
      {featured.map((s) => (
        <button
          key={s.id}
          className="quick-chip"
          onClick={() => onRun(s)}
          title={langLabel(s.description, s.descriptionEn)}
        >
          {installedIds.has(s.id) ? '' : '＋ '}
          {langLabel(s.name, s.nameEn)}
        </button>
      ))}
    </div>
  );
}

function Composer({
  streaming,
  plusActive,
  onTogglePlus,
  onSend,
  onStop,
}: {
  streaming: boolean;
  plusActive: boolean;
  onTogglePlus(): void;
  onSend(text: string): void;
  onStop(): void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    onSend(v);
  };

  return (
    <div className="composer">
      <button
        className={`composer-plus${plusActive ? ' active' : ''}`}
        onClick={onTogglePlus}
        aria-label={t('menuPlus')}
        title={t('menuPlus')}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M7 1.5V12.5M1.5 7H12.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t('chatPlaceholder')}
        rows={2}
        disabled={streaming}
      />
      {streaming ? (
        <button
          className="send-btn stop"
          onClick={onStop}
          aria-label={t('stop')}
          title={t('stop')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <button
          className="send-btn"
          onClick={submit}
          disabled={!text.trim()}
          aria-label={t('send')}
          title={t('send')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M7 1.5 12.5 7 7 12.5M12 7H1.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
