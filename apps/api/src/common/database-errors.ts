/**
 * Reading what the database actually said (sp7-plan.md, T23).
 *
 * The driver's error is not the error the application sees. Drizzle wraps a
 * failed query in its own error whose message is `Failed query: …`, and hangs
 * the driver's error — the one carrying the constraint name and the policy
 * violation — off `cause`. A newer version of the ORM added that wrapper, and
 * one `String(error).includes(…)` check silently stopped matching: a request
 * that had been refused with a clear 400 began failing with a 500.
 *
 * So nothing here matches on the top-level message. Both helpers walk the whole
 * chain, which is correct whether or not the next release adds another layer.
 */

/** Every error in the chain, outermost first. */
function chain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  let current = error;

  // A bounded walk: a cycle in a cause chain would otherwise hang a request.
  for (let depth = 0; depth < 8 && current; depth += 1) {
    seen.push(current);
    current = (current as { cause?: unknown }).cause;
  }

  return seen;
}

/**
 * The constraint a write violated, from anywhere in the chain.
 *
 * Postgres names its constraints, and this project uses that: a service maps a
 * named constraint to the sentence a person should read, rather than guessing
 * from the message text.
 */
export function violatedConstraint(error: unknown): string | null {
  for (const link of chain(error)) {
    const name = (link as { constraint_name?: string }).constraint_name;
    if (name) return name;
  }

  return null;
}

/**
 * Everything the chain says, as one string to look in.
 *
 * For the cases Postgres does not give a constraint name to — a row-level
 * security policy refusing an insert, for one, which is the database saying
 * "not yours" rather than "malformed".
 */
export function databaseErrorText(error: unknown): string {
  return chain(error)
    .map((link) => {
      if (link instanceof Error) return link.message;
      return typeof link === 'string' ? link : String(link);
    })
    .join(' | ');
}

/** True when the database refused this because a policy did not admit the row. */
export function refusedByPolicy(error: unknown): boolean {
  return /row-level security|violates row-level security policy/i.test(databaseErrorText(error));
}
