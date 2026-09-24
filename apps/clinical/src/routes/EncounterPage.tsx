import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  ENCOUNTER_CLASS_LABELS,
  useCloseEncounter,
  useEncounter,
  useEncounterDiagnoses,
  useEncounterPrescriptions,
} from '../api/clinical';
import {
  useEncounterNotes,
  useEncounterProcedures,
  useEncounterVitals,
} from '../api/documentation';
import { useEncounterOrders } from '../api/orders';
import { useAuth } from '../auth/AuthProvider';
import { AdmissionPanel } from '../clinical/Admission';
import { AllergyBanner } from '../clinical/AllergyBanner';
import { DiagnosisEntry, DiagnosisList } from '../clinical/Diagnoses';
import { formatDateTime, humanise } from '../clinical/format';
import { MedicationList, PrescriptionForm } from '../clinical/Medications';
import { NoteForm, NoteList } from '../clinical/Notes';
import { OrderForm, OrderList } from '../clinical/Orders';
import { ProcedureForm, ProcedureList } from '../clinical/Procedures';
import { Provenance, SystemTag } from '../clinical/Provenance';
import { LoincNotice, VitalsForm, VitalsList } from '../clinical/Vitals';

/**
 * One encounter: the allergy banner, vitals, what was diagnosed and
 * prescribed, the notes and any procedures.
 *
 * Another hospital's encounter, shared under consent, is read-only here — and
 * says so. Each kind of entry on it appears only where the consent covers that
 * kind too.
 */
export function EncounterPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { staff } = useAuth();
  const encounter = useEncounter(id);
  const diagnoses = useEncounterDiagnoses(id);
  const prescriptions = useEncounterPrescriptions(id);
  const vitals = useEncounterVitals(id ?? '');
  const notes = useEncounterNotes(id ?? '');
  const procedures = useEncounterProcedures(id ?? '');
  const orders = useEncounterOrders(id ?? '');
  const close = useCloseEncounter();

  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (encounter.isPending) return <div className="page">Loading…</div>;

  if (encounter.isError) {
    return (
      <div className="page">
        <p className="alert alert--error">This encounter is not available to your hospital.</p>
        <Link to="/encounters">Back to encounters</Link>
      </div>
    );
  }

  const record = encounter.data;
  const role = staff?.role;
  const canWrite = Boolean(
    role && (hasPermission(role, 'clinical:write') || hasPermission(role, 'clinical:transcribe')),
  );
  const canStop = Boolean(role && hasPermission(role, 'clinical:write'));
  const canOrder = Boolean(role && hasPermission(role, 'orders:place'));
  const canFulfil = Boolean(role && hasPermission(role, 'orders:fulfil'));
  const own = record.hospital.isOwn;
  const editable = canWrite && own && record.status !== 'cancelled';
  const closable = canWrite && own && record.status === 'in_progress';

  const finish = async () => {
    setError(null);
    try {
      await close.mutateAsync({ id: record.id, outcome: 'finish' });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not finish the encounter');
    }
  };

  const cancel = async () => {
    setError(null);
    try {
      await close.mutateAsync({ id: record.id, outcome: 'cancel', reason: reason.trim() });
      setCancelling(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel the encounter');
    }
  };

  const notShared = (what: string) =>
    own
      ? `No ${what} recorded on this encounter yet.`
      : `No ${what} from this encounter are shared with your hospital.`;

  return (
    <div className="page">
      <header className="patient-header">
        <div className="encounter-heading">
          <div>
            <h1>
              {record.patient ? (
                <Link to={`/patients/${record.patientId}`}>{record.patient.name}</Link>
              ) : (
                'Encounter'
              )}
              {record.patient?.mrn ? <span className="code"> {record.patient.mrn}</span> : null}
            </h1>
            <p className="muted">
              <SystemTag system={record.systemOfMedicine} /> {ENCOUNTER_CLASS_LABELS[record.class]}{' '}
              · started {formatDateTime(record.startedAt)}
              {record.endedAt ? ` · ended ${formatDateTime(record.endedAt)}` : ''} ·{' '}
              <span className={`status status--${record.status}`}>{humanise(record.status)}</span>
            </p>
            <p className="small muted">
              <Provenance
                hospital={record.hospital}
                clinician={record.attending}
                entry={record.entry}
              />
            </p>
            {record.chiefComplaint ? <p>{record.chiefComplaint}</p> : null}
            {record.statusReason ? (
              <p className="small muted">Cancelled: {record.statusReason}</p>
            ) : null}
          </div>

          {closable ? (
            <div className="encounter-actions">
              {cancelling ? (
                <div className="inline-form">
                  <label htmlFor="cancel-reason">Why is it being cancelled?</label>
                  <input
                    id="cancel-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Required, e.g. opened for the wrong patient"
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void cancel()}
                      disabled={reason.trim().length < 3 || close.isPending}
                    >
                      Cancel encounter
                    </button>
                    <button type="button" className="ghost" onClick={() => setCancelling(false)}>
                      Keep it open
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row">
                  <button type="button" onClick={() => void finish()} disabled={close.isPending}>
                    Finish encounter
                  </button>
                  <button type="button" className="ghost" onClick={() => setCancelling(true)}>
                    Cancel…
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </header>

      {error ? <p className="alert alert--error">{error}</p> : null}

      <AllergyBanner patientId={record.patientId} />

      <AdmissionPanel encounterId={record.id} encounterClass={record.class} own={own} />

      {own ? null : (
        <p className="alert alert--warning">
          Recorded at {record.hospital.name} and shared with your hospital under the patient&apos;s
          consent. It is read-only here.
        </p>
      )}

      <section>
        <h2>Vitals</h2>
        {vitals.isError ? (
          <p className="alert alert--error">Could not load vitals.</p>
        ) : (
          <VitalsList
            sets={vitals.data ?? []}
            emptyText={notShared('vitals')}
            editable={editable}
          />
        )}
        {editable ? <VitalsForm patientId={record.patientId} encounter={record} /> : null}
        {(vitals.data ?? []).length > 0 ? <LoincNotice /> : null}
      </section>

      <div className="clinical-columns">
        <section>
          <h2>Diagnoses</h2>
          {diagnoses.isError ? (
            <p className="alert alert--error">Could not load diagnoses.</p>
          ) : (
            <DiagnosisList
              conditions={diagnoses.data ?? []}
              emptyText={notShared('diagnoses')}
              encounter={editable ? record : undefined}
            />
          )}
          {editable && diagnoses.isSuccess ? (
            <DiagnosisEntry
              encounter={record}
              hasPrimary={diagnoses.data.some((condition) => condition.isPrimary)}
            />
          ) : null}
        </section>

        <section>
          <h2>Prescriptions</h2>
          {prescriptions.isError ? (
            <p className="alert alert--error">Could not load prescriptions.</p>
          ) : (
            <MedicationList
              medications={prescriptions.data ?? []}
              canStop={canStop}
              editable={editable}
              emptyText={notShared('prescriptions')}
            />
          )}
          {editable ? <PrescriptionForm encounter={record} /> : null}
        </section>
      </div>

      <div className="clinical-columns">
        <section>
          <h2>Notes</h2>
          {notes.isError ? (
            <p className="alert alert--error">Could not load notes.</p>
          ) : (
            <NoteList notes={notes.data ?? []} emptyText={notShared('notes')} editable={editable} />
          )}
          {editable ? <NoteForm encounter={record} /> : null}
        </section>

        <section>
          <h2>Orders</h2>
          {orders.isError ? (
            <p className="alert alert--error">Could not load orders.</p>
          ) : (
            <OrderList
              orders={orders.data ?? []}
              emptyText={
                own
                  ? 'Nothing has been ordered on this encounter yet.'
                  : 'Orders stay with the hospital that placed them.'
              }
              editable={editable && canOrder}
              canFulfil={own && canFulfil}
            />
          )}
          {editable && canOrder ? <OrderForm encounter={record} /> : null}
        </section>

        <section>
          <h2>Procedures and therapies</h2>
          {procedures.isError ? (
            <p className="alert alert--error">Could not load procedures.</p>
          ) : (
            <ProcedureList
              procedures={procedures.data ?? []}
              emptyText={notShared('procedures')}
              editable={editable}
            />
          )}
          {editable ? <ProcedureForm encounter={record} /> : null}
        </section>
      </div>
    </div>
  );
}
