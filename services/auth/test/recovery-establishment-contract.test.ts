import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import * as auth from '../src/index.ts';
import {
  createRecoveryEstablishmentVerifier,
  type RecoveryEstablishmentEvidence,
} from '../src/recovery-establishment.ts';

const evidence: RecoveryEstablishmentEvidence = Object.freeze({
  accountId: '00000000-0000-7000-8000-123400000001',
  receiptId: '00000000-0000-8000-8000-123400000002',
  minimumAuthnEpoch: '9007199254740993',
  authnEpoch: 3,
  establishmentId: 'committed-native-establishment',
});

function untouchedDatabase() {
  let reads = 0;
  const database = new Proxy({} as Pool, {
    get() {
      reads++;
      throw new Error('No database access is permitted');
    },
  });
  return { database, reads: () => reads };
}

test('recovery completion evidence has exact barrier and new establishment fields', () => {
  expectTypeOf<RecoveryEstablishmentEvidence>().toEqualTypeOf<
    Readonly<{
      accountId: string;
      receiptId: string;
      minimumAuthnEpoch: string;
      authnEpoch: number;
      establishmentId: string;
    }>
  >();
  expectTypeOf<auth.RecoveryEstablishmentEvidence>().toEqualTypeOf<RecoveryEstablishmentEvidence>();
  expectTypeOf<Parameters<typeof createRecoveryEstablishmentVerifier>>().toEqualTypeOf<[{ database: Pool }]>();
  expectTypeOf<ReturnType<typeof createRecoveryEstablishmentVerifier>>().toEqualTypeOf<{
    resolve(reference: unknown): Promise<RecoveryEstablishmentEvidence | null>;
  }>();
  expectTypeOf<auth.TrustedAccessPorts['completeRecovery']>().toEqualTypeOf<
    ((reference: string) => Promise<void>) | undefined
  >();
  expectTypeOf<{}>().toExtend<Pick<auth.TrustedAccessPorts, 'completeRecovery'>>();
  expect(auth.createRecoveryEstablishmentVerifier).toBe(createRecoveryEstablishmentVerifier);
});

test('unresolved reference denies without database IO', async () => {
  const db = untouchedDatabase();
  const verifier = createRecoveryEstablishmentVerifier({ database: db.database });
  expect(db.reads()).toBe(0);
  // Unavailable-only assertion: replace only this successful-resolution candidate
  // when native committed success and current credential verification exist.
  expect(await verifier.resolve('a'.repeat(64))).toBeNull();
  for (const reference of [undefined, null, '', 'x'.repeat(4097), 1, true, [], {}, evidence, JSON.stringify(evidence)])
    expect(await verifier.resolve(reference)).toBeNull();
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('Caller evidence must not be inspected');
      },
      ownKeys() {
        throw new Error('Caller evidence must not be enumerated');
      },
    },
  );
  expect(await verifier.resolve(hostile)).toBeNull();
  expect(db.reads()).toBe(0);
});

test('no caller evidence object can clear Access fence', async () => {
  const db = untouchedDatabase();
  const verifier = createRecoveryEstablishmentVerifier({ database: db.database });
  // Access clearFence requires resolver-verified evidence. Matching caller fields
  // must never produce that evidence, even after successful resolution is added.
  for (const reference of [
    evidence,
    { ...evidence },
    JSON.parse(JSON.stringify(evidence)),
    JSON.stringify(evidence),
    { ...evidence, minimumAuthnEpoch: '3' },
    { ...evidence, receiptId: 'old-receipt' },
    { ...evidence, establishmentId: '' },
  ]) {
    expect(await verifier.resolve(reference)).toBeNull();
  }
  expect(db.reads()).toBe(0);
});

test('evidence contract exports only the verifier and has no runtime dependencies', async () => {
  const source = await Bun.file(new URL('../src/recovery-establishment.ts', import.meta.url)).text();
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
  expect(transpiler.scanImports(source)).toEqual([]);
  expect(transpiler.scan(transpiler.transformSync(source)).exports).toEqual(['createRecoveryEstablishmentVerifier']);
  expect(Object.keys(auth).filter((name) => /recovery/i.test(name))).toEqual(['createRecoveryEstablishmentVerifier']);
});
