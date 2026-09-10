import { useMemo, useState } from 'react';
import {
  BUILTIN_SKILLS,
  SKILL_CATEGORIES,
  type Skill,
} from '@/core/skills';
import { t, uiLang } from '../i18n';
import { useSettings } from '../SettingsContext';
import { langLabel } from './langLabel';
import ToggleSwitch from './ToggleSwitch';

export default function SkillsSection() {
  const {
    settings,
    installedSkills,
    installSkill,
    removeSkill,
    toggleSkill,
    importSkillJson,
  } = useSettings();

  const [viewingId, setViewingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [storeQuery, setStoreQuery] = useState('');

  const installedById = useMemo(() => {
    const m = new Map<string, Skill>();
    for (const s of installedSkills) m.set(s.id, s);
    return m;
  }, [installedSkills]);
  const enabledIds = new Set(settings.enabledSkillIds);

  const filtered = useMemo(() => {
    const q = storeQuery.trim().toLowerCase();
    if (!q) return BUILTIN_SKILLS;
    return BUILTIN_SKILLS.filter((s) =>
      [
        s.name,
        s.nameEn ?? '',
        s.description,
        s.descriptionEn ?? '',
        s.id,
      ].some((v) => v.toLowerCase().includes(q)),
    );
  }, [storeQuery]);

  const featuredList = filtered.filter((s) => s.featured);
  const groups = SKILL_CATEGORIES.map((c) => ({
    cat: c,
    items: filtered.filter((s) => s.category === c.id && !s.featured),
  })).filter((g) => g.items.length > 0);

  const doImport = async () => {
    if (!importText.trim()) return;
    const res = await importSkillJson(importText.trim());
    if (res.ok) {
      setImportMsg({ ok: true, text: t('skillImportOk') });
      setImportText('');
    } else {
      setImportMsg({ ok: false, text: res.error });
    }
  };

  return (
    <section className="settings-section">
      <h3>{t('skillsTitle')}</h3>
      <p className="skills-hint">{t('skillsHint')}</p>

      {installedSkills.length > 0 && (
        <>
          <h3 className="skills-subtitle">{t('skillInstalled')}</h3>
          {installedSkills.map((s) => (
            <div key={s.id} className="skill-row">
              <div className="skill-main">
                <div className="skill-head">
                  <span className="skill-name">
                    {langLabel(s.name, s.nameEn)}
                    <span className="skill-version">v{s.version}</span>
                  </span>
                </div>
                <span className="skill-desc">{langLabel(s.description, s.descriptionEn)}</span>
                {viewingId === s.id && (
                  <div className="skill-detail">
                    <p className="skill-detail-label">
                      {t('skillWhen')}：{s.whenToUse || '—'}
                    </p>
                    <p className="skill-detail-label">
                      {t('skillTools')}：{s.tools.length ? s.tools.join(', ') : '—'}
                    </p>
                    <p className="skill-detail-label">{t('skillInstructions')}：</p>
                    <pre className="skill-instructions">{s.instructions}</pre>
                  </div>
                )}
              </div>
              <div className="skill-actions">
                <ToggleSwitch
                  small
                  checked={enabledIds.has(s.id)}
                  onChange={(v) => void toggleSkill(s.id, v)}
                />
                <button
                  className="btn btn-small"
                  onClick={() => setViewingId(viewingId === s.id ? null : s.id)}
                >
                  {viewingId === s.id ? t('skillHide') : t('skillView')}
                </button>
                <button className="btn btn-small btn-danger" onClick={() => void removeSkill(s.id)}>
                  {t('delete')}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <h3 className="skills-subtitle">{t('skillStore')}</h3>
      <input
        className="skill-search"
        type="search"
        value={storeQuery}
        onChange={(e) => setStoreQuery(e.target.value)}
        placeholder={t('skillSearch')}
      />
      {featuredList.length > 0 && (
        <div className="skill-group">
          <div className="skill-cat-title">★ {t('featuredSkills')}</div>
          {featuredList.map((s) => {
            const installed = installedById.get(s.id);
            const updateable = installed && installed.version !== s.version;
            return (
              <div key={s.id} className="skill-row">
                <div className="skill-main">
                  <span className="skill-name">
                    {langLabel(s.name, s.nameEn)}
                    <span className="skill-badge skill-badge-featured">
                      {t('featured')}
                    </span>
                  </span>
                  <span className="skill-desc">
                    {langLabel(s.description, s.descriptionEn)}
                  </span>
                </div>
                <div className="skill-actions">
                  {installed ? (
                    updateable ? (
                      <button
                        className="btn btn-small"
                        onClick={() => void installSkill(structuredClone(s))}
                      >
                        {t('skillUpdate')}
                      </button>
                    ) : (
                      <span className="skill-badge">{t('skillInstalled')}</span>
                    )
                  ) : (
                    <button
                      className="btn btn-small btn-primary"
                      onClick={() => void installSkill(structuredClone(s))}
                    >
                      {t('skillInstall')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {groups.map(({ cat, items }) => (
        <div key={cat.id} className="skill-group">
          <div className="skill-cat-title">
            {uiLang() === 'zh' ? cat.label : cat.labelEn}
          </div>
          {items.map((s) => {
            const installed = installedById.get(s.id);
            const updateable = installed && installed.version !== s.version;
            return (
              <div key={s.id} className="skill-row">
                <div className="skill-main">
                  <span className="skill-name">{langLabel(s.name, s.nameEn)}</span>
                  <span className="skill-desc">{langLabel(s.description, s.descriptionEn)}</span>
                </div>
                <div className="skill-actions">
                  {installed ? (
                    updateable ? (
                      <button
                        className="btn btn-small"
                        onClick={() => void installSkill(structuredClone(s))}
                      >
                        {t('skillUpdate')}
                      </button>
                    ) : (
                      <span className="skill-badge">{t('skillInstalled')}</span>
                    )
                  ) : (
                    <button
                      className="btn btn-small btn-primary"
                      onClick={() => void installSkill(structuredClone(s))}
                    >
                      {t('skillInstall')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {groups.length === 0 && <p className="empty">{t('skillNone')}</p>}

      <div className="skill-import">
        {!importOpen ? (
          <button className="btn btn-small" onClick={() => setImportOpen(true)}>
            {t('skillImport')}
          </button>
        ) : (
          <div className="skill-import-box">
            <textarea
              rows={6}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={t('skillImportPlaceholder')}
            />
            <div className="skill-import-actions">
              <button className="btn btn-small btn-primary" onClick={() => void doImport()}>
                {t('skillImportBtn')}
              </button>
              <button
                className="btn btn-small"
                onClick={() => {
                  setImportOpen(false);
                  setImportMsg(null);
                }}
              >
                {t('cancel')}
              </button>
              {importMsg && (
                <span className={importMsg.ok ? 'import-ok' : 'import-fail'}>
                  {importMsg.text}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
