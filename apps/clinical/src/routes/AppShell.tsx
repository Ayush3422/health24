import { NavLink, Outlet } from 'react-router-dom';
import { hasPermission } from '@health24/shared';
import { useAuth } from '../auth/AuthProvider';
import { useOwnHospital } from '../api/hooks';
import { useConnectivity } from '../offline/connectivity';
import { OfflineBanner } from '../offline/OfflineNotice';
import { useOfflineSync } from '../offline/useOfflineSync';

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');

/**
 * The frame every signed-in screen sits in.
 *
 * Navigation is filtered by the shared permission matrix rather than by a
 * separate list kept in the client. Defining it once means the interface can
 * never offer an action the server will refuse — and, more importantly, cannot
 * quietly diverge from it as roles change.
 */
export function AppShell(): JSX.Element {
  const { staff, signOut, idleWarningSeconds, stayActive } = useAuth();

  // Only roles that belong to a hospital may read it. Requesting it for every
  // role made each page load of a platform admin or curator a 403 — and every
  // 403 is written to the audit log as a refused access.
  const hospital = useOwnHospital(Boolean(staff && hasPermission(staff.role, 'hospital:read:own')));
  const { offline } = useConnectivity();
  useOfflineSync();

  if (!staff) return <></>;

  const canSeeMergeQueue = hasPermission(staff.role, 'merge:read');
  const canSeePatients = hasPermission(staff.role, 'patient:search');
  const canSeeEncounters = hasPermission(staff.role, 'clinical:read');
  const canRegister = hasPermission(staff.role, 'patient:create');
  const canSeeStaff = hasPermission(staff.role, 'staff:read');
  const canReadTerminology = hasPermission(staff.role, 'terminology:read');
  const canCurate = hasPermission(staff.role, 'terminology:curate');
  const canReviewCoding = hasPermission(staff.role, 'clinical:write');
  const canReviewEmergencyAccess = hasPermission(staff.role, 'consent:review');

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__brand">
          <strong>Health24</strong>
          <span className="shell__hospital">
            {hospital.data?.name ?? staff.hospitalName ?? 'Health24 platform'}
            {hospital.data ? (
              <em className={`badge badge--${hospital.data.facilityType}`}>
                {hospital.data.facilityType}
              </em>
            ) : null}
          </span>
        </div>

        <nav className="shell__nav">
          {canSeeEncounters ? (
            <NavLink to="/encounters" className={navClass}>
              Encounters
            </NavLink>
          ) : null}
          {canSeePatients ? (
            <NavLink to="/patients" end className={navClass}>
              Patients
            </NavLink>
          ) : null}
          {canRegister ? (
            <NavLink to="/patients/new" className={navClass}>
              Register
            </NavLink>
          ) : null}
          {canReviewCoding ? (
            <NavLink to="/coding-reviews" className={navClass}>
              Coding review
            </NavLink>
          ) : null}
          {canReviewEmergencyAccess ? (
            <NavLink to="/break-glass/reviews" className={navClass}>
              Emergency access
            </NavLink>
          ) : null}
          {canSeeMergeQueue ? (
            <NavLink to="/merge-queue" className={navClass}>
              Duplicates
            </NavLink>
          ) : null}
          {canReadTerminology ? (
            <NavLink to="/terminology" end className={navClass}>
              Terminology
            </NavLink>
          ) : null}
          {canCurate ? (
            <NavLink to="/terminology/review" className={navClass}>
              Mapping review
            </NavLink>
          ) : null}
          {canSeeStaff ? (
            <NavLink to="/staff" className={navClass}>
              Staff
            </NavLink>
          ) : null}
        </nav>

        <div className="shell__user">
          <span>
            {staff.name}
            <em className="shell__role">
              {staff.role.replace(/_/g, ' ')}
              {staff.systemOfMedicine ? ` · ${staff.systemOfMedicine}` : ''}
            </em>
          </span>
          <button type="button" className="ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <OfflineBanner />

      {idleWarningSeconds !== null ? (
        <div className="idle-warning" role="alert">
          <span>
            You will be signed out in {idleWarningSeconds}s. Shared workstations are signed out
            automatically.
          </span>
          <button type="button" onClick={stayActive}>
            Stay signed in
          </button>
        </div>
      ) : null}

      <main className="shell__main">
        {/* A disabled fieldset disables every control inside it: while offline,
            nothing that writes can be pressed, and nothing is hidden either. */}
        <fieldset className="offline-guard" disabled={offline}>
          <Outlet />
        </fieldset>
      </main>
    </div>
  );
}
