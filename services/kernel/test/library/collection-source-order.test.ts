import { expect, test } from 'bun:test';
import { PROBLEMS, ProblemError } from '../../src/http/problem-error.ts';
import type { CollectionMemberRow, MemberPage } from '../../src/library/collection-model.ts';
import type {
  NativeOrdinalFrontier,
  NativeOrdinalKey,
  NativeOrdinalRow,
  RawOrdinalCollectionPrefix,
  ReadRawOrdinalCollectionPrefix,
} from '../../src/library/collection-source-order.ts';
import {
  createCollectionSource,
  type CollectionSource,
  type CollectionSourceCall,
  type CollectionSourceObservation,
} from '../../src/library/collection-source.ts';
import { type WorkReceipt } from '../../src/library/contract/work-dimensions.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Consumers alias the native tuple, member projection and shared work ABI without widening them. */
type ConsumerContract = [
  Assert<Equal<NativeOrdinalKey, Readonly<NonNullable<MemberPage['after']>>>>,
  Assert<Equal<NativeOrdinalFrontier, Readonly<{ after: NativeOrdinalKey | null }>>>,
  Assert<
    Equal<
      NativeOrdinalRow,
      Readonly<
        Pick<
          CollectionMemberRow,
          'memberId' | 'subjectId' | 'ordinalKey' | 'deletionId' | 'deletedAt' | 'memberRevision'
        >
      >
    >
  >,
  Assert<
    Equal<
      RawOrdinalCollectionPrefix,
      Readonly<{
        kind: 'raw_curated_ordinal_prefix';
        rows: readonly NativeOrdinalRow[];
        frontier: NativeOrdinalFrontier;
        exhausted: boolean;
        observation: CollectionSourceObservation;
        work: WorkReceipt;
      }>
    >
  >,
  Assert<
    Equal<
      ReadRawOrdinalCollectionPrefix,
      CollectionSourceCall & Readonly<{ after: NativeOrdinalKey | null; limit: number }>
    >
  >,
  Assert<Equal<Parameters<CollectionSource['readRawOrdinalPrefix']>, [input: ReadRawOrdinalCollectionPrefix]>>,
  Assert<Equal<ReturnType<CollectionSource['readRawOrdinalPrefix']>, Promise<RawOrdinalCollectionPrefix>>>,
];

test('Ordered Collection consumers alias exact native ordinal tuple and work types while unimplemented execution remains unavailable', async () => {
  const contract: ConsumerContract = [true, true, true, true, true, true, true];
  expect(contract.every(Boolean)).toBe(true);
  const source = createCollectionSource({
    get pool(): Parameters<typeof createCollectionSource>[0]['pool'] {
      throw new Error('The unavailable factory must not read a database dependency');
    },
    get access(): Parameters<typeof createCollectionSource>[0]['access'] {
      throw new Error('The unavailable factory must not read an Access dependency');
    },
  });
  const input: ReadRawOrdinalCollectionPrefix = {
    after: null,
    limit: 100,
    get actor(): Extract<CollectionSourceCall, { work?: never }>['actor'] {
      throw new Error('Unimplemented execution must not inspect the actor');
    },
    get at(): Extract<CollectionSourceCall, { work?: never }>['at'] {
      throw new Error('Unimplemented execution must not inspect native time');
    },
    get source(): CollectionSourceCall['source'] {
      throw new Error('Unimplemented execution must not inspect a prepared source');
    },
    deadline: 0,
    get allowance(): CollectionSourceCall['allowance'] {
      throw new Error('Unimplemented execution must not consume work');
    },
  };
  const failure = await source.readRawOrdinalPrefix(input).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ProblemError);
  expect(failure).toMatchObject({ code: 'dependency_unavailable' });
  expect(PROBLEMS.dependency_unavailable.retryable).toBe(true);
});
