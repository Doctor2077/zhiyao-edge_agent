import { browser } from 'wxt/browser';
import { t } from '../i18n';
import BrandMark from '../BrandMark';

/** 「关于」页：版本号 + 扩展介绍 + 反馈 + 微信赞赏 */
export default function AboutView() {
  const version = browser.runtime.getManifest().version;
  const features = [
    t('aboutFeatureChat'),
    t('aboutFeatureAgent'),
    t('aboutFeatureSkills'),
    t('aboutFeatureTranslate'),
    t('aboutFeatureMedia'),
    t('aboutFeatureTasks'),
  ];

  return (
    <div className="about">
      <div className="about-hero">
        <span className="about-logo">
          <BrandMark size={44} />
        </span>
        <span className="about-name">{t('extName')}</span>
        <span className="about-version">
          {t('aboutVersion')} v{version}
        </span>
      </div>
      <p className="about-slogan">{t('aboutSlogan')}</p>

      <section className="settings-section">
        <h3>{t('aboutTitle')}</h3>
        <p className="about-intro">{t('aboutIntro')}</p>
        <ul className="about-features">
          {features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p className="privacy-hint">{t('aboutPrivacy')}</p>
      </section>

      <section className="settings-section">
        <h3>{t('aboutFeedback')}</h3>
        <p className="about-intro">{t('aboutFeedbackHint')}</p>
        <a className="about-mail" href="mailto:3538982885@qq.com">
          3538982885@qq.com
        </a>
      </section>

      <section className="settings-section">
        <h3>{t('aboutDonate')}</h3>
        <p className="skills-hint">{t('aboutDonateHint')}</p>
        <img
          className="about-qr"
          src={browser.runtime.getURL('/donate-qr.jpg')}
          alt={t('aboutDonate')}
        />
      </section>
    </div>
  );
}
