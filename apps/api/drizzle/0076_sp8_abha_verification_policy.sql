-- SP8 Phase 7: the hospital the patient walked into may confirm their ABHA
-- (sp8-plan.md, T31).
--
-- Found by the browser tests, which is the point of having them: the patient
-- they drive was registered at one hospital and is being seen at another, and
-- the desk at the second could not verify her ABHA at all.
--
-- The rule they met is SP1's and is older than any of this:
-- `patient_tenant_isolation` lets a hospital *read* a patient it is linked to,
-- and *write* only one it created. That is deliberate for demographics — the
-- hospital that registered somebody owns their name and date of birth, and a
-- second hospital correcting them behind the first's back is how two records
-- of one person quietly diverge.
--
-- Confirming an ABHA is not that. It is done with the patient standing there,
-- by whichever hospital they have walked into, and it writes nothing but the
-- national identifier and the fact that the registry confirmed it.
--
-- So this does not widen the old rule. It adds a second way to satisfy the
-- check, open only while `app.record_abha_verification` is running — the same
-- flag the guard trigger keys on — and only for a hospital the patient is
-- actually linked to. Outside that function the setting is unset, the
-- expression is false, and nothing has changed.

CREATE POLICY patient_abha_verification ON "patient"
  FOR UPDATE
  USING (
    coalesce(current_setting('app.abha_verification', true), 'off') = 'on'
    AND EXISTS (
      SELECT 1 FROM "patient_hospital_link" l
       WHERE l."patient_id" = "patient"."id"
         AND l."hospital_id" = app.current_hospital_id()
    )
  )
  WITH CHECK (
    coalesce(current_setting('app.abha_verification', true), 'off') = 'on'
    AND EXISTS (
      SELECT 1 FROM "patient_hospital_link" l
       WHERE l."patient_id" = "patient"."id"
         AND l."hospital_id" = app.current_hospital_id()
    )
  );
