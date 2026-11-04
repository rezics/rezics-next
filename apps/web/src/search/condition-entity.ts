import { FILTER_LIMITS } from '@rezics/filter';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { hitYear, localizedLabel } from './results';
import { parseSuggestionPage } from './header-search/suggestion-page';
import { searchResourceScopeClause, type SearchResourceScope } from './advanced-scope';
import { validSuggestionText } from './typeahead';

const entityId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resolutionConcurrency = 4;

export type ConditionEntityContext = Readonly<{
  locale: string;
  languages?: readonly string[];
  workContext?: boolean;
  reader?: string;
  release?: string;
  resourceScope?: SearchResourceScope;
  available: boolean;
}>;

export type ConditionEntityFailure = 'unavailable' | 'restart' | 'credentials' | 'invalid' | 'metadata' | 'preparing';

export class ConditionEntityLookupError extends Error {
  constructor(readonly failure: ConditionEntityFailure) {
    super(`Condition entity lookup ${failure}`);
    this.name = 'ConditionEntityLookupError';
  }
}

export type ResolvedConditionEntity = Readonly<{ label: string; type: string }>;
export type ConditionEntityLabelResult = Readonly<{
  labels: Record<string, ResolvedConditionEntity>;
  withheld: readonly string[];
}>;

function identifier(value: string): string | undefined {
  return entityId.test(value) ? value.toLowerCase() : undefined;
}

export function isConditionEntityIdentifier(value: string): boolean {
  return identifier(value) !== undefined;
}

/** Only released target types and the already selected native Search scope enter the suggestion predicate. */
export function conditionEntityFilter(targets: readonly string[], scope?: SearchResourceScope): string {
  const admittedTargets = [...new Set(targets.filter((target) => typeof target === 'string' && target.length > 0))];
  if (admittedTargets.length === 0 || admittedTargets.length > FILTER_LIMITS.in)
    throw new ConditionEntityLookupError('metadata');
  const clauses: Record<string, unknown>[] = [{ type: { in: admittedTargets } }];
  if (scope) {
    try {
      clauses.push(searchResourceScopeClause(scope));
    } catch {
      throw new ConditionEntityLookupError('unavailable');
    }
  }
  return JSON.stringify(clauses.length === 1 ? clauses[0] : { and: clauses });
}

/** A chooser value always comes from a native result's identity, never from its typed query text. */
export function appendConditionEntity(values: readonly string[], selectedId: string): string[] {
  const selected = identifier(selectedId);
  if (!selected) throw new ConditionEntityLookupError('invalid');
  if (values.some((value) => identifier(value) === selected)) return [...values];
  const empty = values.findIndex((value) => value === '' || !identifier(value));
  if (empty < 0) return [...values, selectedId];
  return values.map((value, index) => (index === empty ? selectedId : value));
}

export function conditionEntityRequestIdentity(
  occurrence: string,
  property: string,
  targets: readonly string[],
  context: ConditionEntityContext,
): string {
  return JSON.stringify([
    occurrence,
    property,
    targets,
    context.locale,
    context.languages,
    context.workContext,
    context.reader ?? 'anonymous',
    context.release ?? '',
    context.resourceScope?.kind ?? '',
    context.resourceScope?.id ?? '',
    context.available,
  ]);
}

function suggestionUrl(query: string, propertyTargets: readonly string[], context: ConditionEntityContext): string {
  if (!context.available) throw new ConditionEntityLookupError('unavailable');
  if (!validSuggestionText(query)) throw new ConditionEntityLookupError('invalid');
  const params = new URLSearchParams({
    q: query,
    limit: '10',
    locale: context.locale,
    filter: conditionEntityFilter(propertyTargets, context.resourceScope),
  });
  for (const language of context.languages ?? []) params.append('language', language);
  if (context.release) params.set('release', context.release);
  return `/api/search/suggestions?${params.toString()}`;
}

function entityUrl(id: string, propertyTargets: readonly string[], context: ConditionEntityContext): string {
  if (!context.available) throw new ConditionEntityLookupError('unavailable');
  const params = new URLSearchParams({
    id,
    locale: context.locale,
    filter: conditionEntityFilter(propertyTargets, context.resourceScope),
  });
  for (const language of context.languages ?? []) params.append('language', language);
  if (context.release) params.set('release', context.release);
  return `/api/search/suggestions?${params.toString()}`;
}

async function readConditionEntityPage(
  query: string,
  targets: readonly string[],
  context: ConditionEntityContext,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(suggestionUrl(query, targets, context), {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ConditionEntityLookupError('unavailable');
  }
  signal.throwIfAborted();
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { code?: unknown } | undefined;
    signal.throwIfAborted();
    if (
      [
        'search_index_not_ready',
        'search_source_not_ready',
        'search_preparing',
        'index_not_ready',
        'source_not_ready',
        'semantic_not_ready',
      ].includes(String(body?.code))
    )
      throw new ConditionEntityLookupError('preparing');
    const failure =
      response.status === 409
        ? 'restart'
        : response.status === 401 || response.status === 403
          ? 'credentials'
          : response.status === 400 || response.status === 422
            ? 'invalid'
            : 'unavailable';
    throw new ConditionEntityLookupError(failure);
  }
  try {
    const page = parseSuggestionPage(await response.json());
    signal.throwIfAborted();
    return page;
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ConditionEntityLookupError('unavailable');
  }
}

function operandLabel(labels: Record<string, string>, context: ConditionEntityContext): string {
  for (const language of context.languages ?? []) {
    const label = labels[language];
    if (label?.trim()) return label;
  }
  return localizedLabel(labels, context.locale).text;
}

/** Return distinct native identities with the current locale's imported label and released type context. */
export async function searchConditionEntities(
  query: string,
  targets: readonly string[],
  context: ConditionEntityContext,
  signal: AbortSignal,
): Promise<EntityPickerSubject[]> {
  const page = await readConditionEntityPage(query, targets, context, signal);
  const labels = new Map<string, number>();
  const labelled = page.subjects.flatMap((subject) => {
    const title = operandLabel(subject.labels, context);
    return title ? [{ subject, title }] : [];
  });
  for (const { title } of labelled) {
    labels.set(title, (labels.get(title) ?? 0) + 1);
  }
  return labelled.map(({ subject, title }) => {
    const types = [...new Set([subject.type, ...(subject.summary?.types ?? [])])];
    const typeLabel = operandLabel(page.types[subject.type] ?? {}, context) || subject.type;
    const work = context.workContext && subject.workContext?.status === 'available' ? subject.workContext : undefined;
    const contextLabel = work
      ? [
          `${work.creator.role.value}: ${work.creator.label.value}`,
          work.relation?.label.value,
          work.relation?.date?.state === 'value' ? work.relation.date.value : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    const titleWithContext = contextLabel ? `${title} · ${contextLabel}` : title;
    return {
      id: subject.id,
      title: labels.get(title)! > 1 ? `${titleWithContext} (${typeLabel}; ${subject.id})` : titleWithContext,
      types,
      typeLabel,
      year: hitYear(subject.facts) ?? null,
      cover: subject.summary?.cover ?? null,
    };
  });
}

async function readConditionEntityLabel(
  id: string,
  targets: readonly string[],
  context: ConditionEntityContext,
  signal: AbortSignal,
): Promise<ResolvedConditionEntity | null> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(entityUrl(id, targets, context), {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ConditionEntityLookupError('unavailable');
  }
  signal.throwIfAborted();
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { code?: unknown } | undefined;
    signal.throwIfAborted();
    if (
      [
        'search_index_not_ready',
        'search_source_not_ready',
        'search_preparing',
        'index_not_ready',
        'source_not_ready',
        'semantic_not_ready',
      ].includes(String(body?.code))
    )
      throw new ConditionEntityLookupError('preparing');
    const failure =
      response.status === 409
        ? 'restart'
        : response.status === 401 || response.status === 403
          ? 'credentials'
          : response.status === 400 || response.status === 422
            ? 'invalid'
            : 'unavailable';
    throw new ConditionEntityLookupError(failure);
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ConditionEntityLookupError('unavailable');
  }
  signal.throwIfAborted();
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ConditionEntityLookupError('unavailable');
  const result = value as Record<string, unknown>;
  if (result.id !== id || (result.state !== 'ready' && result.state !== 'withheld'))
    throw new ConditionEntityLookupError('invalid');
  if (result.state === 'withheld') return null;
  if (
    typeof result.type !== 'string' ||
    result.labels === null ||
    typeof result.labels !== 'object' ||
    Array.isArray(result.labels) ||
    result.typeLabels === null ||
    typeof result.typeLabels !== 'object' ||
    Array.isArray(result.typeLabels)
  )
    throw new ConditionEntityLookupError('unavailable');
  const labels = Object.fromEntries(
    Object.entries(result.labels as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const typeLabels = Object.fromEntries(
    Object.entries(result.typeLabels as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const label = operandLabel(labels, context);
  if (!label) return null;
  return {
    label,
    type: operandLabel(typeLabels, context) || result.type,
  };
}

function uniqueResolvableIds(values: readonly string[]): string[] {
  const ids = new Map<string, string>();
  for (const value of values) {
    const key = identifier(value);
    if (key && !ids.has(key)) ids.set(key, value);
    if (ids.size === FILTER_LIMITS.in) break;
  }
  return [...ids.values()];
}

function linkedSignal(parent: AbortSignal, controller: AbortController): () => void {
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  return () => parent.removeEventListener('abort', abort);
}

/** Resolve only admitted UUID operands, with at most four current reads in flight and no name-based substitution. */
export async function resolveConditionEntityLabels(
  values: readonly string[],
  targets: readonly string[],
  context: ConditionEntityContext,
  signal: AbortSignal,
): Promise<ConditionEntityLabelResult> {
  const ids = uniqueResolvableIds(values);
  if (!ids.length) return { labels: {}, withheld: [] };
  if (!context.available) throw new ConditionEntityLookupError('unavailable');
  const controller = new AbortController();
  const unlink = linkedSignal(signal, controller);
  const labels: Record<string, ResolvedConditionEntity> = {};
  const withheld: string[] = [];
  let next = 0;
  let failure: unknown;

  const readOne = async (id: string) => {
    const entity = await readConditionEntityLabel(id, targets, context, controller.signal);
    if (entity) labels[id.toLowerCase()] = entity;
    else withheld.push(id.toLowerCase());
  };

  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = next++;
      const id = ids[index];
      if (id === undefined) return;
      try {
        await readOne(id);
      } catch (error) {
        if (!failure && !signal.aborted) {
          failure = error;
          controller.abort(error);
        }
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(resolutionConcurrency, ids.length) }, worker));
    signal.throwIfAborted();
    if (failure) throw failure;
    return { labels, withheld };
  } finally {
    unlink();
    controller.abort();
  }
}
