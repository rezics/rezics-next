import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool, PoolClient } from 'pg';
import { sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult,
  type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { OwnerOperations } from '../src/modules/owner/operations.ts';
import type { RecoveryCoverage } from '../src/modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ownerRoutes } from '../src/routes/owners.ts';

const hmacKey = 'd4'.repeat(32);
const digest = 'a'.repeat(64);
const priorDataEpoch = '00000000-0000-4000-8000-000000000001';
const lineage = { dataEpoch: '00000000-0000-4000-8000-000000000002', routingEpoch: '2' };

interface Reconciliation {
  id: string;
  operation_id: string;
  request_digest: string;
  kind: 'restore';
  scope: 'product';
  consumer: string;
  state: 'running' | 'held';
  hold_reason: string | null;
}

interface ReconciliationItem {
  reconciliation_id: string;
  owner: string;
  disposition: string;
}

/** Pool queries also borrow, so a nested checkout cannot pass silently. */
class SingleConnectionRelay {
  readonly records = new Map<string, Reconciliation>();
  readonly items: ReconciliationItem[] = [];
  readonly cuts: unknown[][] = [];
  readonly queries: string[] = [];
  active = false;
  borrowCount = 0;
  releaseCount = 0;
  maximumBorrowed = 0;
  private snapshot?: { records: [string, Reconciliation][]; items: ReconciliationItem[]; cuts: unknown[][] };
  readonly client: PoolClient;
  readonly pool: Pool;

  constructor() {
    this.client = { query: (sql: string, values?: unknown[]) => this.query(sql, values ?? []),
      release: () => {
        if (!this.active || this.snapshot) throw new Error('relay client released with invalid lifecycle');
        this.active = false;
        this.releaseCount++;
      } } as unknown as PoolClient;
    this.pool = { connect: async () => {
      if (this.active) throw new Error('relay max=1 cannot lend a second client');
      this.active = true;
      this.borrowCount++;
      this.maximumBorrowed = 1;
      return this.client;
    }, query: async (sql: string, values?: unknown[]) => {
      const client = await this.pool.connect();
      try { return await client.query(sql, values); }
      finally { client.release(); }
    } } as unknown as Pool;
  }

  private async query(sql: string, values: unknown[]) {
    if (!this.active) throw new Error('relay query needs its borrowed client');
    this.queries.push(sql);
    if (sql === 'BEGIN') {
      if (this.snapshot) throw new Error('relay transaction was begun twice');
      this.snapshot = structuredClone({ records: [...this.records], items: this.items, cuts: this.cuts });
    } else if (sql === 'COMMIT') {
      if (!this.snapshot) throw new Error('relay commit needs a transaction');
      this.snapshot = undefined;
    } else if (sql === 'ROLLBACK') {
      if (!this.snapshot) throw new Error('relay rollback needs a transaction');
      this.records.clear();
      for (const [key, row] of this.snapshot.records) this.records.set(key, row);
      this.items.splice(0, this.items.length, ...this.snapshot.items);
      this.cuts.splice(0, this.cuts.length, ...this.snapshot.cuts);
      this.snapshot = undefined;
    } else if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: true }], rowCount: 1 };
    } else if (sql.includes('pg_advisory_unlock')) {
      return { rows: [], rowCount: 1 };
    } else if (sql.includes('FROM relay.recovery_coverage_head')) {
      return { rows: [{ generation: '7' }], rowCount: 1 };
    } else if (sql.includes('INSERT INTO relay.owner_reconciliation_item')) {
      if (!this.snapshot) throw new Error('reconciliation item needs a transaction');
      this.items.push({ reconciliation_id: String(values[0]), owner: String(values[1]),
        disposition: String(values[2]) });
    } else if (sql.includes('INSERT INTO relay.owner_reconciliation_cut')) {
      this.cuts.push(values);
    } else if (sql.includes('INSERT INTO relay.owner_reconciliation')) {
      const operationId = String(values[1]);
      if (this.records.has(operationId)) throw new Error('duplicate reconciliation operation');
      this.records.set(operationId, { id: String(values[0]), operation_id: operationId,
        request_digest: String(values[2]), kind: 'restore', scope: 'product', consumer: String(values[3]),
        state: 'running', hold_reason: null });
    } else if (sql.includes("UPDATE relay.owner_reconciliation SET state = 'held'")) {
      if (!this.snapshot) throw new Error('held outcome needs a transaction');
      const row = [...this.records.values()].find(record => record.id === values[0]);
      if (!row) throw new Error('reconciliation is missing');
      row.state = 'held';
      row.hold_reason = String(values[1]);
    } else if (sql.includes('FROM relay.owner_reconciliation_item')) {
      return { rows: this.items.filter(item => item.reconciliation_id === values[0]), rowCount: 1 };
    } else if (sql.includes('FROM relay.owner_reconciliation WHERE operation_id')) {
      const row = this.records.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    } else if (sql.includes('FROM relay.owner_reconciliation WHERE id')) {
      const row = [...this.records.values()].find(record => record.id === values[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    } else {
      throw new Error(`Unexpected relay SQL: ${sql}`);
    }
    return { rows: [], rowCount: 1 };
  }
}

class HeldGraph extends FusekiClient {
  held = true;
  readonly commands: CommandEnvelope[] = [];
  readonly queries: string[] = [];

  constructor() { super('http://localhost:1/product'); }

  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    return { boolean: this.held };
  }

  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    this.held = false;
    return { status: 'committed', position: { datasetId: 'urn:rezics:dataset:product',
      dataEpoch: lineage.dataEpoch, sequence: '0' } };
  }
}

function untouchedOwner(name: string) {
  const calls: string[] = [];
  return { calls, pool: { connect: async () => {
    calls.push('connect');
    throw new Error(`${name} must not be borrowed without retained erasure release`);
  }, query: async (sql: string) => {
    calls.push(sql);
    throw new Error(`${name} must stay untouched without retained erasure release`);
  } } as unknown as Pool };
}

function fixture(options: { capturedRelay?: boolean } = {}) {
  const relay = new SingleConnectionRelay();
  const fuseki = new HeldGraph();
  const account = untouchedOwner('Account');
  const access = untouchedOwner('Access');
  const content = untouchedOwner('Content');
  const capturedRelay = untouchedOwner('captured relay');
  const coverage: RecoveryCoverage = { priorDataEpoch, priorSequence: '900',
    accountPg: { systemIdentifier: '1001', flushedLsn: '0/1000', walFile: '000000010000000000000001' },
    account: { rowCount: '1', rowDigest: digest }, accessOutboxCount: '1', accessOutboxDigest: digest,
    accessStateCount: '1', accessStateDigest: digest,
    relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'default-restore', dataEpoch: priorDataEpoch,
      sequence: '4', batchCount: '4', batchDigest: digest, eventCount: '4', eventDigest: digest },
    commerce: { version: 1, tables: Object.fromEntries(['payment_provider', 'offering', 'offering_revision',
      'plan_group', 'plan', 'price', 'plan_benefit', 'subscription', 'quote', 'subscription_change',
      'receipt', 'settlement', 'provider_callback', 'reconciliation', 'settlement_event', 'entitlement',
      'entitlement_event', 'benefit_epoch'].map(table => [table, { count: '0', digest }])) as
        RecoveryCoverage['commerce']['tables'] },
    content: { version: 5, dataEpoch: 'content-epoch', sequence: '3', graphReferencesCount: '0',
      graphReferencesDigest: digest, catalogDigest: digest, tables: {}, excluded: {} },
    objects: { version: 1, referenceCount: '1', referenceDigest: digest, anchorCount: '1', anchorDigest: digest,
      objectCount: '1', objectDigest: digest } };
  const operations = new OwnerOperations(relay.pool, { fuseki, lineage,
    objectDirectory: '.temp/default-restore-objects' }, { accountPool: account.pool,
    accessPool: access.pool, contentPool: content.pool, hmacKey,
    objectStore: { directory: '.temp/default-restore-objects' },
    ...(options.capturedRelay ? { restoredRelayPool: capturedRelay.pool } : {}) });
  const authority = { active: true };
  const app = new Elysia().use(ownerRoutes({ ownerOperations: operations,
    account: { verify: async (request: Request, scopes: readonly string[]) => {
      expect(scopes).toEqual(['owner:operate']);
      if (request.headers.get('authorization') !== 'Bearer operator') throw new AccountAssertionDenied('denied');
      return { issuer: 'https://account.example.test', subject: 'operator' };
    } }, access: { activePrincipalId: async () => authority.active
      ? '00000000-0000-4000-8000-000000000003' : null },
  } as unknown as MainWorkDependencies));
  const body = { profile: 'owner-reconciliation-v1', kind: 'restore',
    sealedCoverage: JSON.stringify(sealRecoveryPayload(coverage, hmacKey, 'graph-recovery-coverage')),
    sealedDeletionSets: [] as string[] };
  const send = (key: string, bearer = 'operator', input = body) => app.handle(new Request(
    'http://localhost/v1/owners/reconciliations', { method: 'POST', headers: {
      authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'idempotency-key': key,
    }, body: JSON.stringify(input) }));
  return { relay, fuseki, account, access, content, capturedRelay, authority, body, send };
}

function expectOwnersHeld(run: ReturnType<typeof fixture>) {
  expect(run.fuseki.held).toBe(true);
  expect(run.fuseki.commands).toHaveLength(0);
  expect(run.fuseki.queries).toHaveLength(0);
  expect(run.account.calls).toHaveLength(0);
  expect(run.access.calls).toHaveLength(0);
  expect(run.content.calls).toHaveLength(0);
  expect(run.capturedRelay.calls).toHaveLength(0);
  expect(run.relay.cuts).toHaveLength(0);
  expect(run.relay.active).toBe(false);
}

test('authenticated default restore records unavailable erasure release as held before borrowing Access', async () => {
  const run = fixture();
  const response = await run.send('held-default');
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const view = await response.json() as { id: string };
  expect(view).toMatchObject({ profile: 'owner-reconciliation-v1', kind: 'restore', scope: 'product',
    state: 'held', disposition: 'unavailable', replayed: false });
  expect(run.relay.records.get('owner:reconcile:held-default')).toMatchObject({ id: view.id,
    state: 'held', hold_reason: 'retained erasure restore release is unavailable' });
  expect(run.relay.items).toEqual([{ reconciliation_id: view.id, owner: 'relay', disposition: 'unavailable' }]);
  expect(run.relay.borrowCount).toBe(1);
  expect(run.relay.maximumBorrowed).toBe(1);
  expect(run.relay.releaseCount).toBe(1);
  expectOwnersHeld(run);
});

test('a captured relay pool alone cannot enable default restore without retained erasure composition', async () => {
  const run = fixture({ capturedRelay: true });
  const response = await run.send('captured-without-erasures');
  expect(response.status).toBe(201);
  const view = await response.json() as { id: string };
  expect(view).toMatchObject({ kind: 'restore', scope: 'product', state: 'held',
    disposition: 'unavailable', replayed: false });
  expect(run.relay.records.get('owner:reconcile:captured-without-erasures')).toMatchObject({
    hold_reason: 'retained erasure restore release is unavailable' });
  expect(run.relay.items).toEqual([{ reconciliation_id: view.id, owner: 'relay', disposition: 'unavailable' }]);
  expectOwnersHeld(run);
});

test('default held restore retries preserve the recorded result and reject changed evidence on the same key', async () => {
  const run = fixture();
  const first = await run.send('stable-held');
  const original = await first.json() as { id: string };
  expect(first.status).toBe(201);
  const replay = await run.send('stable-held');
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...original, replayed: true });
  const mismatch = await run.send('stable-held', 'operator', { ...run.body, sealedDeletionSets: ['changed-proof'] });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ code: 'idempotency_conflict' });
  expect(run.relay.records.size).toBe(1);
  expect(run.relay.items).toEqual([{ reconciliation_id: original.id, owner: 'relay', disposition: 'unavailable' }]);
  expect(run.relay.borrowCount).toBe(3);
  expect(run.relay.releaseCount).toBe(3);
  expectOwnersHeld(run);
});

test('denied or inactive operators cannot enter default restore reconciliation', async () => {
  const run = fixture();
  expect((await run.send('denied-default', 'denied')).status).toBe(401);
  run.authority.active = false;
  expect((await run.send('inactive-default')).status).toBe(403);
  expect(run.relay.borrowCount).toBe(0);
  expect(run.relay.queries).toHaveLength(0);
  expect(run.relay.records.size).toBe(0);
  expect(run.relay.items).toHaveLength(0);
  expectOwnersHeld(run);
});

test('default restore route validates its schema before entering the owner operation', async () => {
  const run = fixture();
  const response = await run.send('invalid-default', 'operator', { ...run.body, kind: 'unknown-restore' });
  expect(response.status).toBe(422);
  expect(run.relay.borrowCount).toBe(0);
  expect(run.relay.records.size).toBe(0);
  expectOwnersHeld(run);
});
