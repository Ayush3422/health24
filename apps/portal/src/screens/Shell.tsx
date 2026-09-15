import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '../session/SessionProvider';

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
        {me ? <p className="topbar__viewing">{t('shell.viewing', { name: me.patient.name })}</p> : null}
        <nav aria-label={t('shell.menu')} className="tabs">
          <NavLink end to="/">
            {t('shell.home')}
          </NavLink>
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
