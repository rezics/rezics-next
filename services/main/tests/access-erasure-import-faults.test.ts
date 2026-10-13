import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ACCESS_ERASURE_RECOVERY_PROFILE,
  ACCESS_ERASURE_RECOVERY_VERSION,
  AccessErasureRecoveryConflict,
  importAccessErasureRecoveryAttachment,
  type AccessErasureRecoveryExpectation,
} from '../src/modules/access/erasure-recovery.ts';
import { accessRecoveryCatalog, scanAccessOutbox, scanAccessTables } from '../src/modules/work/access-recovery-coverage.ts';
import { ownerCatalog } from '../src/modules/work/pg-recovery-frontier.ts';
import { isRestoreTransientFailure } from '../src/modules/work/restore-lineage.ts';

const savepoint = 'SAVEPOINT access_erasure_recovery_guard';
const rollback = 'ROLLBACK TO SAVEPOINT access_erasure_recovery_guard';
const release = 'RELEASE SAVEPOINT access_erasure_recovery_guard';

// The importer gets the real catalog/coverage readers and parser. Only the
// database transport is replaced, so this matrix needs no recovery stack.
function heldClient() {
  const queries: string[] = [];
  let fault: { site: 'savepoint' | 'transaction'; error: Error } | undefined;
  let readOnly = 'off';
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (fault && (fault.site === 'savepoint' ? sql === savepoint : sql.includes('transaction_read_only')))
        throw fault.error;
      let rows: unknown[];
      if ([savepoint, rollback, release].includes(sql) || sql.startsWith('CREATE TEMP TABLE')
        || sql.includes("set_config('TimeZone'")) rows = [];
      else if (sql.includes('transaction_read_only')) rows = [{ read_only: readOnly }];
      else if (sql.includes('FROM access.recovery_fence')) rows = [{ open: false, generation: '0' }];
      else if (sql.includes('FROM pg_class c JOIN pg_namespace')) {
        rows = ['admission', 'admission_receipt', 'also_enjoyed_source_change', 'discovery_source_change', 'outbox']
          .map(table => ({ schema: 'access', table, persistence: 'p', comment: null,
            key: ['id'], key_types: ['uuid'], columns: ['id uuid'] }));
      } else if (sql.includes('FROM pg_attribute a WHERE a.attrelid = $1::regclass'))
        rows = [{ name: 'id', type: 'uuid', generated: false }];
      else if (sql.includes('to_jsonb(t)::text AS body') || sql.includes('FROM access.outbox')) rows = [];
      else throw new Error(`unexpected importer query: ${sql}`);
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return {
    client,
    queries,
    fail(site: 'savepoint' | 'transaction', error: Error) { fault = { site, error }; },
    makeReadOnly() { readOnly = 'on'; },
  };
}

async function expectation(client: PoolClient, input: string): Promise<AccessErasureRecoveryExpectation> {
  const catalog = accessRecoveryCatalog(await ownerCatalog(client));
  const state = (await scanAccessTables(client)).state;
  const legacyBaseState = (await scanAccessTables(client, 'access-state-v5')).state;
  const outbox = await scanAccessOutbox(client);
  return {
    profile: ACCESS_ERASURE_RECOVERY_PROFILE,
    version: ACCESS_ERASURE_RECOVERY_VERSION,
    catalogVersion: 2, legacyBaseState, catalogDigest: catalog.digest,
    baseFenceGeneration: '0',
    sourceFenceGeneration: '0',
    baseState: state,
    sourceState: state,
    baseOutbox: outbox,
    sourceOutbox: outbox,
    rowCount: '0',
    rowDigest: createHash('sha256').digest('hex'),
    plaintextBytes: String(Buffer.byteLength(input)),
    plaintextDigest: createHash('sha256').update(input).digest('hex'),
  };
}

async function* attachment(input: string) { yield input; }

async function captureFailure(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('the importer unexpectedly accepted the fault');
}

for (const site of ['savepoint', 'transaction'] as const) {
  for (const [code, transient] of [
    ['ECONNRESET', true],
    ['57P01', true],
    ['25P01', false],
    ['25P02', false],
  ] as const) {
    test(`native Access importer ${site}: ${code} retains its cause and is ${transient ? 'retryable' : 'terminal'}`, async () => {
      const held = heldClient();
      const expected = await expectation(held.client, '');
      const fault = Object.assign(new Error('Access owner unavailable'), { code });
      held.fail(site, fault);
      const caught = await captureFailure(() =>
        importAccessErasureRecoveryAttachment(held.client, attachment(''), expected));
      if (site === 'savepoint') {
        expect(caught).toBeInstanceOf(AccessErasureRecoveryConflict);
        expect(caught.message).toBe('Access erasure import requires an active held transaction');
        expect(caught.cause).toBe(fault);
        expect(held.queries).not.toContain(rollback);
      } else {
        expect(caught).toBe(fault);
        expect(held.queries.slice(-2)).toEqual([rollback, release]);
      }
      expect(isRestoreTransientFailure(caught)).toBe(transient);
    });
  }
}

test('native Access importer invalid JSON keeps its parser cause and remains terminal', async () => {
  const held = heldClient();
  const input = '{invalid JSON\n';
  const expected = await expectation(held.client, input);
  const caught = await captureFailure(() =>
    importAccessErasureRecoveryAttachment(held.client, attachment(input), expected));
  expect(caught).toBeInstanceOf(AccessErasureRecoveryConflict);
  expect(caught.message).toBe('native Access attachment is not valid JSON');
  expect(caught.cause).toBeInstanceOf(SyntaxError);
  expect(isRestoreTransientFailure(caught)).toBe(false);
  expect(held.queries.slice(-2)).toEqual([rollback, release]);
});

test('native Access importer read-only transaction refusal remains terminal', async () => {
  const held = heldClient();
  const expected = await expectation(held.client, '');
  held.makeReadOnly();
  const caught = await captureFailure(() =>
    importAccessErasureRecoveryAttachment(held.client, attachment(''), expected));
  expect(caught).toBeInstanceOf(AccessErasureRecoveryConflict);
  expect(caught.message).toBe('Access erasure import requires a writable held transaction');
  expect(isRestoreTransientFailure(caught)).toBe(false);
  expect(held.queries.slice(-2)).toEqual([rollback, release]);
});
