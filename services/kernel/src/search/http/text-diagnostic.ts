import { t } from 'elysia';
import { TEXT_DIAGNOSTIC_REASONS, TEXT_LIMITS } from '../../../../../packages/search-text/src/index.ts';

/** Additive producer input for Content's complete mounted-contract publication. */
export const TextDiagnosticSchema = t.Object(
  {
    reason: t.Union(TEXT_DIAGNOSTIC_REASONS.map((reason) => t.Literal(reason))),
    unit: t.Literal('utf16'),
    start: t.Integer({ minimum: 0, maximum: TEXT_LIMITS.bytes }),
    end: t.Integer({ minimum: 0, maximum: TEXT_LIMITS.bytes + 2 }),
    codePointStart: t.Integer({ minimum: 0, maximum: TEXT_LIMITS.bytes }),
    codePointEnd: t.Integer({ minimum: 0, maximum: TEXT_LIMITS.bytes + 1 }),
    byteOffset: t.Integer({ minimum: 0, maximum: TEXT_LIMITS.bytes }),
  },
  { additionalProperties: false },
);
