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

test('Semantic observations attach owner work to mapping, reference, and shelf reads', async () => {
  const id = '00000000-0000-8000-8000-000000000001';
  const native = {
    follow: {
      mappingWork: () => work,
      subjectReferenceWork: () => work,
      readMapping: async () => ({ state: 'absent' }),
      readMappings: async () => [{ state: 'absent' }],
      readSubjectReference: async () => ({ state: 'present' }),
    },
    shelf: {
      identityVersionWork: () => work,
      itemTypesWork: () => work,
      readIdentityVersion: async () => null,
      readItemTypes: async () => new Map([[id, 'schema:CreativeWork']]),
    },
  } as unknown as SemanticObservationNativeAdapter;
  const observations = createLibraryObservationApplication(native);
  const pool = {} as never;
  const client = {} as never;

  expect(await observations.follow.readMapping(pool, id)).toEqual({ value: { state: 'absent' }, work });
  expect(await observations.follow.readMappings(pool, [id])).toEqual({ value: [{ state: 'absent' }], work });
  expect(
    await observations.follow.readSubjectReference({ pool, subjectId: id, check: async () => true }),
  ).toEqual({ value: { state: 'present' }, work });
  expect(await observations.shelf.readIdentityVersion(client, id)).toEqual({ value: null, work });
  expect(await observations.shelf.readItemTypes(client, [id], 128)).toEqual({
    value: new Map([[id, 'schema:CreativeWork']]),
    work,
  });
});
