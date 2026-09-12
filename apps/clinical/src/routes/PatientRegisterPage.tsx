import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { GENDERS, BLOOD_GROUPS, type RegisterPatientInput } from '@health24/shared';
import { ApiError } from '../api/client';
import { useLinkPatient, useRegisterPatient, type MatchCandidate } from '../api/hooks';

interface FormState {
  name: string;
  gender: string;
  dateOfBirth: string;
  approximateAgeYears: string;
  phone: string;
  abhaNumber: string;
  bloodGroup: string;
}

const EMPTY: FormState = {
  name: '',
  gender: 'undisclosed',
  dateOfBirth: '',
  approximateAgeYears: '',
  phone: '',
  abhaNumber: '',
  bloodGroup: '',
};

/**
 * Registration.
 *
 * The important behaviour is what happens when the server thinks this person
 * may already exist. Rather than silently creating a duplicate or silently
 * merging, it returns candidates and the receptionist decides. Registration is
 * the moment a duplicate is cheapest to prevent, and the only moment the
 * person is standing in front of you to ask.
 */
export function PatientRegisterPage(): JSX.Element {
  const navigate = useNavigate();
  const register = useRegisterPatient();
  const link = useLinkPatient();

  const [form, setForm] = useState<FormState>(EMPTY);
  const [candidates, setCandidates] = useState<MatchCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const update = (field: keyof FormState, value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  /** Only the fields the API accepts, with blanks omitted rather than sent. */
  const payload = () => {
    const body: Record<string, unknown> = { name: form.name.trim(), gender: form.gender };

    if (form.dateOfBirth) body.dateOfBirth = form.dateOfBirth;
    if (form.approximateAgeYears) body.approximateAgeYears = Number(form.approximateAgeYears);
    if (form.phone) body.phone = form.phone;
    if (form.abhaNumber) body.abhaNumber = form.abhaNumber;
    if (form.bloodGroup) body.bloodGroup = form.bloodGroup;

    return body;
  };

  const submit = async (event: FormEvent, forceCreate = false) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setCandidates(null);

    try {
      const body = { ...payload(), ...(forceCreate ? { forceCreate: true } : {}) };
      const result = await register.mutateAsync(
        body as unknown as RegisterPatientInput & { forceCreate?: boolean },
      );

      navigate(`/patients/${result.patient.id}`, {
        state: { linkedExisting: result.linkedExisting, queued: result.queuedForReview },
      });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const body = caught.body as { candidates?: MatchCandidate[] };
        setCandidates(body.candidates ?? []);
        return;
      }

      if (caught instanceof ApiError && caught.fieldErrors.length > 0) {
        setFieldErrors(
          Object.fromEntries(caught.fieldErrors.map((issue) => [issue.field, issue.message])),
        );
        setError('Please correct the highlighted fields.');
        return;
      }

      setError(caught instanceof ApiError ? caught.message : 'Could not register the patient');
    }
  };

  const linkExisting = async (patientId: string) => {
    setError(null);

    try {
      const result = await link.mutateAsync({ patientId, identity: payload() });
      navigate(`/patients/${result.patient.id}`, { state: { linkedExisting: true } });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not link this patient to your hospital',
      );
    }
  };

  return (
    <div className="page page--narrow">
      <h1>Register a patient</h1>

      {error ? <p className="alert alert--error">{error}</p> : null}

      {candidates ? (
        <section className="alert alert--warning candidates">
          <h2>This may already be someone we know</h2>
          <p>
            {candidates.length === 1
              ? 'One existing record looks like this person.'
              : `${candidates.length} existing records look like this person.`}{' '}
            Details are masked until you confirm a match.
          </p>

          <ul>
            {candidates.map((candidate) => (
              <li key={candidate.patientId}>
                <div>
                  <strong>{candidate.maskedName}</strong>
                  <span className="muted">
                    {candidate.yearOfBirth ? ` born ${candidate.yearOfBirth}` : ''}
                    {candidate.maskedPhone ? ` · ${candidate.maskedPhone}` : ''}
                    {` · known at ${candidate.hospitalCount} hospital${candidate.hospitalCount === 1 ? '' : 's'}`}
                  </span>
                  <span className="muted small">
                    matched on {candidate.matchedOn.join(', ') || 'weak similarity'} ·{' '}
                    {Math.round(candidate.score * 100)}% confidence
                  </span>
                </div>

                <button type="button" onClick={() => void linkExisting(candidate.patientId)}>
                  This is the same person
                </button>
              </li>
            ))}
          </ul>

          <div className="candidates__actions">
            <button type="button" className="ghost" onClick={() => setCandidates(null)}>
              Go back and check the details
            </button>
            <button
              type="button"
              className="danger"
              onClick={(event) => void submit(event, true)}
              disabled={register.isPending}
            >
              None of these — register as a new patient
            </button>
          </div>

          <p className="muted small">
            Registering anyway is recorded for the records team to review, so a genuine duplicate
            does not simply become permanent.
          </p>
        </section>
      ) : null}

      <form onSubmit={(event) => void submit(event)} className="form">
        <div className="field">
          <label htmlFor="name">Full name</label>
          <input
            id="name"
            value={form.name}
            onChange={(event) => update('name', event.target.value)}
            required
            autoFocus
          />
          {fieldErrors.name ? <span className="field__error">{fieldErrors.name}</span> : null}
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="gender">Gender</label>
            <select
              id="gender"
              value={form.gender}
              onChange={(event) => update('gender', event.target.value)}
            >
              {GENDERS.map((gender) => (
                <option key={gender} value={gender}>
                  {gender}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="bloodGroup">Blood group</label>
            <select
              id="bloodGroup"
              value={form.bloodGroup}
              onChange={(event) => update('bloodGroup', event.target.value)}
            >
              <option value="">Not known</option>
              {BLOOD_GROUPS.filter((group) => group !== 'unknown').map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="field">
          <legend>Age</legend>
          <p className="muted small">
            A date of birth is better for matching, but many patients do not know theirs — an
            approximate age is accepted rather than forcing a guess into the date field.
          </p>

          <div className="field-row">
            <div className="field">
              <label htmlFor="dateOfBirth">Date of birth</label>
              <input
                id="dateOfBirth"
                type="date"
                value={form.dateOfBirth}
                onChange={(event) => update('dateOfBirth', event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="approximateAgeYears">or approximate age</label>
              <input
                id="approximateAgeYears"
                type="number"
                min={0}
                max={130}
                value={form.approximateAgeYears}
                onChange={(event) => update('approximateAgeYears', event.target.value)}
              />
            </div>
          </div>

          {fieldErrors.dateOfBirth ? (
            <span className="field__error">{fieldErrors.dateOfBirth}</span>
          ) : null}
        </fieldset>

        <div className="field-row">
          <div className="field">
            <label htmlFor="phone">Mobile number</label>
            <input
              id="phone"
              value={form.phone}
              onChange={(event) => update('phone', event.target.value)}
              placeholder="98765 43210"
            />
            {fieldErrors.phone ? <span className="field__error">{fieldErrors.phone}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="abhaNumber">ABHA number</label>
            <input
              id="abhaNumber"
              value={form.abhaNumber}
              onChange={(event) => update('abhaNumber', event.target.value)}
              placeholder="14 digits"
            />
            {fieldErrors.abhaNumber ? (
              <span className="field__error">{fieldErrors.abhaNumber}</span>
            ) : null}
          </div>
        </div>

        <p className="muted small">
          A phone number or ABHA number is what lets this patient&apos;s records follow them to
          another hospital. Neither is required, but without one the record will not link up.
        </p>

        <button type="submit" disabled={register.isPending}>
          {register.isPending ? 'Registering…' : 'Register patient'}
        </button>
      </form>
    </div>
  );
}
