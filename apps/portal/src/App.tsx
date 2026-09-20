import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AccessHistoryScreen } from './screens/AccessHistoryScreen';
import { ConsentsScreen } from './screens/ConsentsScreen';
import { DevicesScreen } from './screens/DevicesScreen';
import { EmergencyCardScreen } from './screens/EmergencyCardScreen';
import { EmergencyPublicScreen } from './screens/EmergencyPublicScreen';
import { HomeScreen } from './screens/HomeScreen';
import { MyDataScreen } from './screens/MyDataScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { Shell } from './screens/Shell';
import { SignInScreen } from './screens/SignInScreen';
import { SwitchScreen } from './screens/SwitchScreen';
import { TimelineScreen } from './screens/TimelineScreen';
import { TrendScreen } from './screens/TrendScreen';
import { useSession } from './session/SessionProvider';

export function App(): JSX.Element {
  return (
    <Routes>
      {/* An emergency card's QR code opens this, without signing in (Decision L1). */}
      <Route path="/e/:token" element={<EmergencyPublicScreen />} />
      <Route path="*" element={<PatientApp />} />
    </Routes>
  );
}

function PatientApp(): JSX.Element {
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
        <Route path="timeline" element={<TimelineScreen page="timeline" />} />
        <Route path="medicines" element={<TimelineScreen page="medicines" />} />
        <Route path="problems" element={<TimelineScreen page="problems" />} />
        <Route path="allergies" element={<TimelineScreen page="allergies" />} />
        <Route path="reports" element={<ReportsScreen />} />
        <Route path="results" element={<ResultsScreen />} />
        <Route path="results/:code" element={<TrendScreen />} />
        <Route path="consents" element={<ConsentsScreen />} />
        <Route path="access" element={<AccessHistoryScreen />} />
        <Route path="emergency-card" element={<EmergencyCardScreen />} />
        <Route path="my-data" element={<MyDataScreen />} />
        <Route path="switch" element={<SwitchScreen />} />
        <Route path="devices" element={<DevicesScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
