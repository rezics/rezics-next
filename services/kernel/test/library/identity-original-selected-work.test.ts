import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import * as installed from '../../src/library/collection-source-work.ts';
import { assembleLibraryIdentitySelectedBodies } from '../../src/library/identity-original-work.ts';
import {
  declareNativeIdentitySourceBasisStatements,
  libraryIdentitySelectedFootprint,
  nativeIdentitySourceBasisFootprint,
} from '../../src/library/identity-native-planner-selected-pricing.ts';
import { LIBRARY_IDENTITY_SELECTED_STATEMENTS } from '../../src/library/identity-native-planner-projection.ts';
import { nativeSourceCustodyFootprint } from '../../src/library/native-source-custody.ts';
import { libraryIdentityFootprint } from '../../src/library/identity-native-planner-work.ts';

test('installed selected Library declaration is own frozen data, covers the enforced schedule and excludes Source controls', () => {
  const field = Object.getOwnPropertyDescriptor(installed, 'IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION');
  expect(field && 'value' in field).toBe(true);
  const declaration = installed.IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION;
  expect(Reflect.ownKeys(declaration).sort()).toEqual(['engineRequests', 'work']);
  expect(Reflect.ownKeys(declaration.work).sort()).toEqual([
    'bytes',
    'candidateKeys',
    'emptySeeks',
    'identityMetadataRows',
    'nativePoints',
    'nativeRows',
    'statements',
    'witnessKeys',
  ]);
  expect(Object.isFrozen(declaration)).toBe(true);
  expect(Object.isFrozen(declaration.work)).toBe(true);
  expect(Object.values(declaration.work).every((n) => Number.isSafeInteger(n) && n >= 0)).toBe(true);
  const body = assembleLibraryIdentitySelectedBodies();
  expect(declaration).toEqual({ work: body.total.work, engineRequests: 0 });
  expect(body.missing).toEqual([]);
  expect(declaration.work).toMatchObject({
    candidateKeys: 1,
    nativeRows: 785,
    identityMetadataRows: 66,
    nativePoints: 127,
    witnessKeys: 0,
    statements: 34,
    emptySeeks: 70,
  });
});

test('installed pricing and actual dispatch share every selected literal and bounded current native projection', () => {
  for (const { sql, values } of Object.values(LIBRARY_IDENTITY_SELECTED_STATEMENTS)) {
    expect(libraryIdentitySelectedFootprint(sql, values)).toEqual(libraryIdentityFootprint(sql, values));
    expect(libraryIdentitySelectedFootprint(sql + '; SELECT 1', values)).toBeUndefined();
    expect(libraryIdentitySelectedFootprint(sql, [...values, 'extra'])).toBeUndefined();
  }
  for (const item of declareNativeIdentitySourceBasisStatements()) {
    // The declaring producer uses the actual maximum original binds; no caller
    // observation or configured balance participates in this comparison.
    expect(item.engineRequests).toBe(0);
    expect(nativeIdentitySourceBasisFootprint(item.sql + '; SELECT 1', [])).toBeUndefined();
    expect(nativeSourceCustodyFootprint(item.sql + '; SELECT 1', [])).toBeUndefined();
  }
});

test('a delegated body observer ends before executor controls without becoming physical checkout custody', async () => {
  // Accounting-only fixture: neither this forwarding surface nor its result is a
  // genuine CommandTransaction, original grant or native seal.
  const pool = Object.assign(new EventEmitter(), {
    connect: async () => {
      throw new Error('Unexpected checkout');
    },
  }) as unknown as Pool;
  const { sql, values } = LIBRARY_IDENTITY_SELECTED_STATEMENTS.plan;
  const price = libraryIdentitySelectedFootprint(sql, values)!;
  const work = new installed.NativeCollectionWork({ reservationId: 'body-only', remaining: price }, Date.now() + 5000);
  const calls: string[] = [];
  const client = {
    query: async (text: string) => {
      calls.push(text);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pick<PoolClient, 'query'>;
  await installed.instrumentNativeCollectionWork(
    pool,
    work,
    libraryIdentitySelectedFootprint,
    async () => {
      await client.query(sql, [...values]);
    },
    client,
  );
  expect(work.receipt().used.statements).toBe(1);
  await client.query('COMMIT'); // Core's separately paid terminal work is outside this body.
  expect(calls).toEqual([sql, 'COMMIT']);
  expect(work.receipt().used.statements).toBe(1);
  await expect(
    installed.instrumentNativeCollectionWork(
      pool,
      work,
      libraryIdentitySelectedFootprint,
      async () => {
        await client.query('SELECT unknown');
      },
      client,
    ),
  ).rejects.toThrow();
  expect(calls).toEqual([sql, 'COMMIT']);
});
