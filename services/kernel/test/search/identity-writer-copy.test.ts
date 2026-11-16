import { beforeAll, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Pool, QueryConfig } from 'pg';
import { installNativeHistoryPreload } from '../../src/composition/preload.ts';
import { composeSearchNativePorts } from '../../src/composition/search-native.ts';
import { newId } from '../../src/route/route.ts';
import { searchIdentityReceivingComposition } from '../../src/search/identity-epoch-participant.ts';
import { createSearchWriterGuard, readRetainedWriterCopySql } from '../../src/search/writer-guard.ts';
import { installSearchIdentityReceivingNative } from '../../src/semantic/identity-receiving-effects.ts';
import {
  identitySourceConsumerLibraryWork,
  identitySourceConsumerNativeWork,
  withIdentitySourceConsumerMaintenance,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { searchReceivingProductionDeclaration } from '../../src/semantic/identity-search-receiving-statements.ts';

beforeAll(installNativeHistoryPreload);

const prefix = 'writer-copy-';
const route = 0x8410;
const partition = route >> 4;
const original = newId(route);
const token = crypto.randomUUID();
const transactionId = crypto.randomUUID();
const visibleId = crypto.randomUUID();
const locator = { partition, token };
const gate = { gate_incarnation: 'allocation', gate_epoch: 1 };
const copy = {
  ...gate,
  original_id: original,
  incarnation: 'allocation',
  owner_epoch: 1,
  dispatch_state: 'dispatched',
  source_position: '21',
  visible_transaction_id: visibleId,
  visible_position: '22',
  writer_token: crypto.randomUUID(),
  writer_transaction_id: transactionId,
  writer_position: '23',
};

test.each([
  { label: 'dispatched original', row: copy },
  { label: 'absent original', row: { ...gate, original_id: null } },
  { label: 'changed allocation', row: { ...copy, incarnation: 'different' }, refusal: 'requires native handoff' },
  { label: 'unavailable barrier', row: undefined, refusal: 'barrier is missing' },
  { label: 'insufficient work', row: copy, refusal: 'exceeds the original native frame', unfunded: true },
])('retained Search copy point charges the original frame for $label', async ({ row, refusal, unfunded }) => {
  const pool = new EventEmitter() as EventEmitter & Pool;
  const forbidden = () => {
    throw new Error('Unexpected Pool query, Access, Source or engine work');
  };
  pool.query = forbidden;
  let lookups = 0;
  const client = {
    async query(input: string | QueryConfig, positional: unknown[] = []) {
      const sql = typeof input === 'string' ? input : input.text;
      const values = typeof input === 'string' ? positional : input.values;
      if (sql === readRetainedWriterCopySql) {
        expect(values).toEqual([partition, `${prefix}subjects-g1`, token, 'search_writer_copy_subjects_g1', original]);
        lookups++;
        const rows = row ? [row] : [];
        return { rows, rowCount: rows.length };
      }
      if (
        ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql) ||
        sql.startsWith('SET LOCAL statement_timeout')
      )
        return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected driver query ${sql}`);
    },
    release() {},
  };
  pool.connect = (async () => {
    pool.emit('acquire', client);
    return client;
  }) as Pool['connect'];
  const search = { request: forbidden, bulk: forbidden };
  const receiving = searchIdentityReceivingComposition({
    pool,
    search,
    prefix,
    routeKey: new Uint8Array(32),
    access: { authorize: forbidden, authenticate: forbidden } as never,
    clock: () => new Date(),
    identitySourceSupportReaderFactory: composeSearchNativePorts().createIdentitySourceSupportReader,
    work: searchReceivingProductionDeclaration(),
  });
  const installed = await installSearchIdentityReceivingNative(pool, receiving.work, receiving.configuration);
  const writer = createSearchWriterGuard({
    ...receiving.configuration,
    source: { read: forbidden } as never,
    listing: { read: forbidden },
  });
  const env = unfunded ? { KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_POINTS: '3' } : {};
  await withIdentitySourceConsumerMaintenance({ pool, env }, { deadline: Date.now() + 5000 }, async (funded) => {
    const { deadline, identityConsumerWork } = funded;
    const allowance = identitySourceConsumerNativeWork(pool, identityConsumerWork, deadline)!;
    const ledger = identitySourceConsumerLibraryWork(pool, identityConsumerWork, deadline)!;
    const ceiling = {
      candidateKeys: ledger.available('candidateKeys'),
      identityMetadataRows: ledger.available('identityMetadataRows'),
      nativeRows: ledger.available('nativeRows'),
      nativePoints: ledger.available('nativePoints'),
      witnessKeys: ledger.available('witnessKeys'),
      statements: ledger.available('statements'),
      bytes: ledger.available('bytes'),
      emptySeeks: ledger.available('emptySeeks'),
    };
    const result = installed.run({ ...funded, allowance, ceiling }, () =>
      writer.readRetainedCopy(locator, original, deadline),
    );
    if (refusal) await expect(result).rejects.toThrow(refusal);
    else {
      expect((await result).value).toEqual(
        row?.original_id
          ? {
              original,
              state: 'dispatched',
              sourcePosition: 21n,
              visible: { transactionId: visibleId, position: 22n, epoch: 1, partition },
              enrollment: { transactionId, position: 23n, epoch: 1, partition },
            }
          : null,
      );
    }
    const remaining = identitySourceConsumerNativeWork(pool, identityConsumerWork, deadline)!;
    expect(allowance.rows - remaining.rows).toBe(unfunded ? 0 : 3);
    expect(allowance.points - remaining.points).toBe(unfunded ? 1 : 4);
    expect(allowance.bytes - remaining.bytes).toBe(unfunded ? 0 : 1024);
    expect(allowance.statements - remaining.statements).toBe(unfunded ? 4 : 5);
    expect(remaining.engineRequests).toBe(0);
  });
  expect(lookups).toBe(unfunded ? 0 : 1);
});
