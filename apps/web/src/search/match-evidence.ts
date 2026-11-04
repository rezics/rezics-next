import * as v from 'valibot';

const span = v.strictObject({
  start: v.pipe(v.number(), v.integer(), v.minValue(0)),
  end: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const reason = v.pipe(
  v.strictObject({
    field: v.picklist(['title', 'alias', 'description']),
    language: v.pipe(v.string(), v.maxLength(35), v.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/)),
    text: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    spans: v.pipe(v.array(span), v.minLength(1), v.maxLength(8)),
  }),
  v.check((value) => {
    if (!value.text.isWellFormed() || new TextEncoder().encode(value.text).byteLength > 256) return false;
    let previous = 0;
    for (const { start, end } of value.spans) {
      if (start < previous || start >= end || end > value.text.length) return false;
      if (
        (start > 0 && /[\uD800-\uDBFF]/.test(value.text[start - 1]!)) ||
        (end < value.text.length && /[\uDC00-\uDFFF]/.test(value.text[end]!))
      )
        return false;
      previous = end;
    }
    return true;
  }),
);

export const matchEvidenceSchema = v.variant('state', [
  v.strictObject({ state: v.literal('absent') }),
  v.strictObject({ state: v.literal('unsupported') }),
  v.strictObject({ state: v.literal('unavailable') }),
  v.pipe(
    v.strictObject({
      state: v.literal('current'),
      source: v.strictObject({
        id: v.pipe(v.string(), v.uuid()),
        revision: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
      }),
      query: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
      reasons: v.pipe(v.array(reason), v.minLength(1), v.maxLength(3)),
    }),
    v.check((value) => {
      const identities = new Set(value.reasons.map((item) => `${item.field}\0${item.language}\0${item.text}`));
      return identities.size === value.reasons.length;
    }),
  ),
]);

export type MatchEvidence = v.InferOutput<typeof matchEvidenceSchema>;

export function currentEvidenceMatches(evidence: MatchEvidence, id: string): boolean {
  return evidence.state !== 'current' || evidence.source.id === id;
}

export function evidencePageWithinLimit(values: readonly MatchEvidence[]): boolean {
  let bytes = 0;
  for (const value of values) {
    bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > 131_072) return false;
  }
  return true;
}
