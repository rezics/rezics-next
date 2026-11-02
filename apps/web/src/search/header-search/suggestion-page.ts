import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { SuggestionResult } from '../suggestions';

type NativeSuggestionPage = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;

const id = v.pipe(v.string(), v.uuid());
const textMap = v.record(v.string(), v.string());
const positiveInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const cover = v.nullable(
  v.strictObject({
    media: id,
    width: positiveInteger,
    height: positiveInteger,
    placeholder: v.strictObject({ thumbhash: v.string(), color: v.string() }),
    variants: v.array(v.strictObject({ format: v.picklist(['avif', 'webp']), width: positiveInteger })),
    focalPoint: v.nullable(v.strictObject({ x: v.pipe(v.number(), v.finite()), y: v.pipe(v.number(), v.finite()) })),
    credit: v.strictObject({
      rightsHolder: v.string(),
      via: v.strictObject({ name: v.string(), url: v.string() }),
      license: v.string(),
      obligations: v.array(v.string()),
    }),
  }),
);
const summary: v.GenericSchema<NonNullable<NativeSuggestionPage['subjects'][number]['summary']>> = v.strictObject({
  id,
  type: v.string(),
  types: v.array(v.string()),
  label: v.nullable(v.strictObject({ value: v.string(), language: v.string() })),
  creativeWork: v.boolean(),
  cover,
});
const fact = v.variant('kind', [
  v.strictObject({ kind: v.literal('item'), id, labels: textMap }),
  v.strictObject({ kind: v.literal('time'), year: v.pipe(v.number(), v.integer()) }),
  v.strictObject({ kind: v.literal('quantity'), amount: v.pipe(v.number(), v.finite()), unit: v.string() }),
  v.strictObject({ kind: v.literal('code'), value: v.string() }),
]);
const subject: v.GenericSchema<SuggestionResult['subjects'][number]> = v.strictObject({
  id,
  type: v.string(),
  labels: textMap,
  summary: v.nullable(summary),
  facts: v.exactOptional(v.record(v.string(), v.pipe(v.array(fact), v.maxLength(3)))),
});
const suggestionPage: v.GenericSchema<SuggestionResult> = v.strictObject({
  subjects: v.pipe(v.array(subject), v.maxLength(10)),
  as_of: v.pipe(v.string(), v.isoTimestamp()),
  types: v.record(v.string(), textMap),
});

/** Validate the complete native page before the header can render a row from it. */
export function parseSuggestionPage(value: unknown): SuggestionResult {
  const parsed = v.safeParse(suggestionPage, value);
  if (!parsed.success) throw new TypeError('Malformed suggestion page');
  const identities = new Set<string>();
  for (const subject of parsed.output.subjects) {
    const identity = subject.id.toLowerCase();
    if (
      identities.has(identity) ||
      (subject.summary !== null &&
        (subject.summary.id.toLowerCase() !== identity || subject.summary.type !== subject.type))
    ) {
      throw new TypeError('Malformed suggestion page');
    }
    identities.add(identity);
  }
  return parsed.output;
}
