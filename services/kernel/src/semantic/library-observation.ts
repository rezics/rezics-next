/** Semantic application for canonical, Follow and shelf observation consumers. */

import type {
  LibrarySemanticObservationCapability,
  LibrarySemanticSummaryObservation,
} from '../library/contract/semantic-observation.ts';
import type { Pool, PoolClient } from 'pg';
import {
  createNativeLibraryObservationAdapter,
  type SemanticObservationNativeAdapter,
} from './adapters/library-observation.ts';

/** Attach each native result to the exact owner declaration for that operation. */
export function createLibraryObservationApplication(
  native: SemanticObservationNativeAdapter = createNativeLibraryObservationAdapter(),
): LibrarySemanticObservationCapability {
  const capability: LibrarySemanticObservationCapability = {
    canonical: {
      ...native.canonical,
      async readMappings(pool, originals) {
        const value = await native.canonical.readMappings(pool as Pool, originals);
        return Object.freeze({ value, work: native.canonical.mappingWork(originals) });
      },
      async commitScopeCapture(client, input) {
        await native.canonical.commitScopeCapture(client as Pick<PoolClient, 'query'>, input);
        return Object.freeze({ value: undefined, work: native.canonical.scopeCommitWork(input) });
      },
    },
    follow: {
      ...native.follow,
      async readMapping(pool, original) {
        const value = await native.follow.readMapping(pool as Pool, original);
        return Object.freeze({ value, work: native.follow.mappingWork([original]) });
      },
      async readMappings(pool, originals) {
        const value = await native.follow.readMappings(pool as Pool, originals);
        return Object.freeze({ value, work: native.follow.mappingWork(originals) });
      },
      async readSubjectReference(input) {
        const value = await native.follow.readSubjectReference(
          input as Parameters<typeof native.follow.readSubjectReference>[0],
        );
        return Object.freeze({ value, work: native.follow.subjectReferenceWork(input.subjectId) });
      },
      async observeSubjects(input) {
        const observed = await native.follow.observeSubjects({
          context: input.context as import('./summaries.ts').SummaryReaderDependencies,
          ids: input.ids,
        });
        const value: LibrarySemanticSummaryObservation = Object.freeze({
          summaries: observed.summaries,
          async current() {
            const current = await observed.current();
            return Object.freeze({ value: current, work: native.follow.subjectSummaryCurrentWork(input.ids) });
          },
        });
        return Object.freeze({ value, work: native.follow.subjectSummaryWork(input.ids) });
      },
    },
    shelf: {
      ...native.shelf,
      async readIdentityVersion(client, subjectId) {
        const value = await native.shelf.readIdentityVersion(client as Pick<PoolClient, 'query'>, subjectId);
        return Object.freeze({ value, work: native.shelf.identityVersionWork(subjectId) });
      },
      async readItemTypes(client, subjectIds, maxTypeBytes) {
        const value = await native.shelf.readItemTypes(client as Pick<PoolClient, 'query'>, subjectIds);
        return Object.freeze({ value, work: native.shelf.itemTypesWork(subjectIds, maxTypeBytes) });
      },
    },
  };
  return Object.freeze({
    canonical: Object.freeze(capability.canonical),
    follow: Object.freeze(capability.follow),
    shelf: Object.freeze(capability.shelf),
  });
}
