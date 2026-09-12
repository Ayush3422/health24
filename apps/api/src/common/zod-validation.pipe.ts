import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Validates a request against a Zod schema from `@health24/shared`.
 *
 * The same schema validates the form in the browser, so a field the client
 * accepts is a field the server accepts, and the error messages match. Using
 * class-validator instead would mean maintaining two definitions of what a
 * valid phone number is — and they would drift.
 *
 * Note `safeParse` rather than `parse` inside a try/catch. Catching and then
 * testing `instanceof ZodError` looks equivalent and is not: when the schema
 * comes from one module realm and the pipe from another — which happens as
 * soon as a package is loaded as CommonJS alongside ESM — the two `ZodError`
 * classes are different objects, the check fails, and a validation error
 * escapes as a 500 instead of a 400. `safeParse` returns the failure as a
 * value, so there is no identity to get wrong.
 *
 * This was not theoretical: it surfaced as a 500 in the integration suite on a
 * request the smoke tests reported as a clean 400.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    throw new BadRequestException({
      message: 'Validation failed',
      errors: result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    });
  }
}

/** Terser at the call site: `@Body(zodBody(loginSchema)) body: LoginInput`. */
export const zodBody = <T>(schema: ZodSchema<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
