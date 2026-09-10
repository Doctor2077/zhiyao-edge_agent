import { useState } from 'react';
import { SettingsProvider, useSettings } from '@/ui/SettingsContext';
import { useChat } from '@/ui/useChat';
import ChatView from '@/ui/components/ChatView';
import SettingsView from '@/ui/components/SettingsView';
import SkillsView from '@/ui/components/SkillsView';
import HistoryView from '@/ui/components/HistoryView';
import AboutView from '@/ui/components/AboutView';
import { t } from '@/ui/i18n';
import BrandMark from '@/ui/BrandMark';
import type { Session } from '@/core/sessions';

type View = 'chat' | 'skills' | 'history' | 'settings' | 'about';

export default function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  );
}

function AppInner() {
  const [view, setView] = useState<View>('chat');
  // 唯一的聊天状态实例：对话视图与历史加载共用同一份状态
  const chat = useChat();
  // 订阅设置上下文：语言切换等设置变更时让导航与当前视图即时重渲染
  useSettings();

  const openSession = (session: Session) => {
    chat.loadSession(session);
    setView('chat');
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark size={22} />
          </span>
          <span className="brand-name">{t('extName')}</span>
        </div>
        <nav className="app-nav" role="tablist">
          <button
            role="tab"
            aria-selected={view === 'chat'}
            className={view === 'chat' ? 'active' : ''}
            onClick={() => setView('chat')}
          >
            {t('navChat')}
          </button>
          <button
            role="tab"
            aria-selected={view === 'skills'}
            className={view === 'skills' ? 'active' : ''}
            onClick={() => setView('skills')}
          >
            {t('navSkills')}
          </button>
          <button
            role="tab"
            aria-selected={view === 'history'}
            className={view === 'history' ? 'active' : ''}
            onClick={() => setView('history')}
          >
            {t('navHistory')}
          </button>
          <button
            role="tab"
            aria-selected={view === 'settings'}
            className={view === 'settings' ? 'active' : ''}
            onClick={() => setView('settings')}
          >
            {t('navSettings')}
          </button>
          <button
            role="tab"
            aria-selected={view === 'about'}
            className={view === 'about' ? 'active' : ''}
            onClick={() => setView('about')}
          >
            {t('navAbout')}
          </button>
        </nav>
      </header>
      <main className="app-main">
        {view === 'chat' && (
          <ChatView
            chat={chat}
            onOpenSettings={() => setView('settings')}
            onOpenSkills={() => setView('skills')}
          />
        )}
        {view === 'skills' && <SkillsView />}
        {view === 'history' && <HistoryView onOpenSession={openSession} />}
        {view === 'settings' && <SettingsView />}
        {view === 'about' && <AboutView />}
      </main>
    </div>
  );
}
