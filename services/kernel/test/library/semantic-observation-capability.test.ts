import { expect, test } from 'bun:test';
import { createLibraryObservationApplication } from '../../src/semantic/library-observation.ts';
import type { SemanticObservationNativeAdapter } from '../../src/semantic/adapters/library-observation.ts';
import type { WorkDimensions } from '../../src/library/contract/work-dimensions.ts';

const work: WorkDimensions = Object.freeze({
  candidateKeys: 0,
  nativeRows: 2,
  identityMetadataRows: 1,
  emptySeeks: 1,
  nativePoints: 1,
  witnessKeys: 0,
  statements: 1,
  bytes: 37,
});

test('Semantic observations return owner work for both summary hydration and its currentness read', async () => {
  let received: unknown;
  const native = {
    follow: {
      mappingWork: () => work,
      subjectReferenceWork: () => work,
      subjectSummaryWork: () => work,
      subjectSummaryCurrentWork: () => work,
      observeSubjects: async (input: unknown) => {
        received = input;
        return { summaries: new Map(), current: async () => true };
      },
    },
  } as unknown as SemanticObservationNativeAdapter;
  const observations = createLibraryObservationApplication(native);
  const context = {} as Parameters<typeof observations.follow.observeSubjects>[0]['context'];
  const ids = ['00000000-0000-8000-8000-000000000001'];
  const observed = await observations.follow.observeSubjects({ context, ids });

  expect(received).toEqual({ context, ids });
  expect(observed.work).toEqual(work);
  expect(await observed.value.current()).toEqual({ value: true, work });
});
