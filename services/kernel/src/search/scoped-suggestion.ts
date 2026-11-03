import { isDeepStrictEqual } from 'node:util';
import { relationFacetProperty, type FilterDocument, type FilterRelease } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import { checkHits, type FactClause } from './disclosure/check.ts';
import { compileFilter } from './filter.ts';
import type { PublicFilterConsumerContext, PublicFilterQueriedObservation } from './public-filter-consumer-contract.ts';
import { collectRetainedUsefulPage } from './useful-page.ts';
import type { PublicSuggestionOperations } from './public-suggestion.ts';
import type { SearchHit as NativeSearchHit } from './query.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';
import { ScopeWork } from './scope-execution.ts';
import type { PreparedSearchScope } from './scope-source.ts';
import type { createSearchScopeForService } from './service-scope.ts';

type ScopeRuntime = ReturnType<typeof createSearchScopeForService>;
type SuggestedSubject = { id: string; type: string; labels: Record<string, string> };
type SuggestedPage = { subjects: SuggestedSubject[]; as_of: string };

function notReady(): never {
  throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
}

function restart(): never {
  throw new ProblemError('search_restart_required');
}

function scopeReservation(work: ScopeWork, rawKeys: number) {
  const allowance = work.remaining();
  const remaining = allowance.remaining;
  return {
    rawKeys,
    native: {
      points: remaining.nativePoints,
      witnesses: remaining.witnessKeys,
      rows: remaining.nativeRows,
      bytes: remaining.bytes,
      emptySeeks: remaining.emptySeeks,
    },
    allowance,
  };
}

/** Run prefix candidates through the retained public query, then the same current Search predicate and scope readers. */
export async function executeScopedSuggestions(options: {
  operations: PublicSuggestionOperations;
  queried: PublicFilterQueriedObservation;
  context: PublicFilterConsumerContext;
  limit: number;
  generation: number;
  filter: FilterDocument;
  release: FilterRelease;
  source: SubjectSource;
  scope?: ScopeRuntime;
  preparedScope?: PreparedSearchScope;
  scopeWork?: ScopeWork;
  readSource<T>(operation: () => Promise<T>): Promise<T>;
  project(subject: IndexedSubject): SuggestedSubject;
  asOf(): Promise<string>;
  freshGeneration(): Promise<number>;
  releaseIsCurrent(): Promise<boolean>;
  complete?(page: SuggestedPage): Promise<void>;
  prepare?(): Promise<void>;
}): Promise<SuggestedPage> {
  if (options.scope && (!options.preparedScope || !options.scopeWork)) notReady();

  const compiled = options.preparedScope
    ? undefined
    : compileFilter(options.filter, { prefix: 's', relationOverflow: true });
  const clauses = new Map<string, FactClause>(compiled?.leaves.map((leaf) => [leaf.name, leaf]));
  const overflowProperties = [
    ...new Set(compiled?.leaves.flatMap((leaf) => (leaf.facet === 'statement' ? [leaf.property] : []))),
  ];
  const relationProperties = overflowProperties.filter((property) => relationFacetProperty(options.release, property));
  const hitsById = new Map<string, NativeSearchHit>();
  let queried = options.queried;
  let execution: string | undefined;

  const check = async (hits: readonly NativeSearchHit[]): Promise<ReadonlyMap<NativeSearchHit, IndexedSubject>> => {
    const { passed } = await options.readSource(() =>
      checkHits(
        options.source,
        hits,
        clauses,
        options.preparedScope ? undefined : { filter: options.filter, relationProperties },
      ),
    );
    const acceptedById = new Map(passed.map(({ hit, subject }) => [hit.id, subject]));
    const accepted = new Map(
      hits.flatMap((hit) => {
        const subject = acceptedById.get(hit.id);
        return subject ? [[hit, subject] as const] : [];
      }),
    );
    if (!options.scope || !options.preparedScope || !options.scopeWork) return accepted;

    const ids = passed.map(({ subject }) => subject.id);
    const evaluated = await options.readSource(() =>
      options.scope!.evaluate(options.preparedScope!, ids, scopeReservation(options.scopeWork!, ids.length)),
    );
    options.scopeWork.native(options.scope.work(evaluated));
    if (
      evaluated.basis.canonical !== options.preparedScope.basis.canonical ||
      evaluated.values.length !== ids.length ||
      evaluated.progress !== null ||
      evaluated.values.includes('not_proven')
    )
      notReady();
    const acceptedScope = new Set(ids.filter((_, index) => evaluated.values[index] === true));
    return new Map([...accepted].filter(([, subject]) => acceptedScope.has(subject.id)));
  };

  const page = await collectRetainedUsefulPage<IndexedSubject>({
    limit: options.limit,
    read: async (size, continuation) => {
      const result = await options.operations.queryScoped(
        queried,
        options.context,
        continuation ? { ...continuation, size } : undefined,
      );
      if (result.status !== 'queried') {
        if (result.status === 'preparing') await options.prepare?.();
        notReady();
      }
      queried = result.queried;
      execution = result.execution;
      for (const hit of result.result.hits) hitsById.set(hit.id, hit);
      return {
        execution: result.execution,
        hits: result.result.hits,
        window: result.window,
      };
    },
    check,
    canonicalId: (subject) => subject.id,
  });
  if (page.status === 'preparing') {
    await options.prepare?.();
    notReady();
  }

  const response: SuggestedPage = {
    subjects: page.values.map(options.project),
    as_of: await options.asOf(),
  };
  await options.complete?.(response);

  const shownHits = page.values.map((subject) => {
    const hit = hitsById.get(subject.id);
    if (!hit) return restart();
    return hit;
  });
  const current = await check(shownHits);
  for (const [index, hit] of shownHits.entries()) {
    const subject = current.get(hit);
    if (!subject || !isDeepStrictEqual(options.project(subject), response.subjects[index])) restart();
  }
  if (!(await options.releaseIsCurrent())) restart();

  if (!execution) notReady();
  const final = await options.operations.readStatus({ queried, execution }, options.context);
  if (final.status !== 'observed' || final.blocking.length) {
    await options.prepare?.();
    notReady();
  }
  if ((await options.freshGeneration()) !== options.generation) restart();
  return response;
}
