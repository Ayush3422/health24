/**
 * What a patient reads when their health app asks them to share a visit
 * (sp8-plan.md, T10).
 *
 * This string leaves the building. It is shown in the consent manager's app,
 * it travels with every consent request, and it sits in a list of pending
 * requests that somebody else may glance at. So the rule is narrow and
 * absolute: **a care context display says when the visit was, what kind it
 * was, and where — and nothing about what is wrong with the patient.**
 *
 * A display of "Diabetes follow-up" would be more useful and would tell
 * anyone looking over a shoulder what the patient has. The chief complaint,
 * the diagnosis and the clinician's name are all deliberately absent, and the
 * test beside this file exists to keep them absent.
 */

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const VISIT_KIND: Record<string, string> = {
  outpatient: 'OPD visit',
  inpatient: 'Admission',
  emergency: 'Emergency visit',
  teleconsultation: 'Teleconsultation',
};

export interface CareContextSubject {
  startedAt: Date | string;
  /** The encounter class: outpatient, inpatient, emergency, teleconsultation. */
  class: string;
  hospitalName: string;
}

export function careContextDisplay(visit: CareContextSubject): string {
  const at = visit.startedAt instanceof Date ? visit.startedAt : new Date(visit.startedAt);
  const kind = VISIT_KIND[visit.class] ?? 'Visit';

  // India Standard Time, because the patient reading it is in India and a
  // visit that happened on the twelfth must not read as the eleventh (S4).
  return `${kind}, ${IST_DATE.format(at)} · ${visit.hospitalName}`;
}
