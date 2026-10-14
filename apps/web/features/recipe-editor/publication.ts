import type { MainClient } from '../studio/types.ts';
import { problemOf } from '../work-levels-edit/write.ts';
import type { RecipeState } from './model.ts';
import type { PublishOutcome, SaveRefusal } from './saves.ts';

type PublishBody = Extract<Parameters<MainClient['v1']['work-publications']['post']>[0], { operation: 'publish' }>;
export interface RecipePublicationSnapshot {
  busy: boolean;
  revision: string | null;
  failure: SaveRefusal | null;
  status?: number;
  problem?: unknown;
  detail: string | null;
}

/** Publishes the exact saved Structure. A lost response or HTTP 202 retries the same command. */
export function createRecipePublisher({ main, work, actingSubject, recipe }: {
  main: () => MainClient; work: string; actingSubject: string; recipe: () => RecipeState;
}) {
  let snapshot: RecipePublicationSnapshot = { busy: false, revision: null, failure: null, detail: null };
  let retry: { body: PublishBody; key: string } | null = null;
  const listeners = new Set<() => void>();
  const notify = (next: RecipePublicationSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  const fail = (failure: SaveRefusal, status?: number, problem?: unknown, detail: string | null = null): PublishOutcome => {
    notify({ revision: snapshot.revision, busy: false, failure, detail, ...(status !== undefined ? { status } : {}),
      ...(problem !== undefined ? { problem } : {}) });
    return { kind: 'refused', refusal: failure };
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dismiss: () => notify({ busy: false, revision: snapshot.revision, failure: null, detail: null }),
    async publish(): Promise<PublishOutcome> {
      if (snapshot.busy) return { kind: 'refused', refusal: 'unavailable' };
      notify({ revision: snapshot.revision, busy: true, failure: null, detail: null });
      try {
        if (!retry) {
          const state = recipe();
          if (!state.structure || !state.head) return fail('invalid');
          const header = await main().v1.works({ id: work.slice(-36) }).get({ query: { actingSubject } });
          if (header.error) {
            const refusal = problemOf(header.error);
            return fail(refusal.problem === 'stale' ? 'moved' : refusal.problem === 'conflict' ? 'invalid' : refusal.problem, header.error.status,
              header.error.value, refusal.detail);
          }
          if (!header.data || header.data.structurePublicationHead === undefined) return fail('unavailable');
          retry = { key: crypto.randomUUID(), body: { profile: 'work-structure-publication-v1', operation: 'publish',
            work, actingSubject, expectedWorkHead: header.data.revision, expectedMainVersion: header.data.mainVersion,
            structure: state.structure, expectedStructureHead: state.head,
            expectedPublicationHead: header.data.structurePublicationHead,
            disclosure: 'public', rightsBasis: 'original-contribution' } };
        }
        const response = await main().v1['work-publications'].post(retry.body,
          { headers: { 'idempotency-key': retry.key } });
        if (response.error) {
          const refusal = problemOf(response.error);
          // A definitive refusal ends that command. Transport loss and pending retain its intent/key.
          if (response.error.status < 500) retry = null;
          return fail(refusal.problem === 'stale' ? 'moved' : refusal.problem === 'conflict' ? 'invalid' : refusal.problem, response.error.status,
            response.error.value, refusal.detail);
        }
        if (response.status === 202) return fail('pending', 202);
        if (!response.data || !('publicationDecision' in response.data)) return fail('unavailable');
        const revision = retry.body.expectedStructureHead;
        if (response.data.work !== work || response.data.structure !== retry.body.structure
          || response.data.structureRevision !== revision) return fail('unavailable');
        retry = null;
        notify({ busy: false, revision, failure: null, detail: null });
        return { kind: 'published' };
      } catch { return fail('unavailable'); }
    },
  };
}
