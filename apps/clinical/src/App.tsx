import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { LoginPage } from './auth/LoginPage';
import { AppShell } from './routes/AppShell';
import { MergeQueuePage } from './routes/MergeQueuePage';
import { PatientDetailPage } from './routes/PatientDetailPage';
import { PatientRegisterPage } from './routes/PatientRegisterPage';
import { PatientSearchPage } from './routes/PatientSearchPage';
import { StaffPage } from './routes/StaffPage';

export function App(): JSX.Element {
  const { status } = useAuth();

  // Restoring a session from the refresh token. Rendering the login screen
  // here would flash it on every page reload.
  if (status === 'restoring') {
    return <div className="booting">Loading…</div>;
  }

  if (status === 'signed-out') {
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/patients" element={<PatientSearchPage />} />
        <Route path="/patients/new" element={<PatientRegisterPage />} />
        <Route path="/patients/:id" element={<PatientDetailPage />} />
        <Route path="/merge-queue" element={<MergeQueuePage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="*" element={<Navigate to="/patients" replace />} />
      </Route>
    </Routes>
  );
}
