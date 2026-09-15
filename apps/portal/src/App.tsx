import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Shell } from './screens/Shell';
import { DevicesScreen } from './screens/DevicesScreen';
import { HomeScreen } from './screens/HomeScreen';
import { SignInScreen } from './screens/SignInScreen';
import { SwitchScreen } from './screens/SwitchScreen';
import { useSession } from './session/SessionProvider';

export function App(): JSX.Element {
  const { status } = useSession();
  const { t } = useTranslation();

  if (status === 'restoring') {
    return (
      <main className="splash" aria-busy="true">
        <p>{t('app.loading')}</p>
      </main>
    );
  }

  if (status === 'signed-out') return <SignInScreen />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomeScreen />} />
        <Route path="switch" element={<SwitchScreen />} />
        <Route path="devices" element={<DevicesScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
