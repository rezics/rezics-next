import { expect, test } from 'bun:test';
import {
  admitCollectionKindPreparationStep,
  bindCollectionKindPreparationStep,
  readCollectionKindWorkDefinition,
} from '../../src/library/collection-kind-work-admission.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import type { OperationalTransaction } from '../../src/command/operational.ts';
import { newId } from '../../src/route/route.ts';

// A real accounting object does not turn a structural transaction into Core admission.
test('Kind admission rejects a copied native home before querying or consuming its frame', async () => {
  let queries = 0;
  const tx = {
    query() {
      queries++;
      throw new Error('Unadmitted home reached SQL');
    },
  } as unknown as OperationalTransaction;
  const locator = Object.freeze({
    route: 0xc100,
    ownerAccountId: newId(0xc100),
    collectionId: newId(0xc100),
    preparationId: newId(0xc100),
  });
  const work = new NativeCollectionWork(
    {
      reservationId: crypto.randomUUID(),
      remaining: {
        candidateKeys: 10,
        nativeRows: 10,
        nativePoints: 10,
        identityMetadataRows: 10,
        witnessKeys: 10,
        emptySeeks: 10,
        statements: 10,
        bytes: 65536,
      },
    },
    Date.now() + 5000,
  );
  const before = work.receipt();
  expect(() => bindCollectionKindPreparationStep(tx, locator, work)).toThrow();
  await expect(admitCollectionKindPreparationStep(tx, locator, work)).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  expect(await readCollectionKindWorkDefinition(tx, locator, work)).toBeNull();
  expect(work.receipt()).toEqual(before);
  expect(queries).toBe(0);
});
