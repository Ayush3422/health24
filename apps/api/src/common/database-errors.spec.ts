import { describe, expect, it } from 'vitest';
import { databaseErrorText, refusedByPolicy, violatedConstraint } from './database-errors';

/**
 * Reading what the database said, through whatever the ORM wrapped it in
 * (sp7-plan.md, T23).
 *
 * These cases are the shape of a real regression. Upgrading Drizzle from 0.38
 * to 0.45 added a wrapper around every failed query — the message became
 * `Failed query: …` and the driver's own error moved to `cause`. One check that
 * read only the top level stopped matching, and a request that had been refused
 * with a clear 400 started failing with a 500. The integration suite caught it;
 * these tests are what will catch the next wrapper without a database.
 */

/** What the ORM hands a caller: its own error, with the driver's underneath. */
function wrapped(inner: Error & { constraint_name?: string }): Error {
  const outer = new Error('Failed query: insert into "correction_request" …');
  (outer as Error & { cause?: unknown }).cause = inner;
  return outer;
}

function policyRefusal(): Error {
  return new Error(
    'new row violates row-level security policy for table "correction_request"',
  );
}

function constraintFailure(name: string): Error & { constraint_name?: string } {
  const error = new Error(`duplicate key value violates unique constraint "${name}"`) as Error & {
    constraint_name?: string;
  };
  error.constraint_name = name;
  return error;
}

describe('reading a database error', () => {
  describe('the constraint it violated', () => {
    it('finds it on the error itself', () => {
      expect(violatedConstraint(constraintFailure('condition_one_primary_per_encounter'))).toBe(
        'condition_one_primary_per_encounter',
      );
    });

    it('finds it under a wrapper', () => {
      expect(violatedConstraint(wrapped(constraintFailure('invoice_number_unique')))).toBe(
        'invoice_number_unique',
      );
    });

    it('finds it under two wrappers, because there may one day be two', () => {
      expect(violatedConstraint(wrapped(wrapped(constraintFailure('charge_once_per_source'))))).toBe(
        'charge_once_per_source',
      );
    });

    it('says nothing when there is no constraint', () => {
      expect(violatedConstraint(new Error('connection terminated'))).toBeNull();
      expect(violatedConstraint(null)).toBeNull();
      expect(violatedConstraint(undefined)).toBeNull();
    });
  });

  describe('a refusal by a policy', () => {
    it('is recognised on the error itself', () => {
      expect(refusedByPolicy(policyRefusal())).toBe(true);
    });

    it('is recognised under the wrapper the ORM adds', () => {
      // The case that broke: the top-level message says only "Failed query".
      expect(wrapped(policyRefusal()).message).not.toMatch(/row-level security/);
      expect(refusedByPolicy(wrapped(policyRefusal()))).toBe(true);
    });

    it('is not claimed for an ordinary failure', () => {
      expect(refusedByPolicy(wrapped(constraintFailure('some_constraint')))).toBe(false);
      expect(refusedByPolicy(new Error('connection terminated'))).toBe(false);
    });
  });

  describe('the whole chain, as text', () => {
    it('carries every message', () => {
      const text = databaseErrorText(wrapped(policyRefusal()));

      expect(text).toContain('Failed query');
      expect(text).toContain('row-level security');
    });

    it('survives a chain that points at itself', () => {
      const loop = new Error('round and round') as Error & { cause?: unknown };
      loop.cause = loop;

      expect(databaseErrorText(loop)).toContain('round and round');
    });

    it('handles what is not an error at all', () => {
      expect(databaseErrorText('a string')).toBe('a string');
      expect(databaseErrorText(null)).toBe('');
    });
  });
});
