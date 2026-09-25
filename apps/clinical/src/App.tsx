import { Navigate, Route, Routes } from 'react-router-dom';
import { hasPermission, type StaffRole } from '@health24/shared';
import { useAuth } from './auth/AuthProvider';
import { LoginPage } from './auth/LoginPage';
import { OfflineSignInNotice } from './offline/OfflineNotice';
import { AppShell } from './routes/AppShell';
import { BreakGlassReviewPage } from './routes/BreakGlassReviewPage';
import { CataloguePage } from './routes/CataloguePage';
import { CodingReviewPage } from './routes/CodingReviewPage';
import { CurationPage } from './routes/CurationPage';
import { DeviceSearchPage } from './routes/DeviceSearchPage';
import { EncounterPage } from './routes/EncounterPage';
import { CorrectionRequestsPage } from './routes/CorrectionRequestsPage';
import { ErasureRequestsPage } from './routes/ErasureRequestsPage';
import { MergeQueuePage } from './routes/MergeQueuePage';
import { OrderWorklistPage } from './routes/OrderWorklistPage';
import { ImportBatchPage } from './routes/ImportBatchPage';
import { PatientDetailPage } from './routes/PatientDetailPage';
import { PatientRegisterPage } from './routes/PatientRegisterPage';
import { PatientSearchPage } from './routes/PatientSearchPage';
import { StaffPage } from './routes/StaffPage';
import { TerminologyPage } from './routes/TerminologyPage';
import { WardsPage } from './routes/WardsPage';
import { WorklistPage } from './routes/WorklistPage';

/**
 * Where each role lands after signing in.
 *
 * Derived from the permission matrix rather than hard-coded per role. Sending
 * everyone to the patient list, as before, put hospital admins, platform
 * admins and curators on a page that answered every request with a 403.
 */
function homeFor(role: StaffRole): string {
  // Clinicians and records staff start from the day's encounters.
  if (hasPermission(role, 'clinical:read')) return '/encounters';
  if (hasPermission(role, 'patient:search')) return '/patients';
  if (hasPermission(role, 'terminology:curate')) return '/terminology/review';
  if (hasPermission(role, 'privacy:review')) return '/erasure-requests';
  if (hasPermission(role, 'staff:read')) return '/staff';
  if (hasPermission(role, 'terminology:read')) return '/terminology';
  return '/patients';
}

export function App(): JSX.Element {
  const { status, staff } = useAuth();

  // Restoring a session from the refresh token. Rendering the login screen
  // here would flash it on every page reload.
  if (status === 'restoring') {
    return <div className="booting">Loading…</div>;
  }

  if (status === 'signed-out' || !staff) {
    return (
      <>
        <OfflineSignInNotice />
        <LoginPage />
      </>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/patients" element={<PatientSearchPage />} />
        <Route path="/patients/new" element={<PatientRegisterPage />} />
        <Route path="/patients/:id" element={<PatientDetailPage />} />
        <Route path="/patients/:id/:tab" element={<PatientDetailPage />} />
        <Route path="/patients/:id/imports/:batchId" element={<ImportBatchPage />} />
        <Route path="/encounters" element={<WorklistPage />} />
        <Route path="/encounters/:id" element={<EncounterPage />} />
        <Route path="/orders" element={<OrderWorklistPage />} />
        <Route path="/wards" element={<WardsPage />} />
        <Route path="/devices" element={<DeviceSearchPage />} />
        <Route path="/catalogue" element={<CataloguePage />} />
        <Route path="/merge-queue" element={<MergeQueuePage />} />
        <Route path="/correction-requests" element={<CorrectionRequestsPage />} />
        <Route path="/erasure-requests" element={<ErasureRequestsPage />} />
        <Route path="/coding-reviews" element={<CodingReviewPage />} />
        <Route path="/break-glass/reviews" element={<BreakGlassReviewPage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="/terminology" element={<TerminologyPage />} />
        <Route path="/terminology/review" element={<CurationPage />} />
        <Route path="*" element={<Navigate to={homeFor(staff.role)} replace />} />
      </Route>
    </Routes>
  );
}
