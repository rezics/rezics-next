import { expect, spyOn, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import * as accountCoverage from '../../account/src/recovery-coverage.ts';
import { sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { FusekiClient, type CommandEnvelope, type CommandResult,
  type SparqlResult } from '../src/infrastructure/fuseki.ts';
import * as commerceCoverage from '../src/modules/commerce/recovery-coverage.ts';
import * as deletionJournal from '../src/modules/outbox/account-deletion-journal.ts';
import * as subjectDeletion from '../src/modules/outbox/account-subject-deletion.ts';
import * as coverageHead from '../src/modules/outbox/recovery-coverage-head.ts';
import * as relayCoverage from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import * as objectCoverage from '../src/modules/owner/object-coverage.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { DATASET, type GraphLineage } from '../src/modules/work/activate.ts';
import * as accessCoverage from '../src/modules/work/access-recovery-coverage.ts';
import * as contentCoverage from '../src/modules/work/content-recovery-coverage.ts';
import * as pgCoverage from '../src/modules/work/pg-recovery-frontier.ts';
import { releaseRestoredGraphHold, RestoreLineageConflict,
  type AuthenticatedRecoveryCoverage, type RecoveryCoverage } from '../src/modules/work/restore-lineage.ts';

const hmacKey = 'ab'.repeat(32);
const lineage: GraphLineage = { dataEpoch: '00000000-0000-4000-8000-000000000002', routingEpoch: '2' };
const priorDataEpoch = '00000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);
const ownerChecks = ['access-outbox', 'access-state', 'commerce', 'account-wal', 'account-rows',
  'account-subject-deletions', 'account-deletion-journal', 'account-deletion-evidence',
  'retained-relay', 'current-coverage-head', 'content', 'objects'] as const;
type OwnerCheck = typeof ownerChecks[number];
type ReleaseErasures = NonNullable<AuthenticatedRecoveryCoverage['releaseErasures']>;

/** Pool-level queries borrow too, so an accidental second checkout fails immediately. */
class SingleConnectionOwner {
  active = false;
  borrowCount = 0;
  releaseCount = 0;
  maximumBorrowed = 0;
  open = false;
  generation = '5';
  deletionMarkers: { principal_id: string; authority_epoch: string }[] = [];
  private transaction = false;
  private pendingOpen = false;
  private pendingGeneration = '5';
  readonly queries: { sql: string; values?: unknown[] }[] = [];
  readonly client: PoolClient;
  readonly pool: Pool;
  queryGate?: (sql: string) => Promise<void>;
  connectFailure?: Error;

  constructor(readonly name: string, private readonly trace: string[]) {
    this.client = { query: (sql: string, values?: unknown[]) => this.query(sql, values),
      release: () => {
        if (!this.active) throw new Error(`${this.name} client released twice`);
        this.active = false;
        this.releaseCount++;
      } } as unknown as PoolClient;
    this.pool = { connect: async () => {
      if (this.connectFailure) throw this.connectFailure;
      if (this.active) throw new Error(`${this.name} max=1 pool cannot lend a second client`);
      this.active = true;
      this.borrowCount++;
      this.maximumBorrowed = Math.max(this.maximumBorrowed, 1);
      return this.client;
    }, query: async (sql: string, values?: unknown[]) => {
      const client = await this.pool.connect();
      try { return await client.query(sql, values); }
      finally { client.release(); }
    } } as unknown as Pool;
  }

  private async query(sql: string, values?: unknown[]) {
    if (!this.active) throw new Error(`${this.name} query needs its borrowed client`);
    this.queries.push({ sql, values });
    await this.queryGate?.(sql);
    if (sql.startsWith('BEGIN')) {
      if (this.transaction) throw new Error(`${this.name} transaction was begun twice`);
      this.transaction = true;
      this.pendingOpen = this.open;
      this.pendingGeneration = this.generation;
    } else if (sql === 'COMMIT') {
      this.open = this.pendingOpen;
      this.generation = this.pendingGeneration;
      this.transaction = false;
      this.trace.push(`${this.name}:commit`);
    } else if (sql === 'ROLLBACK') {
      this.pendingOpen = this.open;
      this.pendingGeneration = this.generation;
      this.transaction = false;
      this.trace.push(`${this.name}:rollback`);
    } else if (sql.includes('UPDATE access.recovery_fence')) {
      if (!this.transaction || values?.[0] !== this.pendingGeneration || this.pendingOpen) {
        return { rows: [], rowCount: 0 };
      }
      this.pendingOpen = true;
      this.pendingGeneration = (BigInt(this.pendingGeneration) + 1n).toString();
      this.trace.push('access:open');
      return { rows: [], rowCount: 1 };
    } else if (sql.includes('FROM access.recovery_fence')) {
      if (this.pendingOpen) this.trace.push('access:verify-open');
      return { rows: [{ open: this.pendingOpen, generation: this.pendingGeneration }], rowCount: 1 };
    } else if (sql.includes("kind = 'account.deletion_fenced'")) {
      this.trace.push('validated:account-deletion-evidence');
      return { rows: this.deletionMarkers, rowCount: this.deletionMarkers.length };
    } else if (!sql.startsWith('SET ') && !sql.startsWith('SELECT ')) {
      throw new Error(`Unexpected ${this.name} SQL: ${sql}`);
    }
    return { rows: [], rowCount: 0 };
  }
}

type MaintenanceAttempt = 'restore' | 'erasure';
type MaintenanceLock = 'access-fence' | 'relay-allocator';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

class MaintenanceWaitCycle extends Error {
  constructor(readonly attempts: MaintenanceAttempt[]) {
    super(`synthetic maintenance waits-for cycle: ${attempts.join(' -> ')}`);
  }
}

/** Application-level waits span separate owner sessions; this is not PostgreSQL's detector. */
class MaintenanceLocks {
  readonly held = new Map<MaintenanceLock, MaintenanceAttempt>();
  readonly waiting = new Map<MaintenanceAttempt, {
    lock: MaintenanceLock; completion: ReturnType<typeof deferred<void>>;
  }>();
  readonly cycles: MaintenanceAttempt[][] = [];
  readonly events: string[] = [];
  private readonly observers = new Map<string, ReturnType<typeof deferred<void>>>();

  async acquire(attempt: MaintenanceAttempt, lock: MaintenanceLock): Promise<void> {
    const holder = this.held.get(lock);
    if (!holder || holder === attempt) {
      this.held.set(lock, attempt);
      this.events.push(`${attempt}:acquired:${lock}`);
      return;
    }
    const completion = deferred<void>();
    this.waiting.set(attempt, { lock, completion });
    this.events.push(`${attempt}:waiting:${lock}`);
    this.observers.get(`${attempt}:${lock}`)?.resolve();
    const path: MaintenanceAttempt[] = [attempt];
    let next: MaintenanceAttempt | undefined = holder;
    while (next) {
      path.push(next);
      if (next === attempt) {
        this.cycles.push(path);
        this.waiting.delete(attempt);
        completion.reject(new MaintenanceWaitCycle(path));
        break;
      }
      const request = this.waiting.get(next);
      next = request ? this.held.get(request.lock) : undefined;
    }
    await completion.promise;
  }

  whenWaiting(attempt: MaintenanceAttempt, lock: MaintenanceLock): Promise<void> {
    if (this.waiting.get(attempt)?.lock === lock) return Promise.resolve();
    const observer = deferred<void>();
    this.observers.set(`${attempt}:${lock}`, observer);
    return observer.promise;
  }

  release(attempt: MaintenanceAttempt, lock: MaintenanceLock): void {
    if (this.held.get(lock) !== attempt) return;
    this.held.delete(lock);
    this.events.push(`${attempt}:released:${lock}`);
    for (const [waitingAttempt, request] of this.waiting) {
      if (request.lock !== lock) continue;
      this.waiting.delete(waitingAttempt);
      this.held.set(lock, waitingAttempt);
      this.events.push(`${waitingAttempt}:acquired:${lock}`);
      request.completion.resolve();
      break;
    }
  }

  interrupt(attempt: MaintenanceAttempt): void {
    const request = this.waiting.get(attempt);
    if (!request) return;
    this.waiting.delete(attempt);
    request.completion.reject(new RestoreLineageConflict('interrupted maintenance lock wait'));
  }

  bind(owner: SingleConnectionOwner, attempt: MaintenanceAttempt, lock: MaintenanceLock): void {
    owner.queryGate = async sql => {
      if (lock === 'relay-allocator' && sql.includes('pg_advisory_xact_lock')) {
        await this.acquire(attempt, lock);
      } else if (lock === 'access-fence' && sql.includes('FROM access.recovery_fence')
        && sql.includes('FOR UPDATE')) {
        await this.acquire(attempt, lock);
      } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        this.release(attempt, lock);
      }
    };
  }
}

class HeldRestoreGraph extends FusekiClient {
  held = true;
  cutMatches = true;
  interruptRelease = false;
  loseReleaseResponse = false;
  denyAdmission = false;
  releaseReceipt: { receipt: string; digest: string } | null = null;
  readonly commands: CommandEnvelope[] = [];
  readonly queries: string[] = [];

  constructor(private readonly trace: string[]) { super('http://localhost:1/product'); }

  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    if (this.interruptRelease) throw new Error('interrupted before graph release');
    if (!this.cutMatches) return { status: 'guard-unmatched' };
    this.held = false;
    this.releaseReceipt = { receipt: envelope.receipt, digest: envelope.digest };
    this.trace.push('graph:release');
    if (this.loseReleaseResponse) throw new Error('lost committed graph release response');
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: lineage.dataEpoch, sequence: '0' } };
  }

  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (!sparql.includes('ASK')) throw new Error(`Unexpected restore graph query: ${sparql}`);
    if (sparql.includes('FILTER NOT EXISTS') && sparql.includes('rv:restoreHold true')) {
      if (!this.held) this.trace.push('graph:verify-open');
      let receiptMatches = true;
      if (sparql.includes('a rv:OperationReceipt')) {
        this.trace.push('graph:verify-release-receipt');
        receiptMatches = !!this.releaseReceipt
          && sparql.includes(`<${this.releaseReceipt.receipt}> a rv:OperationReceipt`)
          && sparql.includes(`rv:requestDigest "${this.releaseReceipt.digest}"`)
          && sparql.includes(`rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 0`);
      }
      return { boolean: !this.held && this.cutMatches && !this.denyAdmission && receiptMatches };
    }
    if (sparql.includes('rv:restoreHold true')) return { boolean: this.held && this.cutMatches };
    throw new Error(`Unexpected restore graph query: ${sparql}`);
  }
}

function fixture() {
  const trace: string[] = [];
  const access = new SingleConnectionOwner('access', trace);
  const relay = new SingleConnectionOwner('relay', trace);
  const account = new SingleConnectionOwner('account', trace);
  const content = new SingleConnectionOwner('content', trace);
  const fuseki = new HeldRestoreGraph(trace);
  const coverage: RecoveryCoverage = { priorDataEpoch, priorSequence: '41',
    accountPg: { systemIdentifier: '1001', flushedLsn: '0/1000', walFile: '000000010000000000000001' },
    account: { rowCount: '1', rowDigest: digest }, accessOutboxCount: '1', accessOutboxDigest: digest,
    accessStateCount: '1', accessStateDigest: digest,
    relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'restore-release', dataEpoch: priorDataEpoch,
      sequence: '41', batchCount: '41', batchDigest: digest, eventCount: '41', eventDigest: digest },
    commerce: { version: 1, tables: Object.fromEntries(['payment_provider', 'offering', 'offering_revision',
      'plan_group', 'plan', 'price', 'plan_benefit', 'subscription', 'quote', 'subscription_change',
      'receipt', 'settlement', 'provider_callback', 'reconciliation', 'settlement_event', 'entitlement',
      'entitlement_event', 'benefit_epoch'].map(table => [table, { count: '0', digest }])) as
        RecoveryCoverage['commerce']['tables'] },
    content: { version: 5, dataEpoch: 'content-epoch', sequence: '3', graphReferencesCount: '0',
      graphReferencesDigest: digest, catalogDigest: digest, tables: {}, excluded: {} },
    objects: { version: 1, referenceCount: '1', referenceDigest: digest, anchorCount: '1', anchorDigest: digest,
      objectCount: '1', objectDigest: digest } };
  const state = { failAt: undefined as OwnerCheck | undefined, callbackCalls: 0,
    historicalRoot: 'retired-model-root', historicalDigest: digest,
    journalGeneration: '11', authorityGeneration: '7', interruptEvidence: false,
    advanceJournalAfterChecks: false, advanceAuthorityAfterChecks: false };
  const validate = async (check: OwnerCheck, client?: PoolClient) => {
    if (client) await client.query(`SELECT 1 /* signed restore coverage: ${check} */`);
    trace.push(`validated:${check}`);
    if (state.failAt === check) throw new RestoreLineageConflict(`fixture rejected ${check}`);
  };
  const spies = [
    spyOn(accessCoverage, 'scanAccessOutbox').mockImplementation(async client => {
      expect(client).toBe(access.client);
      await validate('access-outbox', client);
      return { count: coverage.accessOutboxCount, digest: coverage.accessOutboxDigest };
    }),
    spyOn(accessCoverage, 'scanAccessState').mockImplementation(async client => {
      expect(client).toBe(access.client);
      await validate('access-state', client);
      return { count: coverage.accessStateCount, digest: coverage.accessStateDigest };
    }),
    spyOn(commerceCoverage, 'assertCommerceRecoveryCoverageOnClient').mockImplementation(async (client, retained) => {
      expect(client).toBe(access.client);
      expect(retained).toEqual(coverage.commerce);
      await validate('commerce', client);
    }),
    spyOn(pgCoverage, 'assertPgRecoveryFrontier').mockImplementation(async (pool, retained) => {
      expect(pool).toBe(account.pool);
      expect(retained).toEqual(coverage.accountPg);
      await validate('account-wal');
    }),
    spyOn(accountCoverage, 'assertAccountRecoveryCoverage').mockImplementation(async (pool, retained) => {
      expect(pool).toBe(account.pool);
      expect(retained).toEqual(coverage.account);
      await validate('account-rows');
    }),
    spyOn(subjectDeletion, 'assertAccountSubjectDeletionsAbsent').mockImplementation(async (pool, relayPool, client) => {
      expect(pool).toBe(account.pool);
      expect(relayPool).toBe(relay.pool);
      expect(client).toBe(relay.client);
      await validate('account-subject-deletions', client);
    }),
    spyOn(deletionJournal, 'assertAccountDeletionJournalCoverage').mockImplementation(
      async (accessPool, relayPool, accessClient, relayClient) => {
        expect(accessPool).toBe(access.pool);
        expect(relayPool).toBe(relay.pool);
        expect(accessClient).toBe(access.client);
        expect(relayClient).toBe(relay.client);
        await validate('account-deletion-journal', accessClient);
        await relayClient!.query('SELECT 1 /* retained deletion journal */');
      }),
    spyOn(relayCoverage, 'relayCoverageOnClient').mockImplementation(async (client, consumer) => {
      expect(consumer).toBe(coverage.relay.consumer);
      expect(client).toBe(relay.client);
      await validate('retained-relay', client);
      return coverage.relay;
    }),
    spyOn(coverageHead, 'assertCurrentRecoveryCoverageHead').mockImplementation(async (client, retained) => {
      expect(client).toBe(relay.client);
      expect(retained).toEqual(coverage);
      await validate('current-coverage-head', relay.client);
    }),
    spyOn(contentCoverage, 'assertContentRecoveryCoverage').mockImplementation(async (pool, graph, retained) => {
      expect(pool).toBe(content.pool);
      expect(graph).toBe(fuseki);
      expect(retained).toEqual(coverage.content!);
      await validate('content');
    }),
    spyOn(objectCoverage, 'assertObjectRecoveryCoverage').mockImplementation(async (graph, store, retained) => {
      expect(graph).toBe(fuseki);
      expect(store).toBe(evidence.objectStore!);
      expect(retained).toEqual(coverage.objects!);
      await validate('objects');
    }),
  ];

  // This callback exercises the release boundary. Actual erasure replay and
  // historical custody validation belong to the owner integration fixtures.
  const guardedRelease: ReleaseErasures = async ({ accessClient, relayClient, fenceGeneration }, releaseGraph) => {
    state.callbackCalls++;
    trace.push('erasure:enter');
    expect(accessClient).toBe(access.client);
    expect(relayClient).toBe(relay.client);
    expect(access.active).toBe(true);
    expect(relay.active).toBe(true);
    expect(fenceGeneration).toBe('5');
    expect(relay.queries.some(query => query.sql.includes('pg_advisory_xact_lock'))).toBe(true);
    for (const check of ownerChecks) expect(trace).toContain(`validated:${check}`);
    await accessClient.query('SELECT 1 /* current erasure authority */');
    await relayClient.query('SELECT 1 /* retained erasure journal */');
    if (!state.historicalRoot) throw new RestoreLineageConflict('historical custody root is missing');
    if (state.historicalDigest !== digest) throw new RestoreLineageConflict('historical custody root is corrupt');
    if (state.journalGeneration !== '11') throw new RestoreLineageConflict('retained erasure journal advanced');
    if (state.authorityGeneration !== '7') throw new RestoreLineageConflict('current authority advanced');
    trace.push('erasure:evidence-checked');
    if (state.interruptEvidence) throw new RestoreLineageConflict('interrupted erasure reconciliation');
    if (state.advanceJournalAfterChecks) state.journalGeneration = '12';
    if (state.advanceAuthorityAfterChecks) state.authorityGeneration = '8';
    if (state.journalGeneration !== '11' || state.authorityGeneration !== '7') {
      throw new RestoreLineageConflict('erasure release evidence became stale');
    }
    trace.push('erasure:current-evidence-checked');
    await releaseGraph();
    const opened = await accessClient.query(`UPDATE access.recovery_fence
      SET open = true, generation = generation + 1 WHERE id = true AND open = false AND generation = $1`,
    [fenceGeneration]);
    if (opened.rowCount !== 1) throw new RestoreLineageConflict('Access recovery fence changed');
  };
  const evidence: AuthenticatedRecoveryCoverage = {
    sealedCoverage: JSON.stringify(sealRecoveryPayload(coverage, hmacKey, 'graph-recovery-coverage')),
    hmacKey, accountPool: account.pool, contentPool: content.pool,
    objectStore: { directory: '.temp/unused-restore-release-objects' }, releaseErasures: guardedRelease,
  };
  return { access, relay, fuseki, coverage, state, trace, evidence,
    release: (client?: PoolClient) => releaseRestoredGraphHold(fuseki, access.pool, relay.pool, lineage, evidence, client),
    seal: () => { evidence.sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage, hmacKey, 'graph-recovery-coverage')); },
    stop: () => { for (const spy of spies) spy.mockRestore(); } };
}

function expectBothHeld(run: ReturnType<typeof fixture>) {
  expect(run.fuseki.held).toBe(true);
  expect(run.access.open).toBe(false);
  expect(run.access.generation).toBe('5');
  expect(run.trace).not.toContain('graph:release');
  expect(run.trace).not.toContain('access:open');
}

function contentionFixture(run: ReturnType<typeof fixture>) {
  const locks = new MaintenanceLocks();
  const erasureAccess = new SingleConnectionOwner('erasure-access', run.trace);
  const erasureRelay = new SingleConnectionOwner('erasure-relay', run.trace);
  locks.bind(run.access, 'restore', 'access-fence');
  locks.bind(run.relay, 'restore', 'relay-allocator');
  locks.bind(erasureAccess, 'erasure', 'access-fence');
  locks.bind(erasureRelay, 'erasure', 'relay-allocator');
  return { locks, erasureAccess, erasureRelay };
}

test('restore allocator contention leaves Access available to the competing erasure maintenance transaction', async () => {
  const run = fixture();
  const { locks, erasureAccess, erasureRelay } = contentionFixture(run);
  const erasureRelayClient = await erasureRelay.pool.connect();
  await erasureRelayClient.query('BEGIN');
  await erasureRelayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
  const restoring = run.release().then(() => ({ status: 'fulfilled' as const }),
    reason => ({ status: 'rejected' as const, reason }));
  try {
    await locks.whenWaiting('restore', 'relay-allocator');
    const erasureAccessClient = await erasureAccess.pool.connect();
    let accessCommitted = false;
    try {
      await erasureAccessClient.query('BEGIN');
      // If restore holds Access while waiting for this attempt's allocator,
      // this acquisition closes the actual waits-for cycle and throws.
      await erasureAccessClient.query('SELECT open FROM access.recovery_fence WHERE id = true FOR UPDATE');
      expect(locks.held.get('access-fence')).toBe('erasure');
      expect(locks.held.get('relay-allocator')).toBe('erasure');
      expect(run.access.active).toBe(false);
      await erasureAccessClient.query('COMMIT');
      accessCommitted = true;
    } finally {
      if (!accessCommitted) await erasureAccessClient.query('ROLLBACK');
      erasureAccessClient.release();
    }
    await erasureRelayClient.query('COMMIT');
    erasureRelayClient.release();
    expect(await restoring).toEqual({ status: 'fulfilled' });
    expect(locks.cycles).toEqual([]);
    expect(locks.events.indexOf('erasure:released:access-fence')).toBeLessThan(
      locks.events.indexOf('restore:acquired:relay-allocator'));
    expect(locks.events.indexOf('restore:acquired:relay-allocator')).toBeLessThan(
      locks.events.indexOf('restore:acquired:access-fence'));
    expect(locks.held.size).toBe(0);
    expect(locks.waiting.size).toBe(0);
    expect(run.access.open).toBe(true);
    expect(run.fuseki.held).toBe(false);
    for (const owner of [run.access, run.relay, erasureAccess, erasureRelay]) {
      expect(owner.borrowCount).toBe(1);
      expect(owner.maximumBorrowed).toBe(1);
      expect(owner.releaseCount).toBe(1);
    }
  } finally {
    locks.interrupt('restore');
    if (erasureRelay.active) {
      await erasureRelayClient.query('ROLLBACK');
      erasureRelayClient.release();
    }
    await restoring;
    run.stop();
  }
});

test('restore interrupted during allocator contention releases its relay client without borrowing Access', async () => {
  const run = fixture();
  const { locks, erasureRelay } = contentionFixture(run);
  const erasureRelayClient = await erasureRelay.pool.connect();
  await erasureRelayClient.query('BEGIN');
  await erasureRelayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
  const restoring = run.release().then(() => ({ status: 'fulfilled' as const }),
    reason => ({ status: 'rejected' as const, reason }));
  try {
    await locks.whenWaiting('restore', 'relay-allocator');
    locks.interrupt('restore');
    const outcome = await restoring;
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('interrupted restore unexpectedly completed');
    expect(outcome.reason).toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.state.callbackCalls).toBe(0);
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.access.borrowCount).toBe(0);
    expect(run.relay.borrowCount).toBe(1);
    expect(run.relay.releaseCount).toBe(1);
    expect(run.relay.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(locks.held.get('relay-allocator')).toBe('erasure');
    expect(locks.waiting.size).toBe(0);
    expect(locks.cycles).toEqual([]);
  } finally {
    locks.interrupt('restore');
    await erasureRelayClient.query('ROLLBACK');
    erasureRelayClient.release();
    await restoring;
    run.stop();
  }
  expect(locks.held.size).toBe(0);
});

test('restore Access connection failure releases the already-held relay allocator and client', async () => {
  const run = fixture();
  const { locks } = contentionFixture(run);
  const failure = new Error('restored Access owner is unavailable');
  run.access.connectFailure = failure;
  try {
    await expect(run.release()).rejects.toBe(failure);
    expectBothHeld(run);
    expect(run.state.callbackCalls).toBe(0);
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.access.borrowCount).toBe(0);
    expect(run.access.releaseCount).toBe(0);
    expect(run.relay.borrowCount).toBe(1);
    expect(run.relay.releaseCount).toBe(1);
    expect(run.relay.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(locks.events).toEqual(['restore:acquired:relay-allocator', 'restore:released:relay-allocator']);
    expect(locks.held.size).toBe(0);
    expect(locks.waiting.size).toBe(0);
  } finally { run.stop(); }
});

test('restore release requires explicit erasure/custody composition before either hold can open', async () => {
  const run = fixture();
  delete run.evidence.releaseErasures;
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.state.callbackCalls).toBe(0);
    expect(run.fuseki.commands).toHaveLength(0);
  } finally { run.stop(); }
});

test('restore release authenticates the signed coverage before entering erasure reconciliation', async () => {
  const run = fixture();
  const envelope = JSON.parse(run.evidence.sealedCoverage) as { mac: string };
  envelope.mac = '0'.repeat(64);
  run.evidence.sealedCoverage = JSON.stringify(envelope);
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.state.callbackCalls).toBe(0);
    expect(run.access.borrowCount).toBe(0);
    expect(run.relay.borrowCount).toBe(0);
  } finally { run.stop(); }
});

for (const check of ownerChecks.filter(check => check !== 'account-deletion-evidence')) {
  test(`restore release rejects stale ${check} coverage before erasure callback`, async () => {
    const run = fixture();
    run.state.failAt = check;
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      expectBothHeld(run);
      expect(run.state.callbackCalls).toBe(0);
      expect(run.fuseki.commands).toHaveLength(0);
      expect(run.access.active).toBe(false);
      expect(run.relay.active).toBe(false);
    } finally { run.stop(); }
  });
}

test('restore release refuses missing retained deletion evidence before erasure callback', async () => {
  const run = fixture();
  run.access.deletionMarkers = [{ principal_id: '00000000-0000-4000-8000-000000000003', authority_epoch: '7' }];
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.state.callbackCalls).toBe(0);
    expect(run.fuseki.commands).toHaveLength(0);
  } finally { run.stop(); }
});

test('restore release refuses a mismatched held graph cut before erasure callback', async () => {
  const run = fixture();
  run.fuseki.cutMatches = false;
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.state.callbackCalls).toBe(0);
    expect(run.fuseki.commands).toHaveLength(0);
  } finally { run.stop(); }
});

for (const missing of ['content-coverage', 'content-owner', 'immutable-object-owner'] as const) {
  test(`restore release refuses missing ${missing} before erasure callback`, async () => {
    const run = fixture();
    if (missing === 'content-coverage') { delete run.coverage.content; run.seal(); }
    if (missing === 'content-owner') delete run.evidence.contentPool;
    if (missing === 'immutable-object-owner') delete run.evidence.objectStore;
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      expectBothHeld(run);
      expect(run.state.callbackCalls).toBe(0);
      expect(run.fuseki.commands).toHaveLength(0);
    } finally { run.stop(); }
  });
}

for (const failure of ['missing-historical-root', 'corrupt-historical-root', 'new-erasure-journal',
  'new-authority', 'journal-after-checks', 'authority-after-checks', 'interrupted-reconciliation'] as const) {
  test(`restore release callback refusal for ${failure} preserves both holds`, async () => {
    const run = fixture();
    if (failure === 'missing-historical-root') run.state.historicalRoot = '';
    if (failure === 'corrupt-historical-root') run.state.historicalDigest = 'b'.repeat(64);
    if (failure === 'new-erasure-journal') run.state.journalGeneration = '12';
    if (failure === 'new-authority') run.state.authorityGeneration = '8';
    if (failure === 'journal-after-checks') run.state.advanceJournalAfterChecks = true;
    if (failure === 'authority-after-checks') run.state.advanceAuthorityAfterChecks = true;
    if (failure === 'interrupted-reconciliation') run.state.interruptEvidence = true;
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      expectBothHeld(run);
      expect(run.state.callbackCalls).toBe(1);
      expect(run.fuseki.commands).toHaveLength(0);
      expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
      expect(run.relay.queries.at(-1)?.sql).toBe('ROLLBACK');
      expect(run.access.releaseCount).toBe(1);
      expect(run.relay.releaseCount).toBe(1);
    } finally { run.stop(); }
  });
}

test('restore release composes evidence, graph release and Access opening on the same max-one clients', async () => {
  const run = fixture();
  try {
    await run.release();
    expect(run.fuseki.held).toBe(false);
    expect(run.access.open).toBe(true);
    expect(run.access.generation).toBe('6');
    expect(run.state.callbackCalls).toBe(1);
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.trace.indexOf('erasure:current-evidence-checked')).toBeLessThan(run.trace.indexOf('graph:release'));
    expect(run.trace.indexOf('graph:release')).toBeLessThan(run.trace.indexOf('access:open'));
    expect(run.trace.indexOf('access:open')).toBeLessThan(run.trace.indexOf('access:verify-open'));
    expect(run.trace).toContain('graph:verify-open');
    expect(run.access.borrowCount).toBe(1);
    expect(run.relay.borrowCount).toBe(1);
    expect(run.access.maximumBorrowed).toBe(1);
    expect(run.relay.maximumBorrowed).toBe(1);
    expect(run.access.releaseCount).toBe(1);
    expect(run.relay.releaseCount).toBe(1);
  } finally { run.stop(); }
});

test('restore release reuses a caller-held relay client and leaves its release to the caller', async () => {
  const run = fixture();
  const client = await run.relay.pool.connect();
  try {
    await run.release(client);
    expect(run.access.open).toBe(true);
    expect(run.fuseki.held).toBe(false);
    expect(run.relay.borrowCount).toBe(1);
    expect(run.relay.releaseCount).toBe(0);
    expect(run.relay.active).toBe(true);
    expect(run.relay.queries.at(-1)?.sql).toBe('COMMIT');
  } finally { client.release(); run.stop(); }
});

test('restore release rejects a callback that returns without releasing either hold', async () => {
  const run = fixture();
  run.evidence.releaseErasures = async () => { run.state.callbackCalls++; };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.state.callbackCalls).toBe(1);
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

test('restore release rolls back Access if a callback opens it without invoking graph release', async () => {
  const run = fixture();
  run.evidence.releaseErasures = async ({ accessClient, fenceGeneration }) => {
    await accessClient.query(`UPDATE access.recovery_fence SET open = true, generation = generation + 1
      WHERE id = true AND open = false AND generation = $1`, [fenceGeneration]);
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(run.fuseki.held).toBe(true);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

test('restore release refuses Access opening before native graph release and rolls it back', async () => {
  const run = fixture();
  run.evidence.releaseErasures = async ({ accessClient, fenceGeneration }, releaseGraph) => {
    await accessClient.query(`UPDATE access.recovery_fence SET open = true, generation = generation + 1
      WHERE id = true AND open = false AND generation = $1`, [fenceGeneration]);
    await releaseGraph();
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(run.fuseki.held).toBe(true);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.trace).not.toContain('graph:release');
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

test('restore release rechecks actual graph hold after a callback opens Access', async () => {
  const run = fixture();
  run.evidence.releaseErasures = async ({ accessClient, fenceGeneration }, releaseGraph) => {
    await releaseGraph();
    run.fuseki.held = true;
    await accessClient.query(`UPDATE access.recovery_fence SET open = true, generation = generation + 1
      WHERE id = true AND open = false AND generation = $1`, [fenceGeneration]);
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(run.fuseki.held).toBe(true);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

test('restore release interruption before native graph release keeps Access and graph held', async () => {
  const run = fixture();
  run.fuseki.interruptRelease = true;
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

test('restore release cannot use an ordinary cached search position as graph release proof', async () => {
  const run = fixture();
  run.fuseki.interruptRelease = true;
  try {
    await expect(searchGraphSnapshot.run({ clients: new Set([run.fuseki]), lineage,
      position: { dataEpoch: lineage.dataEpoch, sequence: '0', generation: 'cached-search-generation',
        population: 1, serverInstanceId: '00000000-0000-4000-8000-000000000010', publicSearchWriteEpoch: '0' } },
    () => run.release())).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.fuseki.queries.some(query => query.includes('FILTER NOT EXISTS')
      && query.includes('a rv:OperationReceipt'))).toBe(true);
  } finally { run.stop(); }
});

test('restore release resolves a lost graph command response from uncached committed graph proof', async () => {
  const run = fixture();
  run.fuseki.loseReleaseResponse = true;
  try {
    await run.release();
    expect(run.fuseki.held).toBe(false);
    expect(run.access.open).toBe(true);
    expect(run.access.generation).toBe('6');
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.trace.indexOf('graph:release')).toBeLessThan(run.trace.indexOf('graph:verify-open'));
    expect(run.trace.indexOf('graph:verify-open')).toBeLessThan(run.trace.indexOf('access:open'));
  } finally { run.stop(); }
});

test('restore release retries partial graph release only after rechecking base and current erasure evidence', async () => {
  const run = fixture();
  const guardedRelease = run.evidence.releaseErasures!;
  run.evidence.releaseErasures = async (_clients, releaseGraph) => {
    await releaseGraph();
    throw new RestoreLineageConflict('interrupted after graph release before Access opening');
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(run.fuseki.held).toBe(false);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
    run.evidence.releaseErasures = guardedRelease;
    await run.release();
    expect(run.access.open).toBe(true);
    expect(run.access.generation).toBe('6');
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.trace).toContain('graph:verify-release-receipt');
    for (const check of ownerChecks) {
      expect(run.trace.filter(item => item === `validated:${check}`)).toHaveLength(2);
    }
    expect(run.access.borrowCount).toBe(2);
    expect(run.relay.borrowCount).toBe(2);
    expect(run.access.maximumBorrowed).toBe(1);
    expect(run.relay.maximumBorrowed).toBe(1);
  } finally { run.stop(); }
});

test('restore release retry with new retained erasure evidence leaves Access admission closed', async () => {
  const run = fixture();
  const guardedRelease = run.evidence.releaseErasures!;
  run.evidence.releaseErasures = async (_clients, releaseGraph) => {
    await releaseGraph();
    throw new RestoreLineageConflict('interrupted after graph release before Access opening');
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    run.state.journalGeneration = '12';
    run.evidence.releaseErasures = guardedRelease;
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
    expect(run.fuseki.held).toBe(false);
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.trace).not.toContain('access:open');
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

for (const failure of ['missing', 'mismatched'] as const) {
  test(`restore release retry requires exact release receipt with ${failure} proof`, async () => {
    const run = fixture();
    const guardedRelease = run.evidence.releaseErasures!;
    run.evidence.releaseErasures = async (_clients, releaseGraph) => {
      await releaseGraph();
      throw new RestoreLineageConflict('interrupted after graph release before Access opening');
    };
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      if (failure === 'missing') run.fuseki.releaseReceipt = null;
      else run.fuseki.releaseReceipt!.digest = 'b'.repeat(64);
      run.evidence.releaseErasures = guardedRelease;
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      expect(run.state.callbackCalls).toBe(0);
      expect(run.access.open).toBe(false);
      expect(run.access.generation).toBe('5');
      expect(run.fuseki.commands).toHaveLength(1);
      expect(run.trace).not.toContain('access:open');
    } finally { run.stop(); }
  });
}
