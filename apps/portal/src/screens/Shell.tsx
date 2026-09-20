import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '../session/SessionProvider';

/** The patient's record, in the order people look for it. */
const RECORD_LINKS = [
  ['/timeline', 'shell.timeline'],
  ['/medicines', 'shell.medicines'],
  ['/problems', 'shell.problems'],
  ['/allergies', 'shell.allergies'],
  ['/reports', 'shell.reports'],
  ['/results', 'shell.results'],
  ['/consents', 'shell.consents'],
  ['/access', 'shell.access'],
  ['/emergency-card', 'shell.emergencyCard'],
  ['/my-data', 'shell.myData'],
] as const;

/** The signed-in frame: whose record is open, the way around, and signing out. */
export function Shell(): JSX.Element {
  const { t } = useTranslation();
  const { me, signOut } = useSession();

  return (
    <>
      <a className="skip-link" href="#content">
        {t('app.skipToContent')}
      </a>
      <header className="topbar">
        <div className="topbar__row">
          <span className="brand">{t('app.name')}</span>
          <button type="button" className="link" onClick={() => void signOut()}>
            {t('shell.signOut')}
          </button>
        </div>
        {me ? (
          <p className="topbar__viewing">
            {me.patient.relationship === 'guardian'
              ? t('shell.actingForChild', { name: me.patient.name })
              : t('shell.viewing', { name: me.patient.name })}
          </p>
        ) : null}
        <nav aria-label={t('shell.menu')} className="tabs">
          <NavLink end to="/">
            {t('shell.home')}
          </NavLink>
          {RECORD_LINKS.map(([to, label]) => (
            <NavLink key={to} to={to}>
              {t(label)}
            </NavLink>
          ))}
          {me && me.patients.length > 1 ? <NavLink to="/switch">{t('shell.switch')}</NavLink> : null}
          <NavLink to="/devices">{t('shell.devices')}</NavLink>
        </nav>
      </header>
      <main id="content" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
