/**
 * Whether synthetic DEMO- terminology may be coded onto a patient record.
 *
 * Demo codes assert nothing clinically — they exist so the product can be
 * shown before licensed NAMASTE and ICD-11 releases are loaded. On a real
 * record they would be a falsified diagnosis, so they are refused in
 * production unless explicitly allowed, and the environment check refuses to
 * start a production server that allows them at all.
 */
export function demoTerminologyAllowed(env: {
  NODE_ENV?: string;
  ALLOW_DEMO_TERMINOLOGY?: string;
}): boolean {
  if (env.ALLOW_DEMO_TERMINOLOGY === 'true') return env.NODE_ENV !== 'production';
  if (env.ALLOW_DEMO_TERMINOLOGY === 'false') return false;

  return env.NODE_ENV !== 'production';
}
