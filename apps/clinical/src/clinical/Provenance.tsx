import type { EntryRef, HospitalRef, SystemOfMedicine } from '@health24/shared';
import { SYSTEM_LABELS } from '../api/clinical';

/**
 * Where an entry came from: whose clinical decision, at which hospital, and
 * whether records staff typed it. Shown on every clinical entry, because a
 * clinician reading a shared record must always be able to tell their own
 * hospital's word from another's.
 */
export function Provenance({
  hospital,
  clinician,
  entry,
}: {
  hospital: HospitalRef;
  clinician: { id: string; name: string | null };
  entry: EntryRef;
}): JSX.Element {
  return (
    <span className="provenance">
      {/* Another hospital's staff directory is not shared, so its clinicians are unnamed. */}
      <span>{clinician.name ?? 'A clinician'}</span>
      <span aria-hidden="true"> · </span>
      {hospital.isOwn ? (
        <span>this hospital</span>
      ) : (
        <em className="tag tag--shared">{hospital.name}</em>
      )}
      {entry.source === 'transcribed' ? (
        <em className="tag tag--transcribed">
          transcribed by {entry.enteredBy.name ?? 'records staff'}
        </em>
      ) : null}
    </span>
  );
}

/** Traditional and biomedical care, told apart without relying on colour. */
export function SystemTag({ system }: { system: SystemOfMedicine }): JSX.Element {
  return (
    <em className={`tag tag--${system === 'allopathy' ? 'biomedical' : 'traditional'}`}>
      {SYSTEM_LABELS[system]}
    </em>
  );
}

/**
 * Said wherever a list could look complete but is not: when another hospital's
 * records of this kind are not shared, an empty list means nothing more than
 * "none recorded here".
 */
export function SharingNote({
  shared,
  what,
}: {
  shared: boolean;
  what: string;
}): JSX.Element | null {
  if (shared) return null;

  return (
    <p className="sharing-note small">
      {what} from other hospitals are not shared with your hospital. Only your hospital&apos;s
      records are shown.
    </p>
  );
}
