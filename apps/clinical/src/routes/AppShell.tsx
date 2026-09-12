import { NavLink, Outlet } from 'react-router-dom';
import { hasPermission } from '@health24/shared';
import { useAuth } from '../auth/AuthProvider';
import { useOwnHospital } from '../api/hooks';

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
  const hospital = useOwnHospital();

  if (!staff) return <></>;

  const canSeeMergeQueue = hasPermission(staff.role, 'merge:read');
  const canSeePatients = hasPermission(staff.role, 'patient:search');
  const canRegister = hasPermission(staff.role, 'patient:create');
  const canSeeStaff = hasPermission(staff.role, 'staff:read');

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__brand">
          <strong>Health24</strong>
          <span className="shell__hospital">
            {hospital.data?.name ?? staff.hospitalName ?? 'Platform'}
            {hospital.data ? (
              <em className={`badge badge--${hospital.data.facilityType}`}>
                {hospital.data.facilityType}
              </em>
            ) : null}
          </span>
        </div>

        <nav className="shell__nav">
          {canSeePatients ? (
            <NavLink to="/patients" className={({ isActive }) => (isActive ? 'active' : '')}>
              Patients
            </NavLink>
          ) : null}
          {canRegister ? (
            <NavLink to="/patients/new" className={({ isActive }) => (isActive ? 'active' : '')}>
              Register
            </NavLink>
          ) : null}
          {canSeeMergeQueue ? (
            <NavLink to="/merge-queue" className={({ isActive }) => (isActive ? 'active' : '')}>
              Duplicates
            </NavLink>
          ) : null}
          {canSeeStaff ? (
            <NavLink to="/staff" className={({ isActive }) => (isActive ? 'active' : '')}>
              Staff
            </NavLink>
          ) : null}
        </nav>

        <div className="shell__user">
          <span>
            {staff.name}
            <em className="shell__role">
              {staff.role.replace('_', ' ')}
              {staff.systemOfMedicine ? ` · ${staff.systemOfMedicine}` : ''}
            </em>
          </span>
          <button type="button" className="ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

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
        <Outlet />
      </main>
    </div>
  );
}
