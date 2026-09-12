import { useStaff } from '../api/hooks';

export function StaffPage(): JSX.Element {
  const staff = useStaff(true);

  if (staff.isPending) return <div className="page">Loading…</div>;

  if (staff.isError) {
    return (
      <div className="page">
        <p className="alert alert--error">You do not have access to staff management.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>Staff</h1>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>System</th>
            <th>Status</th>
            <th>Second factor</th>
          </tr>
        </thead>
        <tbody>
          {staff.data.map((member) => (
            <tr key={member.id}>
              <td>{member.name}</td>
              <td>{member.email}</td>
              <td>{member.role.replace('_', ' ')}</td>
              <td>{member.systemOfMedicine ?? '—'}</td>
              <td>
                <span className={`status status--${member.status}`}>{member.status}</span>
              </td>
              <td>{member.mfaEnrolled ? 'Enrolled' : 'Not yet set up'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
