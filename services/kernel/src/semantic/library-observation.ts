/** Semantic application for canonical, Follow and shelf observation consumers. */

import type {
  LibrarySemanticObservationCapability,
  LibrarySemanticSummaryObservation,
} from '../library/contract/semantic-observation.ts';
import {
  createNativeLibraryObservationAdapter,
  type SemanticObservationNativeAdapter,
} from './adapters/library-observation.ts';

/** Attach each native result to the exact owner declaration for that operation. */
export function createLibraryObservationApplication(
  native: SemanticObservationNativeAdapter = createNativeLibraryObservationAdapter(),
): LibrarySemanticObservationCapability {
  return Object.freeze({
    canonical: Object.freeze({
      ...native.canonical,
      async readMappings(pool, originals) {
        const value = await native.canonical.readMappings(pool, originals);
        return Object.freeze({ value, work: native.canonical.mappingWork(originals) });
      },
      async commitScopeCapture(client, input) {
        await native.canonical.commitScopeCapture(client, input);
        return Object.freeze({ value: undefined, work: native.canonical.scopeCommitWork(input) });
      },
    }),
    follow: Object.freeze({
      ...native.follow,
      async readMapping(pool, original) {
        const value = await native.follow.readMapping(pool, original);
        return Object.freeze({ value, work: native.follow.mappingWork([original]) });
      },
      async readMappings(pool, originals) {
        const value = await native.follow.readMappings(pool, originals);
        return Object.freeze({ value, work: native.follow.mappingWork(originals) });
      },
      async readSubjectReference(input) {
        const value = await native.follow.readSubjectReference(input);
        return Object.freeze({ value, work: native.follow.subjectReferenceWork(input.subjectId) });
      },
      async observeSubjects(input) {
        const observed = await native.follow.observeSubjects(input);
        const value: LibrarySemanticSummaryObservation = Object.freeze({
          summaries: observed.summaries,
          async current() {
            const current = await observed.current();
            return Object.freeze({ value: current, work: native.follow.subjectSummaryCurrentWork(input.ids) });
          },
        });
        return Object.freeze({ value, work: native.follow.subjectSummaryWork(input.ids) });
      },
    }),
    shelf: Object.freeze({
      ...native.shelf,
      async readIdentityVersion(client, subjectId) {
        const value = await native.shelf.readIdentityVersion(client, subjectId);
        return Object.freeze({ value, work: native.shelf.identityVersionWork(subjectId) });
      },
      async readItemTypes(client, subjectIds, maxTypeBytes) {
        const value = await native.shelf.readItemTypes(client, subjectIds);
        return Object.freeze({ value, work: native.shelf.itemTypesWork(subjectIds, maxTypeBytes) });
      },
    }),
  });
}
