import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PublicFilterNativeSource } from '../semantic/public-filter-source-binding.ts';
import type { PublicFilterCost, PublicFilterSource } from '../semantic/public-filter-source-contract.ts';
import { createPublicFilterConsumerOperations } from './public-filter-consumer.ts';
import { createPublicFilterCustody } from './public-filter-custody.ts';
import type {
  PublicFilterConsumerCapture,
  PublicFilterConsumerContext,
  PublicFilterConsumerOperationsFactory,
  PublicFilterConsumerQuery,
  PublicFilterConsumerRefill,
  PublicFilterConsumerStatus,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
  PublicSuggestionCaptureInput,
  PublicSuggestionQuery,
} from './public-filter-consumer-contract.ts';
import { validatePublicSuggestionInput, compilePublicSuggestion } from './public-suggestion-input.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { admitSuggestPayload } from './query-payload.ts';
import type { SubjectHit } from './query.ts';

export type { PublicSuggestionCaptureInput, PublicSuggestionQuery } from './public-filter-consumer-contract.ts';
export interface PublicSuggestionOperations {
  capture(
    request: PublicSuggestionCaptureInput,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture>;
  query(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext): Promise<PublicSuggestionQuery>;
  /** Scoped callers use the shared retained-window iterator; the public Global path keeps its original query. */
  queryScoped(
    queried: PublicFilterQueriedObservation,
    context: PublicFilterConsumerContext,
    refill?: PublicFilterConsumerRefill,
  ): Promise<PublicFilterConsumerQuery>;
  readStatus(
    request: Readonly<{ queried: PublicFilterQueriedObservation; execution?: string }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerStatus>;
  closeObservation(queried: PublicFilterQueriedObservation, context: PublicFilterConsumerContext): Promise<void>;
  close(): Promise<void>;
}
const emptyCost = (): PublicFilterCost => ({
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
});
function nativeSource(source: PublicFilterSource): source is PublicFilterNativeSource {
  return 'resolvePublicFilterDefinition' in source && typeof source.resolvePublicFilterDefinition === 'function';
}

/** Prefix uses the ordinary capture registry, native Source binding and execution custody.
 * The factory cannot turn an absent binding into an empty successful suggestion response.
 */
export async function createPublicSuggestionOperations(
  config: Parameters<PublicFilterConsumerOperationsFactory>[0],
): Promise<PublicSuggestionOperations> {
  const operations = await createPublicFilterConsumerOperations(config);
  const custody = createPublicFilterCustody(config.pool);
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  function track<T>(run: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('Public suggestion operations are closed'));
    const promise = run();
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }
  return {
    capture(request, incoming) {
      const context = { deadline: incoming.deadline };
      validatePublicSuggestionInput(request);
      // Copy before asynchronous native admission; no subsequent caller mutation changes the plan.
      const plan = structuredClone(request);
      return track(() => operations.capture({ plan, snapshot: 'pit' }, context));
    },
    query(input, incoming) {
      const queried = structuredClone(input);
      const context = { deadline: incoming.deadline };
      return track(async () => {
        const cost: { -readonly [Key in keyof PublicFilterCost]: number } = emptyCost();
        const add = (next: PublicFilterCost) => {
          cost.inputKeys += next.inputKeys;
          cost.candidates += next.candidates;
          cost.accessPoints += next.accessPoints;
          cost.dependencyPoints += next.dependencyPoints;
          cost.engineSearches += next.engineSearches;
          cost.engineIteratorSteps += next.engineIteratorSteps;
          cost.outputSlots += next.outputSlots;
          cost.resultWrites += next.resultWrites;
          cost.frontierWrites += next.frontierWrites;
        };
        const unavailable = (reason: PublicFilterConsumerUnavailable['reason']): PublicFilterConsumerUnavailable => ({
          status: 'unavailable',
          reason,
          cost,
        });
        const preparing = (): PublicSuggestionQuery => ({ status: 'preparing', queried, cost });
        if (context.deadline <= Date.now()) return unavailable('deadline');
        if (!nativeSource(config.source)) return unavailable('source_pending');
        const acquired = await custody.acquire(queried, context);
        add(acquired.cost);
        if (acquired.status !== 'acquired') return unavailable('observation_lost');
        try {
          const retained = await custody.read({ queried }, context);
          add(retained.cost);
          if (retained.status !== 'found') return unavailable('observation_lost');
          const plan = retained.definition.capture;
          if (!('purpose' in plan)) return unavailable('registration_missing');
          validatePublicSuggestionInput(plan);
          if (queried.snapshot.kind !== 'pit') return unavailable('observation_lost');
          if (
            queried.consumer.physicalTarget !== config.physicalTarget ||
            retained.definition.meaning.digest !== config.meaning.digest
          )
            return unavailable('incarnation_changed');
          // Method presence grants nothing: resolve the actual current native binding and compare it
          // with the immutable custody definition before using this PIT.
          const binding = await config.source.resolvePublicFilterDefinition(
            { meaning: config.meaning, capture: plan },
            context,
          );
          add(binding.cost);
          if (binding.status !== 'bound') return unavailable('source_pending');
          if (
            !isDeepStrictEqual(binding.definition.source, retained.definition.source) ||
            binding.definition.readDefinition !== retained.definition.readDefinition ||
            !isDeepStrictEqual(binding.definition.capture, plan) ||
            !isDeepStrictEqual(binding.definition.dependencyKeys, retained.definition.dependencyKeys)
          )
            return unavailable('registration_missing');
          const started = await config.source.readPrivacyReductionHeads(
            { kind: 'queried', phase: 'start', queried },
            context,
          );
          add(started.cost);
          if (started.status !== 'observed') return unavailable('source_pending');
          if (!started.routingComplete || started.blocking.length) return preparing();
          const match = /^(.*)subjects-g([1-9][0-9]*)$/.exec(config.physicalTarget);
          if (!match) return unavailable('incarnation_changed');
          const prefix = match[1]!;
          const generation = Number(match[2]);
          if (!Number.isSafeInteger(generation) || (plan.generation !== undefined && plan.generation !== generation))
            return unavailable('incarnation_changed');
          async function sameIncarnation(): Promise<boolean> {
            if (context.deadline <= Date.now()) return false;
            const response = await config.search.request<Record<string, { settings?: { index?: { uuid?: string } } }>>(
              'GET',
              `/${config.physicalTarget}/_settings`,
              undefined,
              { timeoutMs: Math.max(1, context.deadline - Date.now()) },
            );
            add({ ...emptyCost(), engineSearches: 1 });
            return (
              response.status === 200 &&
              Object.keys(response.body).length === 1 &&
              response.body[config.physicalTarget]?.settings?.index?.uuid === queried.consumer.incarnation
            );
          }
          if (!(await sameIncarnation())) return unavailable('incarnation_changed');
          if (context.deadline <= Date.now()) return unavailable('deadline');
          const response = await config.search.request<{
            pit_id?: string;
            hits: {
              hits: { _id: string; _index: string; _source: { partition: number; security_revision: number } }[];
            };
          }>(
            'POST',
            '/_search/template',
            {
              id: `${prefix}subjects-suggest-v2`,
              params: { query: compilePublicSuggestion(plan), size: plan.size, pit: queried.snapshot.pit },
            },
            { query: { allow_partial_search_results: false }, timeoutMs: Math.max(1, context.deadline - Date.now()) },
          );
          add({ ...emptyCost(), engineSearches: 1 });
          // A changed native PIT locator is an owned resource even when the response cannot be used.
          // This port never substitutes an unretained successor into an immutable observation.
          if (typeof response.body?.pit_id === 'string' && response.body.pit_id !== queried.snapshot.pit) {
            await config.search.request(
              'DELETE',
              '/_search/point_in_time',
              { pit_id: [response.body.pit_id] },
              {
                timeoutMs: Math.max(1, context.deadline - Date.now()),
              },
            );
            add({ ...emptyCost(), engineSearches: 1 });
            return unavailable('observation_lost');
          }
          assertCompleteSearch(response.body);
          admitSuggestPayload(response.body, plan.size, prefix, generation);
          if (response.body.pit_id !== undefined && response.body.pit_id !== queried.snapshot.pit)
            return unavailable('observation_lost');
          const hits: SubjectHit[] = response.body.hits.hits.map((hit) => ({
            id: hit._id,
            index: hit._index,
            partition: hit._source.partition,
            securityRevision: hit._source.security_revision,
          }));
          add({ ...emptyCost(), candidates: hits.length, outputSlots: hits.length });
          if (new Set(hits.map((hit) => hit.id)).size !== hits.length) return unavailable('observation_lost');
          const ownRows: { original: string; terminal: string }[] = [];
          for (const hit of hits) {
            if (context.deadline <= Date.now()) return unavailable('deadline');
            const remaining = 1000 - cost.inputKeys;
            if (remaining < 1) return preparing();
            const page = await config.source.readPublicFilterProjectionPage({
              subject: hit.id,
              meaning: config.meaning,
              inputLimit: remaining,
              frontier: null,
              context,
            });
            add(page.cost);
            if (cost.inputKeys > 1000 || page.status !== 'complete') return preparing();
            if (
              page.source.subject !== hit.id ||
              page.source.partition !== hit.partition ||
              page.source.securityRevision !== String(hit.securityRevision) ||
              page.source.currentRelease !== config.meaning.digest
            )
              return preparing();
            ownRows.push({ original: hit.id, terminal: page.source.terminal });
          }
          const execution = randomUUID();
          const appended = await custody.appendExecution(
            {
              use: acquired.use,
              execution: { id: execution, start: started.start, ownRows },
            },
            context,
          );
          add(appended.cost);
          if (appended.status !== 'appended') return unavailable('observation_lost');
          const final = await config.source.readPrivacyReductionHeads(
            { kind: 'queried', phase: 'final', queried, execution },
            context,
          );
          add(final.cost);
          if (final.status !== 'observed') return unavailable('source_pending');
          if (!final.routingComplete || final.blocking.length) return preparing();
          if (!(await sameIncarnation())) return unavailable('incarnation_changed');
          return { status: 'queried', queried, execution, start: started.start, result: hits, cost };
        } finally {
          const released = await custody.release(acquired.use, context);
          add(released.cost);
        }
      });
    },
    queryScoped(input, incoming, refill) {
      const queried = structuredClone(input);
      const context = { deadline: incoming.deadline };
      return track(() => operations.query(queried, context, refill));
    },
    readStatus(request, context) {
      return track(() => operations.readStatus(request, context));
    },
    closeObservation(queried, context) {
      return track(() => operations.closeObservation(queried, context));
    },
    close() {
      if (closing) return closing;
      closed = true;
      return (closing = (async () => {
        await Promise.allSettled([...pending]);
        try {
          await operations.close();
        } finally {
          await custody.close();
        }
      })());
    },
  };
}
