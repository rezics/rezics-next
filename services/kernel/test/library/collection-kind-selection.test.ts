import { expect, test } from 'bun:test';
import { BOUND_AXES, declareBound, repeatBound, sumBounds } from '@rezics/bounds';
import {
  COLLECTION_KIND_INPUT_DECLARATION,
  collectionKind,
  dominantCollectionKind,
  reduceConfiguredCollectionKinds,
} from '../../src/library/collection-kind.ts';
import { collectionPresentation } from '../../src/library/collection-presentation.ts';
import {
  COLLECTION_KIND_INPUT_BYTE_LIMIT,
  COLLECTION_KIND_INPUT_PATHS,
  COLLECTION_KIND_INPUT_QUANTUM,
  COLLECTION_KIND_INPUT_RAW_LIMIT,
  COLLECTION_KIND_INPUT_TERMS,
  COLLECTION_KIND_PREPARATION_OBSERVATION,
  COLLECTION_KIND_PREPARATION_TERMS,
  collectionKindInputAdmitted,
  collectionKindInputWork,
  collectionKindInputWorkDimensions,
} from '../../src/library/collection-kind-input-bounds.ts';
import { NativeCollectionWork } from '../../src/work-ledger/native-collection-work.ts';
import { readCollectionKindPreparationType } from '../../src/library/collection-kind-preparation.ts';
import { newId } from '../../src/route/route.ts';
import { resolveCollectionKindRawInput } from '../../src/library/collection-kind-input.ts';

test('dominant kind counts canonical subjects and resolves ties by exact TypeId', () => {
  const canonicalTypes = new Map<string, string>();
  for (let occurrence = 0; occurrence < 8; occurrence++) canonicalTypes.set('movie', 'schema:Movie');
  canonicalTypes.set('book', 'schema:Book');
  expect(dominantCollectionKind(canonicalTypes)).toEqual({
    presentationKind: 'schema:Book',
    presentationKindSource: 'members',
  });
  canonicalTypes.set('second-movie', 'schema:Movie');
  expect(dominantCollectionKind(canonicalTypes)).toEqual({
    presentationKind: 'schema:Movie',
    presentationKindSource: 'members',
  });
  // Insertion order and locale collation cannot change the exact TypeId tie-break.
  const exactTie = new Map([
    ['lower', 'example:a'],
    ['upper', 'example:Z'],
  ]);
  expect(dominantCollectionKind(exactTie)).toEqual({
    presentationKind: 'example:Z',
    presentationKindSource: 'members',
  });
});

test('mixed default and retained owner choice need no member evidence', () => {
  expect(collectionKind(null)).toEqual({ presentationKind: null, presentationKindSource: 'mixed' });
  expect(collectionKind('example:Retired')).toEqual({
    presentationKind: 'example:Retired',
    presentationKindSource: 'owner',
  });
});

test('mixed kind does not inherit independent cover readiness', () => {
  for (const row of [{ memberCount: 0 }, { memberCount: 1 }, { memberCount: 0, membershipKind: 'dynamic' }]) {
    expect(collectionPresentation({ ...row, presentationKind: null })).toMatchObject({
      presentationKind: null,
      presentationKindSource: 'mixed',
      coverSource: row.memberCount === 0 && row.membershipKind !== 'dynamic' ? 'none' : 'pending',
    });
  }
});

test('configured reduction takes one highest-ranked vote per canonical item and uses exact stable ID ties', () => {
  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:low', eligible: true, precedence: 1, result: 'match' },
          { id: 'kind:high', eligible: true, precedence: 2, result: 'match' },
        ],
      },
      {
        subjectId: 'subject:two',
        matches: [{ id: 'kind:low', eligible: true, precedence: 1, result: 'match' }],
      },
      {
        subjectId: 'subject:three',
        matches: [{ id: 'kind:high', eligible: true, precedence: 2, result: 'match' }],
      },
    ]),
  ).toEqual({ status: 'selected', kindId: 'kind:high' });

  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:Z', eligible: true, precedence: 3, result: 'match' },
          { id: 'kind:a', eligible: true, precedence: 3, result: 'match' },
        ],
      },
      {
        subjectId: 'subject:two',
        matches: [{ id: 'kind:Z', eligible: true, precedence: 3, result: 'match' }],
      },
      {
        subjectId: 'subject:three',
        matches: [{ id: 'kind:a', eligible: true, precedence: 3, result: 'match' }],
      },
    ]),
  ).toEqual({ status: 'selected', kindId: 'kind:Z' });
});

test('configured reduction preserves unknown possible winners as unavailable without admitting unknown ineligible kinds', () => {
  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:known', eligible: true, precedence: 1, result: 'match' },
          { id: 'kind:unknown', eligible: true, precedence: 2, result: 'unknown' },
        ],
      },
    ]),
  ).toEqual({ status: 'unavailable' });

  expect(
    reduceConfiguredCollectionKinds([
      {
        subjectId: 'subject:one',
        matches: [
          { id: 'kind:known', eligible: true, precedence: 2, result: 'match' },
          { id: 'kind:unknown', eligible: true, precedence: 1, result: 'unknown' },
          { id: 'kind:ineligible', eligible: false, precedence: 10, result: 'unknown' },
        ],
      },
    ]),
  ).toEqual({ status: 'selected', kindId: 'kind:known' });
  expect(reduceConfiguredCollectionKinds([])).toEqual({ status: 'empty' });
});

test('Kind raw-original input is one nine-axis plan shared by admission, composition and execution', () => {
  const terms = COLLECTION_KIND_INPUT_TERMS;
  expect(COLLECTION_KIND_INPUT_DECLARATION.status).toBe('complete');
  expect([...COLLECTION_KIND_INPUT_DECLARATION.axes]).toEqual([...BOUND_AXES]);
  expect(COLLECTION_KIND_INPUT_DECLARATION.cost).toEqual(
    sumBounds(terms.admission, terms.state, terms.collisionReads, terms.source, terms.insert, terms.retire),
  );
  expect(terms.collisionReads).toEqual(repeatBound(terms.read, 2));
  expect(terms.source).toEqual(sumBounds(terms.sourceMetadata, terms.sourcePage));
  expect(terms.admission).toEqual(sumBounds(terms.admissionEpisode, terms.admissionSource, terms.custody));
  expect(terms.custody).toBe(COLLECTION_KIND_PREPARATION_TERMS.custody);
  expect(COLLECTION_KIND_PREPARATION_OBSERVATION).toEqual(
    sumBounds(COLLECTION_KIND_PREPARATION_TERMS.scope, COLLECTION_KIND_PREPARATION_TERMS.custody),
  );
  expect(COLLECTION_KIND_INPUT_DECLARATION.cost.engineRequests).toBe(0);
  expect(collectionKindInputWork()).toEqual(collectionKindInputWorkDimensions(COLLECTION_KIND_INPUT_DECLARATION.cost));
  expect(COLLECTION_KIND_INPUT_PATHS).toMatchObject({
    quantum: 1,
    rawCeiling: 100,
    envelopeBytes: 4096,
    collisionReads: 2,
    predecessorRetirements: 1,
  });
});

test('an exact-limit raw page is not EOF and engineRequests cannot hide SQL work', () => {
  expect(COLLECTION_KIND_INPUT_QUANTUM).toBe(1);
  expect(COLLECTION_KIND_INPUT_RAW_LIMIT).toBe(100);
  expect(COLLECTION_KIND_INPUT_BYTE_LIMIT).toBe(4096);
  expect(COLLECTION_KIND_INPUT_TERMS.sourcePage.candidateKeys).toBe(1);
  expect(COLLECTION_KIND_INPUT_TERMS.sourcePage.nativeRows).toBeGreaterThan(
    COLLECTION_KIND_INPUT_TERMS.sourcePage.candidateKeys,
  );
  expect(() =>
    collectionKindInputWorkDimensions({ ...COLLECTION_KIND_INPUT_DECLARATION.cost, engineRequests: 1 }),
  ).toThrow('Collection Kind input cannot map engine requests to the native SQL observer');
  const overflow = declareBound({
    ...COLLECTION_KIND_INPUT_DECLARATION.cost,
    bytes: Number.MAX_SAFE_INTEGER,
  });
  expect(() => sumBounds(overflow, COLLECTION_KIND_INPUT_TERMS.state)).toThrow('Bound declaration overflow');
});

test('a complete encoded envelope over 4096 bytes is refused before dispatch and Type stays unavailable', async () => {
  const inputId = `sha256:${'ab'.repeat(32)}`;
  const body = {
    format: 1 as const,
    original: {
      id: inputId,
      digest: 'sha256:' + 'cd'.repeat(32),
      formula: 'sha256:' + 'ef'.repeat(32),
      audience: 'anonymous',
    },
    enrollment: {
      reference: 'ref',
      generation: crypto.randomUUID(),
      restore: '0',
      catalogue: 'sha256:' + '11'.repeat(32),
    },
    preparation: { id: crypto.randomUUID(), version: '1', predecessor: null },
    source: {
      identity: {
        scope: 'curated' as const,
        route: 0xc100,
        collectionId: newId(0xc100),
        accountId: newId(0xc100),
        incarnation: 'incarnation',
        generation: '1',
        ownerEpoch: 1,
        receivingEpoch: '1',
        effectKey: 'effect',
      },
      fence: 'f'.repeat(64),
      capture: JSON.stringify([1, 'f'.repeat(64), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), '1']),
      transaction: crypto.randomUUID(),
      hold: crypto.randomUUID(),
    },
    before: { driver: 'member' as const, after: null },
    after: { driver: 'done' as const, after: null },
    rows: [{ key: { driver: 'member' as const, id: newId(0xc100) } }],
    exhausted: true,
    padding: 'x'.repeat(COLLECTION_KIND_INPUT_BYTE_LIMIT),
  };
  expect(Buffer.byteLength(JSON.stringify({ inputId, body }))).toBeGreaterThan(COLLECTION_KIND_INPUT_BYTE_LIMIT);
  const remaining = collectionKindInputWork();
  const native = new NativeCollectionWork({ reservationId: crypto.randomUUID(), remaining }, Date.now() + 5000);
  expect(collectionKindInputAdmitted(native)).toBe(true);
  const short = new NativeCollectionWork(
    { reservationId: crypto.randomUUID(), remaining: { ...remaining, candidateKeys: 0 } },
    Date.now() + 5000,
  );
  expect(collectionKindInputAdmitted(short)).toBe(false);
  await expect(
    resolveCollectionKindRawInput(
      {
        query() {
          throw new Error('Unadmitted raw input reached SQL');
        },
      } as never,
      {
        route: 0xc100,
        ownerAccountId: newId(0xc100),
        collectionId: newId(0xc100),
        preparationId: crypto.randomUUID(),
      },
      inputId,
      native,
    ),
  ).rejects.toMatchObject({ code: 'semantic_not_ready' });
  expect(Object.values(native.receipt().used).every((value) => value === 0)).toBe(true);
  const type = await readCollectionKindPreparationType({
    allowance: { reservationId: crypto.randomUUID(), remaining },
    deadline: Date.now() + 5000,
  });
  expect(type).toMatchObject({ status: 'unavailable' });
  expect(Object.values(type.work.used).every((value) => value === 0)).toBe(true);
});
