import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';

type NativeSuggestionPage = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;
export type SuggestionWorkContext = NonNullable<NativeSuggestionPage['subjects'][number]['workContext']>;

export const SUGGESTION_CONTEXT_MAX_SERIALIZED_BYTES = 16_384;

const id = v.pipe(v.string(), v.uuid());
const property = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const label = v.strictObject({
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  language: v.pipe(v.string(), v.minLength(1), v.maxLength(35)),
});
const date = v.variant('state', [
  v.strictObject({
    state: v.literal('value'),
    property,
    value: v.pipe(v.string(), v.regex(/^\d{4}$/)),
    precision: v.literal('year'),
  }),
  v.strictObject({
    state: v.literal('value'),
    property,
    value: v.pipe(v.string(), v.regex(/^\d{4}-(0[1-9]|1[0-2])$/)),
    precision: v.literal('month'),
  }),
  v.strictObject({
    state: v.literal('value'),
    property,
    value: v.pipe(v.string(), v.regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)),
    precision: v.literal('day'),
  }),
  v.strictObject({
    state: v.picklist(['unknown', 'no_value', 'withheld', 'unavailable', 'not_applicable']),
    property,
  }),
]);

export const suggestionWorkContextSchema: v.GenericSchema<SuggestionWorkContext> = v.variant('status', [
  v.strictObject({
    subjectId: id,
    status: v.literal('available'),
    creator: v.strictObject({ id, label, property, role: label }),
    relation: v.exactOptional(
      v.strictObject({
        kind: v.picklist(['work', 'release']),
        id,
        label,
        date: v.exactOptional(date),
      }),
    ),
    overflow: v.exactOptional(v.literal(true)),
  }),
  v.strictObject({
    subjectId: id,
    status: v.picklist(['absent', 'not_applicable', 'empty', 'withheld', 'unavailable']),
  }),
]);

function validDatePrecision(value: string, precision: 'year' | 'month' | 'day'): boolean {
  const match = precision === 'year' ? /^(\d{4})$/.exec(value) : /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return false;
  if (precision === 'year') return true;
  if (precision === 'month' && match[3] !== undefined) return false;
  if (precision === 'day' && match[3] === undefined) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  if (precision === 'month') return true;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return Number(match[3]) >= 1 && Number(match[3]) <= days;
}

export function admitSuggestionWorkContexts(
  subjects: readonly { id: string; workContext?: SuggestionWorkContext }[],
): void {
  const contexts = subjects.flatMap(({ workContext }) => (workContext ? [workContext] : []));
  if (new TextEncoder().encode(JSON.stringify(contexts)).length > SUGGESTION_CONTEXT_MAX_SERIALIZED_BYTES)
    throw new TypeError('Malformed suggestion page');
  for (const subject of subjects) {
    if (subject.workContext && subject.workContext.subjectId.toLowerCase() !== subject.id.toLowerCase())
      throw new TypeError('Malformed suggestion page');
    const date = subject.workContext?.status === 'available' ? subject.workContext.relation?.date : undefined;
    if (date?.state === 'value' && !validDatePrecision(date.value, date.precision))
      throw new TypeError('Malformed suggestion page');
  }
}
