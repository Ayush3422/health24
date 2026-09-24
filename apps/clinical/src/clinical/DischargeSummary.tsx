import { useEffect, useState } from 'react';
import { hasPermission, type DischargeSummary as Summary } from '@health24/shared';
import { ApiError } from '../api/client';
import {
  useComposeDischarge,
  useDischargeSummary,
  useEditDischarge,
  useSignDischarge,
} from '../api/discharge';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime } from './format';

const errorText = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * The discharge summary on the admission it belongs to (sp6-plan.md, DF6).
 *
 * Composition fills the sections from what was recorded — the stay, the
 * diagnoses, the operation, the results, the medicines — and leaves the ones
 * only a clinician can write. Nothing is a summary until it is signed, and
 * after that it is not edited here: the note the signature wrote is corrected
 * like any other note.
 */
export function DischargeSummaryPanel({
  encounterId,
  encounterClass,
  own,
}: {
  encounterId: string;
  encounterClass: string;
  own: boolean;
}): JSX.Element | null {
  const { staff } = useAuth();
  const summary = useDischargeSummary(encounterId, own);

  if (!staff || !own) return null;
  if (encounterClass !== 'inpatient' && encounterClass !== 'emergency') return null;

  const canWrite =
    hasPermission(staff.role, 'clinical:write') || hasPermission(staff.role, 'clinical:transcribe');
  const canSign = hasPermission(staff.role, 'clinical:write');

  return (
    <section className="card">
      <div className="section-heading">
        <h2>Discharge summary</h2>
        {summary.data?.status === 'signed' ? (
          <span className="tag">Signed</span>
        ) : summary.data ? (
          <span className="tag">Draft</span>
        ) : null}
      </div>

      {summary.isPending ? <p>Loading…</p> : null}

      {!summary.data && !summary.isPending ? (
        <Start encounterId={encounterId} canWrite={canWrite} />
      ) : null}

      {summary.data ? <Draft summary={summary.data} canWrite={canWrite} canSign={canSign} /> : null}
    </section>
  );
}

function Start({ encounterId, canWrite }: { encounterId: string; canWrite: boolean }): JSX.Element {
  const compose = useComposeDischarge();
  const [error, setError] = useState<string | null>(null);

  if (!canWrite) return <p className="muted">No discharge summary has been written yet.</p>;

  const start = async () => {
    setError(null);
    try {
      await compose.mutateAsync({ encounterId });
    } catch (caught) {
      setError(errorText(caught, 'Could not compose the summary'));
    }
  };

  return (
    <>
      <p className="muted">
        Composing fills the summary from this admission’s own record — the stay, the diagnoses, the
        procedures and devices, the results and the medicines. What only you can say is left blank.
      </p>
      {error ? <p className="alert alert--error">{error}</p> : null}
      <button type="button" onClick={() => void start()} disabled={compose.isPending}>
        {compose.isPending ? 'Composing…' : 'Compose from the record'}
      </button>
    </>
  );
}

function Draft({
  summary,
  canWrite,
  canSign,
}: {
  summary: Summary;
  canWrite: boolean;
  canSign: boolean;
}): JSX.Element {
  const compose = useComposeDischarge();
  const edit = useEditDischarge();
  const sign = useSignDischarge();

  const [texts, setTexts] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The server's words win whenever it sends new ones — after composing again,
  // or after somebody else saved.
  useEffect(() => {
    setTexts(Object.fromEntries(summary.sections.map((section) => [section.key, section.text])));
  }, [summary]);

  const signed = summary.status === 'signed';
  const busy = compose.isPending || edit.isPending || sign.isPending;

  const changed = summary.sections.filter(
    (section) => (texts[section.key] ?? section.text) !== section.text,
  );

  const save = async () => {
    setError(null);
    try {
      await edit.mutateAsync({
        id: summary.id,
        body: {
          sections: changed.map((section) => ({
            key: section.key,
            text: texts[section.key] ?? section.text,
          })),
        },
      });
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught, 'Could not save the summary'));
    }
  };

  const recompose = async () => {
    setError(null);
    try {
      await compose.mutateAsync({ encounterId: summary.encounterId });
    } catch (caught) {
      setError(errorText(caught, 'Could not compose the summary again'));
    }
  };

  const put = async () => {
    setError(null);
    try {
      if (changed.length > 0) await save();
      await sign.mutateAsync(summary.id);
      setConfirming(false);
    } catch (caught) {
      setError(errorText(caught, 'Could not sign the summary'));
    }
  };

  return (
    <>
      {signed ? (
        <p className="small muted">
          Signed by {summary.signedBy?.name ?? 'a clinician'}{' '}
          {summary.signedAt ? formatDateTime(summary.signedAt) : ''}. It is kept as a note on this
          encounter and as a PDF in the patient’s reports; a change now is a correction to that
          note.
        </p>
      ) : (
        <p className="small muted">
          Composed {formatDateTime(summary.composedAt)} by{' '}
          {summary.composedBy.name ?? 'a clinician'}. Composing again pulls in anything recorded
          since, and leaves what you have written alone.
        </p>
      )}

      {error ? <p className="alert alert--error">{error}</p> : null}
      {saved && !signed ? <p className="alert alert--success">Saved.</p> : null}

      {summary.sections.map((section) => (
        <div className="field" key={section.key}>
          <label htmlFor={`discharge-${section.key}`}>
            {section.label}
            {section.composed && section.text ? <span className="tag">From the record</span> : null}
          </label>
          {signed || !canWrite ? (
            <p className="small entry__note">{section.text || '—'}</p>
          ) : (
            <textarea
              id={`discharge-${section.key}`}
              rows={section.text.split('\n').length + 2}
              value={texts[section.key] ?? section.text}
              onChange={(event) => {
                setTexts((current) => ({ ...current, [section.key]: event.target.value }));
                setSaved(false);
              }}
            />
          )}
        </div>
      ))}

      {signed || !canWrite ? null : (
        <div className="row">
          <button type="button" onClick={() => void save()} disabled={busy || changed.length === 0}>
            {edit.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="ghost" onClick={() => void recompose()} disabled={busy}>
            Compose again
          </button>

          {canSign ? (
            confirming ? (
              <>
                <button type="button" onClick={() => void put()} disabled={busy}>
                  {sign.isPending ? 'Signing…' : 'Sign it'}
                </button>
                <button type="button" className="ghost" onClick={() => setConfirming(false)}>
                  Not yet
                </button>
              </>
            ) : (
              <button type="button" className="primary" onClick={() => setConfirming(true)}>
                Sign…
              </button>
            )
          ) : null}
        </div>
      )}

      {confirming && !signed ? (
        <p className="small muted">
          Signing writes this summary into the record and makes the PDF the patient reads. It cannot
          be edited afterwards — only corrected, like any other note.
        </p>
      ) : null}
    </>
  );
}
