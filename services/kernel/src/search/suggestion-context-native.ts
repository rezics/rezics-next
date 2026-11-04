import type { Release } from '@rezics/definitions';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { activeRelease } from '../semantic/definitions.ts';
import { readListPresentationFacts } from '../semantic/list-presentation.ts';
import type { Access, Actor } from '../request/access.ts';
import { workContextKind, validWorkContext, type WorkContext, type WorkContextStatement } from './work-context.ts';
import type {
  SuggestionContextDate,
  SuggestionContextLabel,
  SuggestionWorkContext,
  SuggestionWorkContextReader,
} from './suggestion-context.ts';

type AvailableSuggestionContext = Extract<SuggestionWorkContext, { status: 'available' }>;

type NativeWorkRow = { id: string; workContext?: WorkContext } | null;
type NativeWorkProjection = ReadonlyMap<string, NativeWorkRow>;

function unavailable(subjectId: string): SuggestionWorkContext {
  return { subjectId, status: 'unavailable' };
}

function selectedLabel(labels: Record<string, string>): SuggestionContextLabel | undefined {
  const entry = Object.entries(labels)[0];
  return entry &&
    entry[1].trim() &&
    entry[0].length <= 35 &&
    [...entry[1]].length <= 256 &&
    new TextEncoder().encode(entry[1]).byteLength <= 256
    ? { language: entry[0], value: entry[1] }
    : undefined;
}

function dateOf(statement: WorkContextStatement, release: Release): SuggestionContextDate | undefined {
  if (statement.qualifiers.state !== 'current') return undefined;
  for (const qualifier of statement.qualifiers.items) {
    if (release.properties[qualifier.property.id]?.datatype !== 'time') continue;
    if (qualifier.property.id.length > 128) return undefined;
    const { value } = qualifier;
    if (value.state === 'somevalue') return { state: 'unknown', property: qualifier.property.id };
    if (value.state === 'novalue') return { state: 'no_value', property: qualifier.property.id };
    if (value.state === 'unsupported') return { state: 'unavailable', property: qualifier.property.id };
    if (value.kind !== 'time' || value.year < 0 || value.year > 9999)
      return { state: 'unavailable', property: qualifier.property.id };
    const year = String(value.year).padStart(4, '0');
    const month = value.month === undefined ? undefined : String(value.month).padStart(2, '0');
    const day = value.day === undefined ? undefined : String(value.day).padStart(2, '0');
    const precision = day === undefined ? (month === undefined ? 'year' : 'month') : 'day';
    return {
      state: 'value',
      property: qualifier.property.id,
      value: [year, ...(month === undefined ? [] : [month]), ...(day === undefined ? [] : [day])].join('-'),
      precision,
    };
  }
  return undefined;
}

function relationKind(typeId: string, release: Release): 'work' | 'release' | undefined {
  const type = release.types[typeId];
  if (!type) return undefined;
  const identities = [typeId, ...type.bases];
  if (!identities.includes('schema:CreativeWork')) return undefined;
  const kind = workContextKind(identities);
  return kind === 'recording' ? undefined : kind;
}

export function projectNativeSuggestionWorkContext(
  subjectId: string,
  row: NativeWorkRow,
  release: Release,
): SuggestionWorkContext {
  if (!row) throw new ProblemError('search_restart_required');
  if (row.id.toLowerCase() !== subjectId.toLowerCase()) throw new ProblemError('search_restart_required');
  const context = row.workContext;
  if (!context) return { subjectId, status: 'not_applicable' };
  if (!validWorkContext(context, row.id)) throw new ProblemError('index_not_ready');
  if (context.state === 'unavailable') return unavailable(subjectId);

  const creators = context.creators;
  if (creators.state === 'unsupported') return { subjectId, status: 'not_applicable' };
  if (creators.state === 'empty') return { subjectId, status: 'empty' };
  if (creators.state === 'withheld') return { subjectId, status: 'withheld' };
  if (creators.state === 'unavailable') return unavailable(subjectId);

  let selected:
    | { statement: WorkContextStatement; id: string; label: SuggestionContextLabel; role: SuggestionContextLabel }
    | undefined;
  for (const statement of creators.items) {
    if (statement.property.id.length > 128) continue;
    const value = statement.value;
    if (value.state !== 'value' || value.kind !== 'item') continue;
    const label = selectedLabel(value.labels);
    const role = selectedLabel(statement.property.labels);
    if (label && role) {
      selected = { statement, id: value.id, label, role };
      break;
    }
  }
  if (!selected) return unavailable(subjectId);

  let relation: AvailableSuggestionContext['relation'];
  if (context.relations.state === 'current') {
    for (const statement of context.relations.items) {
      const value = statement.value;
      if (value.state !== 'value' || value.kind !== 'item') continue;
      const kind = relationKind(value.type.id, release);
      const label = selectedLabel(value.labels);
      if (!kind || !label) continue;
      const date = dateOf(statement, release);
      relation = { kind, id: value.id, label, ...(date ? { date } : {}) };
      break;
    }
  }

  return {
    subjectId,
    status: 'available',
    creator: {
      id: selected.id,
      label: selected.label,
      property: selected.statement.property.id,
      role: selected.role,
    },
    ...(relation ? { relation } : {}),
    ...(creators.overflow ||
    (context.relations.state === 'current' && context.relations.overflow) ||
    (context.dates.state === 'current' && context.dates.overflow)
      ? { overflow: true }
      : {}),
  };
}

function sameProjection(ids: readonly string[], before: NativeWorkProjection, after: NativeWorkProjection): boolean {
  return ids.every((id) => {
    if (!before.has(id) || !after.has(id)) return false;
    const first = before.get(id);
    const current = after.get(id);
    return !!first && !!current && first.id === current.id && isDeepStrictEqual(first.workContext, current.workContext);
  });
}

/** Request-scoped adapter over the Semantic list projection; no per-hit reads or alternate authority. */
export function createNativeSuggestionWorkContextReader(input: {
  pool: Pool;
  access: Access;
  actor: Actor;
  routeKey: Uint8Array;
}): SuggestionWorkContextReader {
  return async ({ subjectIds, languages, deadline }) => {
    const dependencies = { ...input, deadline };
    const initialRelease = await activeRelease(input.pool);
    if (!initialRelease)
      return {
        contexts: subjectIds.map(unavailable),
        async isCurrent() {
          return true;
        },
      };

    const initial = await readListPresentationFacts(dependencies, subjectIds, { languages, workContext: true });
    const releaseAfterRead = await activeRelease(input.pool);
    if (!releaseAfterRead || releaseAfterRead.digest !== initialRelease.digest)
      throw new ProblemError('search_restart_required');

    const contexts = subjectIds.map((id) => {
      if (!initial.has(id)) throw new ProblemError('index_not_ready');
      return projectNativeSuggestionWorkContext(id, initial.get(id) ?? null, initialRelease.release);
    });

    return {
      contexts,
      async isCurrent() {
        const releaseBeforeCheck = await activeRelease(input.pool);
        if (!releaseBeforeCheck || releaseBeforeCheck.digest !== initialRelease.digest) return false;
        const current = await readListPresentationFacts(dependencies, subjectIds, { languages, workContext: true });
        const releaseAfterCheck = await activeRelease(input.pool);
        return (
          !!releaseAfterCheck &&
          releaseAfterCheck.digest === initialRelease.digest &&
          sameProjection(subjectIds, initial, current)
        );
      },
    };
  };
}
