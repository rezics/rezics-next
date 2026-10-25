import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { seal, unseal } from '../../src/tokens/seal.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let internal: ReturnType<typeof createLifecycleInternals>;
let proof: ReturnType<typeof createRegistrationProofBindings>;
let accountId: string;
let reference: string;
let missing: string;
let wrongDigest: string;
let expected: Awaited<ReturnType<typeof internal.createPending>>['value'];
const referenceKeys = { current: 3, keys: new Map([[3, randomBytes(32)]]) };
const units = 4;

beforeAll(async () => {
  db = await openGrowthDatabase();
  internal = createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(23),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  accountId = internal.registrationTarget('growth-proof');
  const handle = 'growth_proof';
  const reservation = await internal.reserveHandle({ accountId, handle, key: 'growth-proof' });
  const input = { accountId, handle, key: 'growth-proof', reservationId: reservation.value.reservationId };
  const outcome = await internal.createPending(input);
  expected = outcome.value;
  proof = createRegistrationProofBindings({ pool: db.pool, referenceKeys });
  reference = (await proof.createProvisioningReference({ input, outcome }))!;
  expect(reference).toBeString();
  const payload = unseal(referenceKeys, 'access.registration-proof.v1', reference) as Record<string, unknown>;
  // Signed negative cases force the production factory through native lookup, beyond MAC rejection.
  missing = seal(referenceKeys, 'access.registration-proof.v1', { ...payload, key: 'absent-native-key' });
  wrongDigest = seal(referenceKeys, 'access.registration-proof.v1', { ...payload, handle: 'wrong_digest' });
  // Keep all measured scales beyond PostgreSQL's small-table sequential-scan
  // crossover. This fixed baseline also uses actual lifecycle commands.
  for (let index = 0; index < 512; index++) {
    const other = newId(routeOf(accountId)!);
    const handle = `baseline_${index}`;
    const key = `baseline-${index}`;
    const reservation = await internal.reserveHandle({ accountId: other, handle, key });
    await internal.createPending({ accountId: other, handle, key, reservationId: reservation.value.reservationId });
  }
});
afterAll(async () => db?.close());

test('reference lookup is bounded across receipt history', async () => {
  const route = routeOf(accountId)!;
  const report = await checkGrowth(db, {
    name: 'reference lookup is bounded across receipt history',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 3,
    warmups: 1,
    grow: async (database, scale, previous) => {
      for (let index = previous * units; index < scale * units; index++) {
        // A real cancellation may precede a handle hold. It retains native receipts on
        // this pending account's anchor without changing its registration or expiry.
        await internal.cancelHandleTransition({
          accountId,
          key: `history-${index}`,
          operationId: `cancel-${index}`,
          handle: `cancelled_${index}`,
          reservationId: newId(route),
          expectedHandle: null,
        });
        // Real createPending commands on unrelated accounts grow the same partition,
        // service principal AND pending kind, rather than spreading history away.
        const other = newId(route);
        const handle = `unrelated_${index}`;
        const key = `unrelated-${index}`;
        const reservation = await internal.reserveHandle({ accountId: other, handle, key });
        await internal.createPending({ accountId: other, handle, key, reservationId: reservation.value.reservationId });
      }
      await database.admin.query('VACUUM (ANALYZE) core.receipt');
      await database.admin.query('VACUUM (ANALYZE) access.account');
    },
    operation: async () => {
      expect(await proof.verifyProvisioningReceipt(reference)).toEqual(expected);
      expect(await proof.verifyProvisioningReceipt(missing)).toBeNull();
      expect(await proof.verifyProvisioningReceipt(wrongDigest)).toBeNull();
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['core.receipt']?.rows).toBe(2);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(1);
    expect(sample.cost.statements).toBe(7);
  }
}, 60_000);
