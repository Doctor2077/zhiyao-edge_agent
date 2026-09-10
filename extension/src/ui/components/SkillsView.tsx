import { t } from '../i18n';
import SkillsSection from './SkillsSection';

/** 技能：独立一栏（商店 + 已安装管理 + 导入） */
export default function SkillsView() {
  return (
    <div className="settings skills-page">
      <h2 className="settings-heading">{t('skillsTitle')}</h2>
      <SkillsSection />
    </div>
  );
}
