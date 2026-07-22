/**
 * `ZodValidationPipe` — frozen contract §6.7 point 1.
 *
 * Used as `@Body(new ZodValidationPipe(purchaseRequestSchema))` and
 * `@Param(new ZodValidationPipe(purchaseStatusParamsSchema))` (both by
 * `purchase/purchase.controller.ts`, Slice C) — the ONLY two call sites in
 * this app, both `userId`-shaped, which is why a failed parse always throws
 * outcome `'INVALID_USER_ID'` unconditionally: there is no other semantic
 * this pipe is ever asked to express. Nest's built-in `ValidationPipe`
 * (class-validator based, defaults to 400) is NOT used anywhere in this app.
 *
 * On failure this throws `UnprocessableEntityException` (422) carrying
 * `{ outcome: 'INVALID_USER_ID', issues, rawUserId }` — `rawUserId` is the
 * ORIGINAL unvalidated `userId` field (when present and a string), needed by
 * `HttpExceptionFilter` to build the sanitized, truncated echo §10.3
 * requires ("no internal detail leakage... the response's `userId` field
 * echoes the input truncated to `USER_ID_MAX_LENGTH` and with all
 * characters outside `USER_ID_PATTERN` stripped"). `issues` is NEVER placed
 * in a response body (§10.3) — it exists only for the filter to log at
 * `debug`.
 */
import type { PipeTransform } from '@nestjs/common';
import { UnprocessableEntityException } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Never sent to a client verbatim (§10.3) — logged at `debug` only. */
export interface InvalidUserIdExceptionPayload {
  outcome: 'INVALID_USER_ID';
  issues: unknown;
  /** The raw, unvalidated `userId` field from the request, if it was a string. `''` otherwise. */
  rawUserId: string;
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const rawUserId = extractRawUserId(value);
    const payload: InvalidUserIdExceptionPayload = {
      outcome: 'INVALID_USER_ID',
      issues: result.error.issues,
      rawUserId,
    };
    throw new UnprocessableEntityException(payload);
  }
}

function extractRawUserId(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const raw = (value as Record<string, unknown>).userId;
  return typeof raw === 'string' ? raw : '';
}
