import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ZodValidationPipe, type InvalidUserIdExceptionPayload } from './zod-validation.pipe.js';

const testSchema = z
  .object({
    userId: z
      .string()
      .trim()
      .min(3)
      .max(8)
      .regex(/^[a-z0-9]+$/),
  })
  .strict();

describe('ZodValidationPipe', () => {
  it('returns the parsed (trimmed) value on success', () => {
    const pipe = new ZodValidationPipe(testSchema);
    expect(pipe.transform({ userId: '  bob123  ' })).toEqual({ userId: 'bob123' });
  });

  it('throws UnprocessableEntityException (422) on failure', () => {
    const pipe = new ZodValidationPipe(testSchema);
    expect(() => pipe.transform({ userId: 'a' })).toThrow(UnprocessableEntityException);
  });

  it('the thrown exception carries outcome INVALID_USER_ID and a non-empty issues array', () => {
    const pipe = new ZodValidationPipe(testSchema);
    try {
      pipe.transform({ userId: 'a' });
      throw new Error('expected transform to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      const payload = (
        err as UnprocessableEntityException
      ).getResponse() as InvalidUserIdExceptionPayload;
      expect(payload.outcome).toBe('INVALID_USER_ID');
      expect(Array.isArray(payload.issues)).toBe(true);
      expect((payload.issues as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('carries the raw unvalidated userId for the filter to sanitize-echo', () => {
    const pipe = new ZodValidationPipe(testSchema);
    try {
      pipe.transform({ userId: '<script>alert(1)</script>' });
      throw new Error('expected transform to throw');
    } catch (err) {
      const payload = (
        err as UnprocessableEntityException
      ).getResponse() as InvalidUserIdExceptionPayload;
      expect(payload.rawUserId).toBe('<script>alert(1)</script>');
    }
  });

  it('rawUserId is empty string when userId is missing or not a string', () => {
    const pipe = new ZodValidationPipe(testSchema);
    for (const bad of [{}, { userId: 123 }, { userId: null }]) {
      try {
        pipe.transform(bad);
        throw new Error('expected transform to throw');
      } catch (err) {
        const payload = (
          err as UnprocessableEntityException
        ).getResponse() as InvalidUserIdExceptionPayload;
        expect(payload.rawUserId).toBe('');
      }
    }
  });

  it('rejects a non-object body without throwing an unrelated error', () => {
    const pipe = new ZodValidationPipe(testSchema);
    expect(() => pipe.transform('not-an-object')).toThrow(UnprocessableEntityException);
    expect(() => pipe.transform(undefined)).toThrow(UnprocessableEntityException);
  });

  it('.strict() schemas reject unknown keys (422, not silently dropped)', () => {
    const pipe = new ZodValidationPipe(testSchema);
    expect(() => pipe.transform({ userId: 'bob123', extra: 1 })).toThrow(
      UnprocessableEntityException,
    );
  });
});
