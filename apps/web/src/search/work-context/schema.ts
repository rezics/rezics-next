import * as v from 'valibot';
import { isCalendarDate } from '@rezics/filter';

/** Admission of the native Search projection, independently of generic facts and private controls. */
export const workContextLimits = Object.freeze({
  statements: 3,
  qualifiers: 4,
  labelBytes: 256,
  hitBytes: 16384,
  pageBytes: 262144,
});
export const contextBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const id = v.pipe(v.string(), v.uuid());
const text = v.pipe(v.string(), v.maxLength(256));
const labels = v.pipe(
  v.record(v.pipe(v.string(), v.maxLength(35)), text),
  v.check(
    (value) =>
      Object.keys(value).length <= 1 &&
      Object.values(value).every((label) => new TextEncoder().encode(label).byteLength <= workContextLimits.labelBytes),
  ),
);
const term = v.strictObject({ id: v.pipe(text, v.minLength(1)), labels });
const unavailable = v.strictObject({
  state: v.literal('unavailable'),
  reason: v.picklist(['native', 'limit', 'response_limit']),
});
const states = [
  v.strictObject({ state: v.literal('empty') }),
  v.strictObject({ state: v.literal('withheld') }),
  v.strictObject({ state: v.literal('unsupported') }),
  unavailable,
] as const;
const value = v.variant('state', [
  v.strictObject({ state: v.literal('somevalue') }),
  v.strictObject({ state: v.literal('novalue') }),
  v.strictObject({ state: v.literal('unsupported') }),
  v.variant('kind', [
    v.strictObject({ state: v.literal('value'), kind: v.literal('item'), id, originalId: id, type: term, labels }),
    v.strictObject({ state: v.literal('value'), kind: v.literal('text'), text }),
    v.strictObject({
      state: v.literal('value'),
      kind: v.literal('quantity'),
      amount: v.pipe(text, v.regex(/^[+-](?:0|[1-9]\d*)(?:\.\d+)?$/)),
      unit: text,
    }),
    v.pipe(
      v.strictObject({
        state: v.literal('value'),
        kind: v.literal('time'),
        calendar: v.literal('gregorian'),
        year: v.pipe(v.number(), v.integer()),
        month: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12))),
        day: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(31))),
      }),
      v.check((value) => isCalendarDate(value)),
    ),
  ]),
]);
const qualifier = v.strictObject({ property: term, value });
const statement = v.strictObject({
  statementId: id,
  sourceId: id,
  direction: v.literal('outgoing'),
  property: term,
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  release: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
  rank: v.picklist(['normal', 'preferred']),
  value,
  qualifiers: v.variant('state', [
    ...states,
    v.strictObject({
      state: v.literal('current'),
      items: v.pipe(v.array(qualifier), v.minLength(1), v.maxLength(workContextLimits.qualifiers)),
    }),
  ]),
});
const section = v.variant('state', [
  ...states,
  v.pipe(
    v.strictObject({
      state: v.literal('current'),
      items: v.pipe(v.array(statement), v.minLength(1), v.maxLength(workContextLimits.statements)),
      overflow: v.boolean(),
    }),
    v.check((value) => !value.overflow || value.items.length === workContextLimits.statements),
  ),
]);
export const workContextSchema = v.pipe(
  v.variant('state', [
    unavailable,
    v.strictObject({
      state: v.literal('current'),
      subjectId: id,
      type: term,
      kind: v.picklist(['work', 'release', 'recording']),
      creators: section,
      relations: section,
      dates: section,
    }),
  ]),
  v.check((value) => contextBytes(value) <= workContextLimits.hitBytes),
);
export type WorkContext = v.InferOutput<typeof workContextSchema>;
export type CurrentWorkContext = Extract<WorkContext, { state: 'current' }>;
export type WorkContextSection = CurrentWorkContext['creators'];
export type WorkContextStatement = Extract<WorkContextSection, { state: 'current' }>['items'][number];
export type WorkContextValue = WorkContextStatement['value'];
export type WorkContextTerm = CurrentWorkContext['type'];

/** These are exact released Type identities, never localized label interpretations. */
function contextKind(types: readonly string[]): CurrentWorkContext['kind'] {
  if (types.includes('schema:MusicRecording')) return 'recording';
  return types.some((type) =>
    ['bf:Instance', 'wd:Q20631656', 'rezics:AnimeRelease', 'schema:MusicRelease'].includes(type),
  )
    ? 'release'
    : 'work';
}

export function validWorkContextBinding(
  context: WorkContext,
  subject: { id: string; type: string; types: string[]; creativeWork: boolean },
): boolean {
  if (context.state === 'unavailable') return true;
  if (
    !subject.creativeWork ||
    context.subjectId !== subject.id ||
    context.type.id !== subject.type ||
    context.kind !== contextKind([subject.type, ...subject.types])
  )
    return false;
  const seen = new Set<string>();
  for (const [category, section] of Object.entries({
    creators: context.creators,
    relations: context.relations,
    dates: context.dates,
  })) {
    if (section.state !== 'current') continue;
    for (const statement of section.items) {
      if (statement.sourceId !== subject.id || seen.has(statement.statementId)) return false;
      seen.add(statement.statementId);
      if (statement.value.state === 'value' && statement.value.kind !== (category === 'dates' ? 'time' : 'item'))
        return false;
    }
  }
  return true;
}

/** Sum actual envelopes, including unavailable ones; never drop rows to make a page fit. */
export function workContextPageWithinLimit(contexts: readonly (WorkContext | undefined)[]): boolean {
  return (
    contexts.reduce((total, context) => total + (context === undefined ? 0 : contextBytes(context)), 0) <=
    workContextLimits.pageBytes
  );
}
