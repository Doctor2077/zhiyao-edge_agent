import { t } from '../i18n';
import { useSettings } from '../SettingsContext';
import { langLabel } from './langLabel';
import ToggleSwitch from './ToggleSwitch';

/** 对话页输入框上方的技能面板：查看并快速切换已安装技能 */
export default function SkillPicker({
  onClose,
  onManage,
}: {
  onClose(): void;
  onManage(): void;
}) {
  const { settings, installedSkills, toggleSkill } = useSettings();
  const enabled = new Set(settings.enabledSkillIds);

  return (
    <div className="skill-picker">
      <div className="skill-picker-head">
        <span className="skill-picker-title">{t('skillsTitle')}</span>
        <button className="btn-icon" aria-label={t('cancel')} onClick={onClose}>
          ✕
        </button>
      </div>
      {installedSkills.length === 0 ? (
        <p className="skill-picker-empty">{t('skillNone')}</p>
      ) : (
        <div className="skill-picker-list">
          {installedSkills.map((s) => (
            <div key={s.id} className="skill-picker-row">
              <div className="skill-picker-info">
                <span className="skill-picker-name">{langLabel(s.name, s.nameEn)}</span>
                <span className="skill-picker-desc">
                  {langLabel(s.description, s.descriptionEn)}
                </span>
              </div>
              <ToggleSwitch
                small
                checked={enabled.has(s.id)}
                onChange={(v) => void toggleSkill(s.id, v)}
              />
            </div>
          ))}
        </div>
      )}
      <button
        className="btn btn-small skill-picker-manage"
        onClick={onManage}
      >
        {t('skillPickerManage')}
      </button>
    </div>
  );
}
