import {
  createReleasedRelationDirectionResolver,
  releaseDigest,
  type Release,
  type ReleasedRelationDirectionResolver,
} from '@rezics/definitions';
import { readNativeCalendarDate } from '@rezics/filter';
import { chooseTexts } from '../search/hits.ts';
import {
  WORK_CONTEXT_LIMITS as limits,
  workContextBytes,
  workContextKind,
  type CurrentWorkContext,
  type WorkContext,
  type WorkContextStatement,
  type WorkContextValue,
} from '../search/work-context.ts';
import type { FactRow } from './item.ts';

export type WorkGroup = 'creators' | 'relations' | 'dates';
export type WorkPlan = { kind: CurrentWorkContext['kind']; creators: string[]; relations: string[]; dates: string[] };
const association = new Set(['order', 'derivation', 'world', 'membership', 'association']);
/** Semantic identities are the released terms, never a label/name heuristic or an inverse inference. */
export function listWorkPlan(
  release: Release,
  typeId: string,
  directionResolver?: ReleasedRelationDirectionResolver,
): WorkPlan | undefined {
  const type = release.types[typeId];
  if (!type) return undefined;
  const resolve = directionResolver ?? createReleasedRelationDirectionResolver(release, releaseDigest(release));
  const identities = [typeId, ...type.bases];
  if (!identities.includes('schema:CreativeWork')) return undefined;
  const kind = workContextKind(identities);
  const properties = type.properties;
  return {
    kind,
    creators: properties.filter(
      (id) =>
        release.properties[id]?.relation?.group === 'credit' &&
        resolve.resolve(typeId, id, 'forward').state === 'admitted',
    ),
    relations: properties.filter(
      (id) =>
        association.has(release.properties[id]?.relation?.group ?? '') &&
        resolve.resolve(typeId, id, 'forward').state === 'admitted',
    ),
    dates: properties.filter((id) => release.properties[id]?.datatype === 'time'),
  };
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
type PendingValue =
  | Exclude<WorkContextValue, { state: 'value'; kind: 'item' }>
  | { state: 'value'; kind: 'item'; id: string };
type PendingStatement = Omit<WorkContextStatement, 'value' | 'qualifiers'> & {
  value: PendingValue;
  qualifiers:
    | { state: 'empty' | 'unsupported' }
    | { state: 'unavailable'; reason: 'limit' }
    | { state: 'current'; items: { property: WorkContextStatement['property']; value: PendingValue }[] };
};
export type WorkDraft = {
  type: CurrentWorkContext['type'];
  kind: CurrentWorkContext['kind'];
  sections: Record<
    WorkGroup,
    | { state: 'empty' | 'withheld' | 'unsupported' }
    | { state: 'unavailable'; reason: 'limit' | 'native' }
    | { state: 'current'; items: PendingStatement[] }
  >;
};

export function workLabels(labels: Record<string, string>, languages: readonly string[] | undefined) {
  return chooseTexts(
    Object.entries(labels).map(([language, value]) => ({ language, value })),
    languages ?? ['en'],
    undefined,
  );
}
function term(release: Release, id: string, languages: readonly string[] | undefined, type = false) {
  return { id, labels: workLabels((type ? release.types[id] : release.properties[id])?.labels ?? {}, languages) };
}
function valueOf(raw: unknown, property: string, release: Release): PendingValue {
  if (!record(raw)) return { state: 'unsupported' };
  if (raw.type === 'somevalue' || raw.type === 'novalue') return { state: raw.type };
  if (raw.type !== 'value') return { state: 'unsupported' };
  const definition = release.properties[property];
  const content = raw.content;
  switch (definition?.datatype) {
    case 'wikibase-item':
      return typeof content === 'string' ? { state: 'value', kind: 'item', id: content } : { state: 'unsupported' };
    case 'time': {
      const date = readNativeCalendarDate(content);
      return date ? { state: 'value', kind: 'time', calendar: 'gregorian', ...date } : { state: 'unsupported' };
    }
    case 'string':
      return typeof content === 'string' && new TextEncoder().encode(content).byteLength <= limits.labelBytes
        ? { state: 'value', kind: 'text', text: content }
        : { state: 'unsupported' };
    case 'quantity':
      return record(content) &&
        typeof content.amount === 'string' &&
        typeof content.unit === 'string' &&
        /^[+-](?:0|[1-9]\d*)(?:\.\d+)?$/.test(content.amount) &&
        content.amount.length <= 256 &&
        content.unit.length <= 256
        ? { state: 'value', kind: 'quantity', amount: content.amount, unit: content.unit }
        : { state: 'unsupported' };
    default:
      return { state: 'unsupported' };
  }
}

/** One originating candidate/revision, including that candidate's own qualifiers and explicit non-values. */
function statementOf(
  id: string,
  fact: FactRow,
  release: Release,
  languages?: readonly string[],
): PendingStatement | null {
  const body = fact.body;
  if (
    !record(body) ||
    !fact.statement_id ||
    !fact.property ||
    !fact.fact_release ||
    !fact.fact_revision ||
    (body.rank !== 'normal' && body.rank !== 'preferred')
  )
    return null;
  const definition = release.properties[fact.property];
  const rawQualifiers = Array.isArray(body.qualifiers) ? body.qualifiers : [];
  const qualifiers: PendingStatement['qualifiers'] =
    rawQualifiers.length > limits.qualifiers
      ? { state: 'unavailable', reason: 'limit' }
      : !rawQualifiers.length
        ? { state: 'empty' }
        : rawQualifiers.some(
              (raw) =>
                !record(raw) || typeof raw.property !== 'string' || !definition?.qualifiers.includes(raw.property),
            )
          ? { state: 'unsupported' }
          : {
              state: 'current',
              items: rawQualifiers.map((raw) => ({
                property: term(release, raw.property, languages),
                value: valueOf(raw.value, raw.property, release),
              })),
            };
  return {
    statementId: fact.statement_id,
    sourceId: id,
    direction: 'outgoing',
    property: term(release, fact.property, languages),
    revision: fact.fact_revision,
    release: fact.fact_release,
    rank: body.rank,
    value: valueOf(body.value, fact.property, release),
    qualifiers,
  };
}

export function prepareListWorkContext(
  id: string,
  type: string,
  release: Release,
  facts: readonly FactRow[],
  withheld: ReadonlySet<string>,
  languages?: readonly string[],
  directionResolver?: ReleasedRelationDirectionResolver,
): WorkDraft | undefined {
  const plan = listWorkPlan(release, type, directionResolver);
  if (!plan) return undefined;
  const sections = Object.fromEntries(
    (['creators', 'relations', 'dates'] as const).map((group) => {
      const properties = plan[group];
      if (!properties.length) return [group, { state: 'unsupported' }];
      if (properties.some((property) => withheld.has(property))) return [group, { state: 'withheld' }];
      const candidates = facts
        .filter(
          (fact) =>
            properties.includes(fact.property!) &&
            record(fact.body) &&
            (fact.body.rank === 'normal' || fact.body.rank === 'preferred'),
        )
        .slice(0, limits.lookahead);
      const items = candidates.map((fact) => statementOf(id, fact, release, languages));
      if (items.some((entry) => entry?.qualifiers.state === 'unavailable'))
        return [group, { state: 'unavailable', reason: 'native' }];
      if (items.some((entry) => !entry)) return [group, { state: 'unavailable', reason: 'limit' }];
      return [group, items.length ? { state: 'current', items } : { state: 'empty' }];
    }),
  ) as WorkDraft['sections'];
  return { type: term(release, type, languages, true), kind: plan.kind, sections };
}
export function listWorkTargets(draft: WorkDraft | undefined): string[] {
  if (!draft) return [];
  const ids: string[] = [];
  const add = (value: PendingValue) => {
    if (value.state === 'value' && value.kind === 'item') ids.push(value.id);
  };
  for (const section of Object.values(draft.sections)) {
    if (section.state !== 'current') continue;
    for (const entry of section.items) {
      add(entry.value);
      if (entry.qualifiers.state === 'current') for (const qualifier of entry.qualifiers.items) add(qualifier.value);
    }
  }
  return ids;
}
export type WorkTarget = { id: string; type: string; labels: Record<string, string> } | { state: 'unavailable' };

/** Denied targets withhold the entire section, including lookahead. No concealed identity or count escapes. */
export function finishListWorkContext(
  id: string,
  draft: WorkDraft | undefined,
  targets: ReadonlyMap<string, WorkTarget | null>,
  release: Release,
  languages?: readonly string[],
): WorkContext | undefined {
  if (!draft) return undefined;
  const fill = (value: PendingValue): WorkContextValue | null | 'unavailable' => {
    if (value.state !== 'value' || value.kind !== 'item') return value;
    const target = targets.get(value.id);
    if (target && 'state' in target) return 'unavailable';
    return target
      ? {
          state: 'value',
          kind: 'item',
          id: target.id,
          originalId: value.id,
          type: term(release, target.type, languages, true),
          labels: workLabels(target.labels, languages),
        }
      : null;
  };
  const sections = Object.fromEntries(
    (['creators', 'relations', 'dates'] as const).map((group) => {
      const section = draft.sections[group];
      if (section.state !== 'current') return [group, section];
      const items: WorkContextStatement[] = [];
      for (const entry of section.items) {
        const value = fill(entry.value);
        if (value === 'unavailable') return [group, { state: 'unavailable', reason: 'native' }];
        if (!value) return [group, { state: 'withheld' }];
        let qualifiers: WorkContextStatement['qualifiers'];
        if (entry.qualifiers.state !== 'current') qualifiers = entry.qualifiers;
        else {
          const items: Extract<WorkContextStatement['qualifiers'], { state: 'current' }>['items'] = [];
          for (const qualifier of entry.qualifiers.items) {
            const value = fill(qualifier.value);
            if (value === 'unavailable') return [group, { state: 'unavailable', reason: 'native' }];
            if (!value) return [group, { state: 'withheld' }];
            items.push({ property: qualifier.property, value });
          }
          qualifiers = { state: 'current', items };
        }
        items.push({ ...entry, value, qualifiers });
      }
      return [
        group,
        { state: 'current', items: items.slice(0, limits.entries), overflow: items.length > limits.entries },
      ];
    }),
  ) as Pick<CurrentWorkContext, WorkGroup>;
  const context: WorkContext = { state: 'current', subjectId: id, type: draft.type, kind: draft.kind, ...sections };
  // Bounds apply to actual UTF-8 serialized bytes, including labels and qualifications.
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (record(value)) Object.values(value).forEach(collect);
  };
  collect(context);
  return strings.some((value) => new TextEncoder().encode(value).byteLength > limits.labelBytes) ||
    workContextBytes(context) > limits.hitBytes
    ? { state: 'unavailable', reason: 'response_limit' }
    : context;
}
