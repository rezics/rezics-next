import { expect, test } from 'bun:test';
import {
  admitCollectionPublicationStep,
  readCollectionPublicationWorkDefinition,
} from '../../src/library/collection-publication-work-admission.ts';
import { newId } from '../../src/route/route.ts';

test('publication locator and copied query cannot admit Source IO without the original live Core client', async () => {
  let queries = 0;
  const client = {
    query() {
      queries++;
      throw new Error('Unadmitted publication attempted IO');
    },
  };
  const locator = {
    route: 32,
    ownerAccountId: newId(33),
    collectionId: newId(32),
    publicationId: newId(32),
  };
  // Deliberately enter through the untyped runtime boundary; no OperationalTransaction cast
  // can turn either the copied query method or a row-shaped object into a native transaction.
  for (const untrusted of [client, Object.create(client), { ...client }]) {
    expect(await Reflect.apply(admitCollectionPublicationStep, undefined, [untrusted, locator])).toBe(false);
    expect(await Reflect.apply(readCollectionPublicationWorkDefinition, undefined, [untrusted, locator])).toBeNull();
  }
  expect(queries).toBe(0);
});
