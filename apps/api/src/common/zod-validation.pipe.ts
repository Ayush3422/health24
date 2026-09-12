import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';

/**
 * Validates a request body against a Zod schema from `@health24/shared`.
 *
 * The same schema validates the form in the browser, so a field the client
 * accepts is a field the server accepts, and the error messages match. Using
 * class-validator instead would mean maintaining two definitions of what a
 * valid phone number is — and they would drift.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors: error.issues.map((issue) => ({
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        });
      }

      throw error;
    }
  }
}

/** Terser at the call site: `@Body(zodBody(loginSchema)) body: LoginInput`. */
export const zodBody = <T>(schema: ZodSchema<T>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
