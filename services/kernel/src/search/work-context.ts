import { t } from 'elysia';
import type { Static } from 'typebox';
import { isCalendarDate } from '@rezics/filter';

/** Bounds include the disclosed lookahead; no continuation or Subject URL is inferred. */
export const WORK_CONTEXT_LIMITS = Object.freeze({
  entries: 3,
  lookahead: 4,
  qualifiers: 4,
  labelBytes: 256,
  hitBytes: 16384,
  pageBytes: 262144,
});
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const text = t.String({ maxLength: 256 });
const labels = t.Record(t.String({ maxLength: 35 }), text, { maxProperties: 1 });
const term = t.Object({ id: t.String({ minLength: 1, maxLength: 256 }), labels }, closed);
const nonValue = [
  t.Object({ state: t.Literal('somevalue') }, closed),
  t.Object({ state: t.Literal('novalue') }, closed),
  t.Object({ state: t.Literal('unsupported') }, closed),
] as const;
const value = t.Union([
  ...nonValue,
  t.Object({ state: t.Literal('value'), kind: t.Literal('item'), id, originalId: id, type: term, labels }, closed),
  t.Object({ state: t.Literal('value'), kind: t.Literal('text'), text }, closed),
  t.Object({ state: t.Literal('value'), kind: t.Literal('quantity'), amount: text, unit: text }, closed),
  t.Object(
    {
      state: t.Literal('value'),
      kind: t.Literal('time'),
      calendar: t.Literal('gregorian'),
      year: t.Integer(),
      month: t.Optional(t.Integer({ minimum: 1, maximum: 12 })),
      day: t.Optional(t.Integer({ minimum: 1, maximum: 31 })),
    },
    closed,
  ),
]);
const unavailable = t.Object(
  {
    state: t.Literal('unavailable'),
    reason: t.Union([t.Literal('native'), t.Literal('limit'), t.Literal('response_limit')]),
  },
  closed,
);
const states = [
  t.Object({ state: t.Literal('empty') }, closed),
  t.Object({ state: t.Literal('withheld') }, closed),
  t.Object({ state: t.Literal('unsupported') }, closed),
  unavailable,
] as const;
const qualifier = t.Object({ property: term, value }, closed);
const qualifiers = t.Union([
  ...states,
  t.Object({ state: t.Literal('current'), items: t.Array(qualifier, { minItems: 1, maxItems: 4 }) }, closed),
]);
const statement = t.Object(
  {
    statementId: id,
    sourceId: id,
    direction: t.Literal('outgoing'),
    property: term,
    revision: t.Integer({ minimum: 1 }),
    release: t.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    rank: t.Union([t.Literal('normal'), t.Literal('preferred')]),
    value,
    qualifiers,
  },
  closed,
);
const section = t.Union([
  ...states,
  t.Object(
    { state: t.Literal('current'), items: t.Array(statement, { minItems: 1, maxItems: 3 }), overflow: t.Boolean() },
    closed,
  ),
]);
export const WorkContextSchema = t.Union([
  unavailable,
  t.Object(
    {
      state: t.Literal('current'),
      subjectId: id,
      type: term,
      kind: t.Union([t.Literal('work'), t.Literal('release'), t.Literal('recording')]),
      creators: section,
      relations: section,
      dates: section,
    },
    closed,
  ),
]);
export type WorkContext = Static<typeof WorkContextSchema>;
export type CurrentWorkContext = Extract<WorkContext, { state: 'current' }>;
export type WorkContextSection = CurrentWorkContext['creators'];
export type WorkContextStatement = Extract<WorkContextSection, { state: 'current' }>['items'][number];
export type WorkContextValue = WorkContextStatement['value'];
export type WorkContextQualifier = Extract<WorkContextStatement['qualifiers'], { state: 'current' }>['items'][number];

/** Exact released Type identities and bases own this distinction. */
export function workContextKind(identities: readonly string[]): CurrentWorkContext['kind'] {
  if (identities.includes('schema:MusicRecording')) return 'recording';
  return identities.some((id) =>
    ['bf:Instance', 'wd:Q20631656', 'rezics:AnimeRelease', 'schema:MusicRelease'].includes(id),
  )
    ? 'release'
    : 'work';
}

export const workContextBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Schema validation runs first; these checks bind qualifications, precision and aggregate bytes. */
export function validWorkContext(context: WorkContext, subjectId: string): boolean {
  if (workContextBytes(context) > WORK_CONTEXT_LIMITS.hitBytes) return false;
  if (context.state !== 'current') return true;
  if (context.subjectId !== subjectId) return false;
  const boundedLabels = (values: Record<string, string>) =>
    Object.values(values).every(
      (value) => new TextEncoder().encode(value).byteLength <= WORK_CONTEXT_LIMITS.labelBytes,
    );
  const validValue = (value: WorkContextValue) => {
    if (value.state !== 'value') return true;
    if (value.kind === 'item') return boundedLabels(value.labels) && boundedLabels(value.type.labels);
    if (value.kind === 'time') {
      const { year, month, day } = value;
      return isCalendarDate({ year, ...(month === undefined ? {} : { month }), ...(day === undefined ? {} : { day }) });
    }
    return value.kind !== 'quantity' || /^[+-](?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.amount);
  };
  if (!boundedLabels(context.type.labels)) return false;
  const identities = new Set<string>();
  for (const [group, section] of Object.entries({
    creators: context.creators,
    relations: context.relations,
    dates: context.dates,
  })) {
    if (section.state !== 'current') continue;
    if (section.overflow && section.items.length !== WORK_CONTEXT_LIMITS.entries) return false;
    for (const entry of section.items) {
      if (entry.sourceId !== subjectId || identities.has(entry.statementId)) return false;
      identities.add(entry.statementId);
      if (entry.value.state === 'value' && entry.value.kind !== (group === 'dates' ? 'time' : 'item')) return false;
      if (!validValue(entry.value) || !boundedLabels(entry.property.labels)) return false;
      if (entry.qualifiers.state === 'current')
        for (const qualifier of entry.qualifiers.items)
          if (!validValue(qualifier.value) || !boundedLabels(qualifier.property.labels)) return false;
    }
  }
  return true;
}

/** Every retained context is independently bounded; the page has a separate finite byte allowance. */
export function boundWorkContexts(contexts: readonly (WorkContext | undefined)[]): (WorkContext | undefined)[] {
  const fallback: WorkContext = { state: 'unavailable', reason: 'response_limit' };
  const reserve = workContextBytes(fallback);
  let bytes = contexts.filter((context) => context !== undefined).length * reserve;
  return contexts.map((context) => {
    if (context === undefined) return undefined;
    const size = workContextBytes(context);
    if (size > WORK_CONTEXT_LIMITS.hitBytes || bytes + size - reserve > WORK_CONTEXT_LIMITS.pageBytes)
      return { ...fallback };
    bytes += size - reserve;
    return context;
  });
}
