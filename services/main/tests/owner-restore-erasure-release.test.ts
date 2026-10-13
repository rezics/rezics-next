import { expect, spyOn, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { Pool as PgPool } from 'pg';
import * as accountCoverage from '../../account/src/recovery-coverage.ts';
import * as deletionRecovery from '../../account/src/deletion-recovery-set.ts';
import { sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { CommandOutcomeUnknown, FusekiClient, FusekiHttpError, type CommandEnvelope, type CommandResult,
  type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectUnavailable, S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { DRIVER_TRANSPORT_FAILURES } from '../src/infrastructure/owner-failure.ts';
import { COMMAND_MODULE_VERSION } from '../src/infrastructure/profile.ts';
import * as commerceCoverage from '../src/modules/commerce/recovery-coverage.ts';
import * as erasureAuthority from '../src/modules/erasure/authority.ts';
import * as deletionJournal from '../src/modules/outbox/account-deletion-journal.ts';
import * as subjectDeletion from '../src/modules/outbox/account-subject-deletion.ts';
import * as coverageHead from '../src/modules/outbox/recovery-coverage-head.ts';
import * as relayCoverage from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import * as objectCoverage from '../src/modules/owner/object-coverage.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { DATASET, hash, type GraphLineage } from '../src/modules/work/activate.ts';
import * as accessCoverage from '../src/modules/work/access-recovery-coverage.ts';
import * as contentCoverage from '../src/modules/work/content-recovery-coverage.ts';
import * as pgCoverage from '../src/modules/work/pg-recovery-frontier.ts';
import * as restoreLineage from '../src/modules/work/restore-lineage.ts';
import * as restoreBinding from '../src/modules/owner/restore-release-binding.ts';
import * as erasureReconciliation from '../src/modules/erasure/reconcile.ts';
import * as accessErasureRecovery from '../src/modules/access/erasure-recovery.ts';
import * as coreJournalCoverage from '../src/modules/erasure/core-journal-coverage.ts';
import * as ownerFrontier from '../src/modules/work/pg-recovery-frontier.ts';
import { createHash } from 'node:crypto';
import { OwnerOperations, OwnerOperationUnavailable } from '../src/modules/owner/operations.ts';
import { readExactModelGeneration } from '../src/modules/semantic/model-custody.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { releaseRestoredGraphHold, RestoreInterrupted, RestoreLineageConflict,
  type AuthenticatedRecoveryCoverage, type RecoveryCoverage } from '../src/modules/work/restore-lineage.ts';

const hmacKey = 'ab'.repeat(32);
const lineage: GraphLineage = { dataEpoch: '00000000-0000-4000-8000-000000000002', routingEpoch: '2' };
const priorDataEpoch = '00000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);
const ownerChecks = ['access-outbox', 'access-state', 'commerce', 'account-wal', 'account-rows',
  'account-subject-deletions', 'account-deletion-journal', 'account-deletion-evidence',
  'captured-relay', 'current-coverage-head', 'content', 'objects'] as const;
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
  deliveringSearch = false;
  deliveringDownload = false;
  checkpoint?: { stream_scope: string; data_epoch: string; sequence: string };
  private transaction = false;
  private isolation = 'read committed';
  private transactionSequence = 0n;
  private transactionId = '0';
  private pendingOpen = false;
  private pendingGeneration = '5';
  readonly queries: { sql: string; values?: unknown[] }[] = [];
  readonly client: PoolClient;
  readonly pool: Pool;
  queryGate?: (sql: string) => Promise<void>;
  connectFailure?: Error;

  get transactionOpen(): boolean { return this.transaction; }

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
      this.isolation = sql.includes('REPEATABLE READ') ? 'repeatable read' : 'read committed';
      this.transactionId = (++this.transactionSequence).toString();
      this.pendingOpen = this.open;
      this.pendingGeneration = this.generation;
    } else if (sql === 'COMMIT') {
      if (!this.transaction) throw new Error(`${this.name} commit needs a transaction`);
      this.open = this.pendingOpen;
      this.generation = this.pendingGeneration;
      this.transaction = false;
      this.trace.push(`${this.name}:commit`);
    } else if (sql === 'ROLLBACK') {
      this.pendingOpen = this.open;
      this.pendingGeneration = this.generation;
      this.transaction = false;
      this.trace.push(`${this.name}:rollback`);
    } else if (sql === 'SHOW transaction_isolation') {
      return { rows: [{ transaction_isolation: this.isolation }], rowCount: 1 };
    } else if (sql === 'SELECT txid_current()::text AS id') {
      const id = this.transaction ? this.transactionId : (++this.transactionSequence).toString();
      return { rows: [{ id }], rowCount: 1 };
    } else if (sql.includes('UPDATE access.recovery_fence')) {
      if (!this.transaction || values?.[0] !== this.pendingGeneration || this.pendingOpen
        || this.deliveringSearch || this.deliveringDownload) {
        return { rows: [], rowCount: 0 };
      }
      this.pendingOpen = true;
      this.pendingGeneration = (BigInt(this.pendingGeneration) + 1n).toString();
      this.trace.push('access:open');
      return { rows: [], rowCount: 1 };
    } else if (sql.includes('FROM access.search_read_lease') || sql.includes('FROM access.download_read_lease')) {
      this.trace.push('access:delivery-veto');
      const delivering = sql.includes('FROM access.search_read_lease') && this.deliveringSearch
        || sql.includes('FROM access.download_read_lease') && this.deliveringDownload;
      return { rows: delivering ? [{ delivering: true }] : [], rowCount: delivering ? 1 : 0 };
    } else if (sql.includes('FROM access.recovery_fence')) {
      if (this.pendingOpen) this.trace.push('access:verify-open');
      return { rows: [{ open: this.pendingOpen, generation: this.pendingGeneration }], rowCount: 1 };
    } else if (sql.includes("kind = 'account.deletion_fenced'")) {
      this.trace.push('validated:account-deletion-evidence');
      return { rows: this.deletionMarkers, rowCount: this.deletionMarkers.length };
    } else if (sql.includes('FROM relay.checkpoint')) {
      return { rows: this.checkpoint ? [this.checkpoint] : [], rowCount: this.checkpoint ? 1 : 0 };
    } else if (sql.includes('current_database() AS database')) {
      return { rows: [{ database: this.name, instance: '1' }], rowCount: 1 };
    } else if (!sql.startsWith('SET ') && !sql.startsWith('SELECT ')
      && !sql.startsWith('SAVEPOINT ') && !sql.startsWith('ROLLBACK TO SAVEPOINT ')
      && !sql.startsWith('RELEASE SAVEPOINT ')) {
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
  receiptAwareRelease = false;
  commandFailure?: CommandOutcomeUnknown;
  denyAdmission = false;
  priorSequence = '900';
  savedMainSequence: string | undefined = '4';
  reconciledMainSequence?: string;
  mainCutRows?: NonNullable<SparqlResult['results']>['bindings'];
  releaseReceipt: { receipt: string; digest: string; priorMainSequence?: string; streamScope?: string } | null = null;
  receiptLookups = 0;
  releaseEffects = 0;
  readonly commands: CommandEnvelope[] = [];
  readonly queries: string[] = [];

  constructor(private readonly trace: string[]) { super('http://localhost:1/product'); }

  override async command(envelope: CommandEnvelope): Promise<CommandResult> {
    return this.applyReleaseCommand(envelope);
  }

  override async commandWithReceipt(envelope: CommandEnvelope): Promise<CommandResult> {
    if (this.receiptAwareRelease) return super.commandWithReceipt(envelope);
    return this.applyReleaseCommand(envelope);
  }

  private async applyReleaseCommand(envelope: CommandEnvelope): Promise<CommandResult> {
    this.commands.push(envelope);
    if (this.interruptRelease) throw new Error('interrupted before graph release');
    if (this.commandFailure) {
      const failure = this.commandFailure;
      this.commandFailure = undefined;
      throw failure;
    }
    if (!this.cutMatches || !this.cutGuardsMatch(envelope.update)) return { status: 'guard-unmatched' };
    this.held = false;
    this.releaseEffects++;
    this.releaseReceipt = { receipt: envelope.receipt, digest: envelope.digest,
      priorMainSequence: /rv:priorMainSequence ([0-9]+)/.exec(envelope.update)?.[1],
      streamScope: /rv:streamScope "([^"]+)"/.exec(envelope.update)?.[1] };
    this.trace.push('graph:release');
    if (this.loseReleaseResponse) throw new Error('lost committed graph release response');
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: lineage.dataEpoch, sequence: '0' } };
  }

  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?digest ?dataset ?epoch ?sequence')) {
      this.receiptLookups++;
      return { results: { bindings: [] } };
    }
    if (sparql.includes('SELECT ?savedMainSequence ?reconciledMainSequence ?savedSequence')) {
      if (!this.cutMatches) return { results: { bindings: [] } };
      const row: Record<string, { type: 'literal'; value: string }> = {
        savedSequence: { type: 'literal', value: this.priorSequence } };
      if (this.savedMainSequence !== undefined) row.savedMainSequence = { type: 'literal', value: this.savedMainSequence };
      if (this.reconciledMainSequence !== undefined) row.reconciledMainSequence = {
        type: 'literal', value: this.reconciledMainSequence };
      return { results: { bindings: this.mainCutRows ?? [row] } };
    }
    if (!sparql.includes('ASK')) throw new Error(`Unexpected restore graph query: ${sparql}`);
    if (sparql.includes(`FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true }`)) {
      if (!this.held) this.trace.push('graph:verify-open');
      let receiptMatches = true;
      if (sparql.includes('a rv:OperationReceipt')) {
        this.trace.push('graph:verify-release-receipt');
        receiptMatches = !!this.releaseReceipt
          && sparql.includes(`<${this.releaseReceipt.receipt}> a rv:OperationReceipt`)
          && sparql.includes(`rv:requestDigest "${this.releaseReceipt.digest}"`)
          && sparql.includes(`rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 0`)
          && (this.releaseReceipt.priorMainSequence === undefined
            ? !/rv:priorMainSequence [0-9]+/.test(sparql)
            : sparql.includes(`rv:priorMainSequence ${this.releaseReceipt.priorMainSequence}`)
              && sparql.includes(`rv:streamScope "${this.releaseReceipt.streamScope}"`));
      }
      return { boolean: !this.held && this.cutMatches && this.cutGuardsMatch(sparql)
        && !this.denyAdmission && receiptMatches };
    }
    if (sparql.includes('rv:restoreHold true')) return { boolean: this.held && this.cutMatches && this.cutGuardsMatch(sparql) };
    throw new Error(`Unexpected restore graph query: ${sparql}`);
  }

  private cutGuardsMatch(sparql: string): boolean {
    const diagnostic = /COALESCE\(\?reconciledSequence, \?savedSequence\) = ([0-9]+)/.exec(sparql)?.[1];
    if (diagnostic !== this.priorSequence) return false;
    const main = /COALESCE\(\?reconciledMainSequence, \?savedMainSequence\) = ([0-9]+)/.exec(sparql)?.[1];
    if (main !== undefined) return this.savedMainSequence !== undefined
      && (this.reconciledMainSequence ?? this.savedMainSequence) === main;
    return this.savedMainSequence === undefined && this.reconciledMainSequence === undefined;
  }
}

function fixture(options: { actualCapturedRelay?: boolean } = {}) {
  const trace: string[] = [];
  const access = new SingleConnectionOwner('access', trace);
  const relay = new SingleConnectionOwner('relay', trace);
  const capturedRelay = new SingleConnectionOwner('captured-relay', trace);
  const account = new SingleConnectionOwner('account', trace);
  const content = new SingleConnectionOwner('content', trace);
  const fuseki = new HeldRestoreGraph(trace);
  const coverage: RecoveryCoverage = { priorDataEpoch, priorSequence: '900',
    accountPg: { systemIdentifier: '1001', flushedLsn: '0/1000', walFile: '000000010000000000000001' },
    account: { rowCount: '1', rowDigest: digest }, accessOutboxCount: '1', accessOutboxDigest: digest,
    accessStateCount: '1', accessStateDigest: digest,
    relay: { streamScope: MAIN_RELAY_STREAM_SCOPE, consumer: 'restore-release', dataEpoch: priorDataEpoch,
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
  if (options.actualCapturedRelay) {
    coverage.relay = { ...coverage.relay, sequence: '0', batchCount: '0', batchDigest: hash(''),
      eventCount: '0', eventDigest: hash('') };
    capturedRelay.checkpoint = { stream_scope: MAIN_RELAY_STREAM_SCOPE, data_epoch: priorDataEpoch, sequence: '0' };
    fuseki.savedMainSequence = '0';
  }
  const state = { failAt: undefined as OwnerCheck | undefined, failError: undefined as Error | undefined, callbackCalls: 0,
    historicalRoot: 'retired-model-root', historicalDigest: digest,
    journalGeneration: '11', authorityGeneration: '7', interruptEvidence: false,
    advanceJournalAfterChecks: false, advanceAuthorityAfterChecks: false };
  const validate = async (check: OwnerCheck, client?: PoolClient) => {
    if (client) await client.query(`SELECT 1 /* signed restore coverage: ${check} */`);
    trace.push(`validated:${check}`);
    if (state.failAt === check) throw state.failError ?? new RestoreLineageConflict(`fixture rejected ${check}`);
  };
  const spies = [
    spyOn(accessCoverage, 'resetAccessRecoveryState').mockImplementation(async (client, floors) => {
      expect(client).toBe(access.client);
      expect(floors).toEqual(coverage.accessLeaseEpochs ?? { derivedGeneration: '0', discoveryRefresh: '0' });
      expect(access.active).toBe(true);
      expect(access.transactionOpen).toBe(true);
      expect(access.open).toBe(false);
    }),
    spyOn(accessCoverage, 'scanAccessOutbox').mockImplementation(async client => {
      expect(client).toBe(access.client);
      await validate('access-outbox', client);
      return { count: coverage.accessOutboxCount, digest: coverage.accessOutboxDigest };
    }),
    spyOn(accessCoverage, 'scanAccessState').mockImplementation(async (client, profile) => {
      expect(client).toBe(access.client);
      expect(profile).toBe(coverage.accessStateProfile ?? 'access-state-v5');
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
    ...(options.actualCapturedRelay ? [] : [spyOn(relayCoverage, 'relayCoverageOnClient').mockImplementation(async (client, consumer) => {
      expect(client).toBe(capturedRelay.client);
      expect(consumer).toBe(coverage.relay.consumer);
      expect(capturedRelay.transactionOpen).toBe(true);
      await validate('captured-relay', client);
      return coverage.relay;
    })]),
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
    expect(relay.transactionOpen).toBe(true);
    expect(fenceGeneration).toBe('5');
    const transactionStart = relay.queries.map(query => query.sql.startsWith('BEGIN')).lastIndexOf(true);
    const currentTransaction = relay.queries.slice(transactionStart);
    expect(currentTransaction[0]?.sql).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(currentTransaction.some(query => query.sql === 'COMMIT' || query.sql === 'ROLLBACK')).toBe(false);
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
    hmacKey, accountPool: account.pool, contentPool: content.pool, restoredRelayPool: capturedRelay.pool,
    objectStore: { directory: '.temp/unused-restore-release-objects' }, releaseErasures: guardedRelease,
  };
  return { access, relay, capturedRelay, fuseki, coverage, state, trace, evidence,
    release: (client?: PoolClient, accessClient?: PoolClient) => releaseRestoredGraphHold(
      fuseki, access.pool, relay.pool, lineage, evidence, client, accessClient),
    seal: () => { evidence.sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage, hmacKey, 'graph-recovery-coverage')); },
    stop: () => { for (const spy of spies) spy.mockRestore(); } };
}

function seedRetainedModelCustody(objects: Map<string, Uint8Array>, store: S3ImmutableObjects, custodyId: string) {
  const shape = Buffer.from(`@prefix rv: <https://rezics.com/vocab/> .\n# ${custodyId}\n`);
  const shapeDigest = hash(shape);
  const manifest = Buffer.from(JSON.stringify({ commandModule: COMMAND_MODULE_VERSION,
    profiles: [{ id: 'owner-test', sha256: shapeDigest, file: 'shapes/owner-test.ttl' }] }));
  const manifestDigest = hash(manifest);
  const generation = `urn:rezics:model-generation:${manifestDigest}`;
  const payload = Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component: generation,
    state: { modelManifestSha256: manifestDigest, commandModule: COMMAND_MODULE_VERSION, entailment: 'none' } }));
  const payloadDigest = hash(payload);
  const componentManifest = Buffer.from(JSON.stringify({ format: 'rezics-manifest-v1', component: generation,
    payload: `sha256:${payloadDigest}`, payloadBytes: payload.length, mediaType: 'application/json',
    model: PROFILES.generation, shape: PROFILES.generation }));
  const componentManifestDigest = hash(componentManifest);
  objects.set(shapeDigest, shape);
  objects.set(manifestDigest, manifest);
  objects.set(payloadDigest, payload);
  objects.set(componentManifestDigest, componentManifest);
  const graph = { async query(): Promise<SparqlResult> { return { results: { bindings: [{
    manifest: { type: 'literal', value: `urn:rezics:sha256:${componentManifestDigest}` },
    commandModule: { type: 'literal', value: COMMAND_MODULE_VERSION },
  }] } }; } } as unknown as FusekiClient;
  const environment: WorkActivationEnvironment = { fuseki: graph, lineage,
    objectDirectory: '/nonexistent-retained-model-custody', workObjects: store };
  return { environment, generation, manifestDigest };
}

function expectBothHeld(run: ReturnType<typeof fixture>) {
  expect(run.fuseki.held).toBe(true);
  expect(run.access.open).toBe(false);
  expect(run.access.generation).toBe('5');
  expect(run.trace).not.toContain('graph:release');
  expect(run.trace).not.toContain('access:open');
}

/** Exercise the real outer operation with an in-memory relay record, while the
 * existing release fixture supplies the independently held owner transactions.
 * Only the composed erasure callback is a seam; error handling and same-key
 * settlement run through OwnerOperations and the real release helper. */
function outerRestore(run: ReturnType<typeof fixture>, borrowedOwners = false, completion = false,
  retained?: RecoveryCoverage) {
  const row = { id: '', request_digest: '', kind: 'restore', scope: 'product',
    state: 'running', hold_reason: null as string | null };
  let disposition: string | null = null;
  let durable = false;
  let qualifications = 0;
  let resumeReads = 0;
  const failures = { resume: undefined as Error | undefined, outcome: undefined as Error | undefined,
    record: undefined as Error | undefined, closure: undefined as Error | undefined };
  const completionSpies = completion ? [
    spyOn(restoreBinding, 'readBindings').mockImplementation(async () => {
      if (durable) {
        resumeReads++;
        if (failures.resume) throw failures.resume;
      }
      return { qualification: durable ? 'retained-qualification' : null,
        release: run.access.open ? 'retained-release' : null };
    }),
    spyOn(restoreBinding, 'readErasuresRecord').mockImplementation(async (_client, operation) => {
      if (failures.record) throw failures.record;
      expect(operation).toBe('owner:reconcile:qualified-owner-retry:erasures');
      return { id: 'retained-erasures', consumer: run.coverage.relay.consumer,
        requestDigest: digest, outcomeDigest: digest, coverageGeneration: '7',
        erasureEpoch: null, items: 0, cuts: digest };
    }),
    spyOn(erasureReconciliation, 'assertReleasedErasuresCurrent').mockImplementation(
      async (_relay, owners, record, captured, _authority, clients, outerId) => {
        if (failures.closure) throw failures.closure;
        expect(record).toBe('retained-erasures');
        expect(captured).toBe('5');
        expect(outerId).toBe(row.id);
        expect(owners.graph?.heldErasure?.cut.priorSequence).toBe('900');
        expect(clients.graphRelease.saved.main?.sequence).toBe('4');
        expect(run.access.open).toBe(true);
        expect(run.fuseki.held).toBe(false);
      }),
  ] : [];
  const query = run.relay.client.query.bind(run.relay.client);
  const relaySpy = spyOn(run.relay.client, 'query').mockImplementation((async (sql: string, values: unknown[] = []) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes('FROM relay.recovery_coverage_head')) return { rows: [{ generation: '7' }], rowCount: 1 };
    if (sql.includes('FROM relay.owner_reconciliation_item')) {
      return { rows: disposition ? [{ disposition }] : [], rowCount: disposition ? 1 : 0 };
    }
    if (sql.includes('FROM relay.owner_reconciliation WHERE')) return { rows: row.id ? [row] : [], rowCount: row.id ? 1 : 0 };
    if (sql.includes('INSERT INTO relay.owner_reconciliation_item')) {
      disposition = sql.includes("'matched'") ? 'matched' : String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO relay.owner_reconciliation_cut')) {
      if (failures.outcome) throw failures.outcome;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO relay.owner_reconciliation')) {
      row.id = String(values[0]); row.request_digest = String(values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE relay.owner_reconciliation SET state')) {
      row.state = sql.includes("'held'") ? 'held' : 'reconciled';
      row.hold_reason = row.state === 'held' ? String(values[1]) : null;
      return { rows: [], rowCount: 1 };
    }
    return await query(sql, values);
  }) as typeof run.relay.client.query);
  const actualRelease = restoreLineage.releaseRestoredGraphHold;
  const releaseSpy = spyOn(restoreLineage, 'releaseRestoredGraphHold').mockImplementation(
    async (graph, access, relay, actualLineage, evidence, client) => {
      expect(evidence.sealedCoverage).toBe(run.evidence.sealedCoverage);
      if (!borrowedOwners || !run.evidence.qualification?.resume) {
        await actualRelease(graph, access, relay, actualLineage, run.evidence, client);
        return;
      }
      const accessClient = await access.connect();
      try {
        await client!.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await accessClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await actualRelease(graph, access, relay, actualLineage, run.evidence, client, accessClient);
        await client!.query('COMMIT'); await accessClient.query('COMMIT');
      } catch (error) {
        await client!.query('ROLLBACK'); await accessClient.query('ROLLBACK');
        throw error;
      } finally { accessClient.release(); }
    });
  const operations = new OwnerOperations(run.relay.pool,
    { fuseki: run.fuseki, lineage, objectDirectory: '.temp/unused-restore-release-objects' } as WorkActivationEnvironment, {
      accountPool: run.evidence.accountPool, accessPool: run.access.pool,
      contentPool: run.evidence.contentPool!, hmacKey, objectStore: run.evidence.objectStore!,
      restoredRelayPool: run.capturedRelay.pool,
      ...(retained ? { nativeAccessAttachment: async function* () { yield 'native-custody'; } } : {}),
      ...(completion ? { erasures: {
        authority: { sealedCoverage: retained
          ? JSON.stringify(sealRecoveryPayload(retained, hmacKey, 'graph-recovery-coverage'))
          : run.evidence.sealedCoverage, hmacKey },
        signingKey: hmacKey, maintenance: run.fuseki,
        originalSource: 'retained-native-event' as const,
      } } : {}),
    });
  const key = 'qualified-owner-retry';
  const attempt = () => {
    run.evidence.qualification = { resume: durable, authenticateResume: async () => {
      expect(qualifications).toBe(1);
    } };
    return operations.reconcileRestore({ sealedCoverage: run.evidence.sealedCoverage, sealedDeletionSets: [] }, key);
  };
  return { row, attempt, releaseSpy, failures, get qualifications() { return qualifications; },
    get resumeReads() { return resumeReads; },
    qualify: async () => {
      run.evidence.releaseErasures = async clients => {
        await clients.relayClient.query('SELECT 1 /* retained qualification */');
        await clients.commitQualification();
        durable = true; qualifications++;
        throw new RestoreInterrupted('stopped after durable qualification', {
          cause: Object.assign(new Error('owner connection interrupted'), { code: 'ECONNRESET' }),
        });
      };
      await expect(attempt()).rejects.toBeInstanceOf(OwnerOperationUnavailable);
      expect(row).toMatchObject({ state: 'running', hold_reason: null });
      expectBothHeld(run);
      run.evidence.releaseErasures = async (clients, releaseGraph) => {
        if (run.fuseki.held) await releaseGraph();
        await openAccess(clients);
      };
    },
    stop: () => { releaseSpy.mockRestore(); relaySpy.mockRestore();
      for (const spy of completionSpies) spy.mockRestore(); },
  };
}

async function expectRestoreInterrupted(attempt: () => Promise<unknown>, original: Error) {
  let rejected: unknown;
  try { await attempt(); } catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(OwnerOperationUnavailable);
  expect((rejected as Error).cause).toBeInstanceOf(RestoreInterrupted);
  let cause = rejected;
  while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
  expect(cause).toBe(original);
}

const completionPhases = ['qualified-resume', 'graph-release', 'Access-release', 'Access-commit',
  'final-outcome-write', 'opened-graph-reader', 'opened-erasure-record', 'opened-erased-closure'] as const;

for (const phase of completionPhases) {
  for (const transport of ['Fuseki-503', 'ECONNRESET', 'pg-client-transport'] as const) {
    test(`durable completion phase ${phase}: ${transport} is interrupted and completes the same key once`, async () => {
      const run = fixture();
      const owner = outerRestore(run, false, true);
      const original = transport === 'Fuseki-503'
        ? new FusekiHttpError('Fuseki query returned 503', 503, 'Service Unavailable')
        : transport === 'ECONNRESET'
          ? Object.assign(new Error('owner connection reset'), { code: 'ECONNRESET' })
          : new Error(DRIVER_TRANSPORT_FAILURES[0]);
      const wrapped = new RestoreLineageConflict('phase evidence is unavailable', { cause: original });
      let armed = true;
      const spies: { mockRestore: () => void }[] = [];
      try {
        await owner.qualify();
        const opened = phase.startsWith('opened-');
        if (opened) {
          // Exercise the real lost-outcome branch: both native releases committed,
          // while the outer operation still has its durable running outcome.
          owner.failures.outcome = wrapped;
          await expectRestoreInterrupted(owner.attempt, original);
          owner.failures.outcome = undefined;
          expect(run.access.open).toBe(true);
          expect(run.fuseki.held).toBe(false);
        }
        if (phase === 'qualified-resume') owner.failures.resume = wrapped;
        else if (phase === 'final-outcome-write') owner.failures.outcome = wrapped;
        else if (phase === 'opened-erasure-record') owner.failures.record = wrapped;
        else if (phase === 'opened-erased-closure') owner.failures.closure =
          new erasureReconciliation.ErasureRestoreHold('released erased closure unavailable', { cause: original });
        else if (phase === 'graph-release') spies.push(
          spyOn(run.fuseki, 'commandWithReceipt').mockImplementation(async () => { throw wrapped; }));
        else if (phase === 'opened-graph-reader') {
          const query = run.fuseki.query.bind(run.fuseki);
          spies.push(spyOn(run.fuseki, 'query').mockImplementation(async sparql => {
            if (armed && sparql.includes('SELECT ?savedMainSequence')) throw original;
            return query(sparql);
          }));
        } else run.access.queryGate = async sql => {
          if (armed && (phase === 'Access-release' && sql.includes('UPDATE access.recovery_fence')
            || phase === 'Access-commit' && sql === 'COMMIT')) throw wrapped;
        };

        await expectRestoreInterrupted(owner.attempt, original);
        expect(owner.row).toMatchObject({ state: 'running', hold_reason: null });
        expect(owner.qualifications).toBe(1);
        if (phase === 'qualified-resume') expect(owner.resumeReads).toBe(1);
        armed = false;
        for (const spy of spies.splice(0)) spy.mockRestore();
        run.access.queryGate = undefined;
        owner.failures.resume = owner.failures.outcome = owner.failures.record = owner.failures.closure = undefined;
        expect(await owner.attempt()).toMatchObject({ state: 'reconciled', disposition: 'matched', replayed: true });
        expect(run.access.open).toBe(true);
        expect(run.access.generation).toBe('6');
        expect(run.fuseki.commands).toHaveLength(1);
        expect(run.trace.filter(event => event === 'graph:release')).toHaveLength(1);
        const releases = owner.releaseSpy.mock.calls.length;
        expect(await owner.attempt()).toMatchObject({ state: 'reconciled', replayed: true });
        expect(owner.releaseSpy).toHaveBeenCalledTimes(releases);
        expect(run.fuseki.commands).toHaveLength(1);
        expect(owner.qualifications).toBe(1);
      } finally {
        for (const spy of spies) spy.mockRestore();
        owner.stop(); run.stop();
      }
    });
  }
}

const qualifiedSites = [
  'access-outbox', 'access-state', 'commerce', 'account-wal', 'account-rows',
  'account-subject-deletions', 'account-deletion-journal', 'deleted-account-access-state',
  'captured-relay', 'captured-relay-connect', 'captured-journal', 'current-coverage-head',
  'retained-authority', 'retained-reconciliation-content', 'native-graph-release',
  'borrowed-Access-transaction', 'borrowed-relay-transaction',
] as const;

for (const status of [503, 400, 404]) {
  test(`qualified Fuseki HTTP ${status} proof read retains evidence and settles the same key correctly`, async () => {
    const run = fixture();
    const owner = outerRestore(run);
    const readGraph = run.fuseki.query.bind(run.fuseki);
    let armed = false, failures = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const sparql = await request.text();
      if (armed && sparql.includes('SELECT ?savedMainSequence ?reconciledMainSequence ?savedSequence')) {
        failures++;
        return new Response('owner unavailable', { status });
      }
      return Response.json(await readGraph(sparql));
    } });
    const http = new FusekiClient(server.url.href);
    const network = spyOn(run.fuseki, 'query').mockImplementation(sparql => http.query(sparql));
    try {
      await owner.qualify();
      const realRelease = run.evidence.releaseErasures;
      armed = true;
      if (status === 503) {
        try { await owner.attempt(); throw new Error('HTTP interruption unexpectedly settled'); }
        catch (error) {
          expect(error).toBeInstanceOf(OwnerOperationUnavailable);
          expect((error as Error).cause).toBeInstanceOf(RestoreInterrupted);
          let original: unknown = error;
          while (original instanceof Error && original.cause !== undefined) original = original.cause;
          expect(original).toBeInstanceOf(FusekiHttpError);
          expect(original).toMatchObject({ status, statusText: 'Service Unavailable',
            message: 'Fuseki query returned 503' });
        }
        expect(owner.row).toMatchObject({ state: 'running', hold_reason: null });
      } else {
        expect(await owner.attempt()).toMatchObject({ state: 'held', replayed: true });
        expect(owner.row.state).toBe('held');
      }
      expect(failures).toBe(1);
      expectBothHeld(run);
      armed = false;
      expect(run.evidence.releaseErasures).toBe(realRelease);
      expect(await owner.attempt()).toMatchObject({ state: status === 503 ? 'reconciled' : 'held', replayed: true });
      expect(owner.qualifications).toBe(1);
      if (status === 503) {
        expect(run.fuseki.commands).toHaveLength(1);
        expect(run.access.open).toBe(true);
        expect(run.access.generation).toBe('6');
        const releases = owner.releaseSpy.mock.calls.length;
        expect(await owner.attempt()).toMatchObject({ state: 'reconciled', replayed: true });
        expect(owner.releaseSpy).toHaveBeenCalledTimes(releases);
        expect(run.fuseki.commands).toHaveLength(1);
      } else expectBothHeld(run);
    } finally {
      network.mockRestore(); await server.stop(true); owner.stop(); run.stop();
    }
  });
}

for (const status of [400, 503] as const) {
  test(`qualified release-proof HTTP ${status} follows the shared failure contract`, async () => {
    const run = fixture();
    const owner = outerRestore(run);
    const query = run.fuseki.query.bind(run.fuseki);
    const failure = new FusekiHttpError(`Fuseki query returned ${status}`, status,
      status === 503 ? 'Service Unavailable' : 'Bad Request');
    let armed = false, proofReads = 0;
    const proof = spyOn(run.fuseki, 'query').mockImplementation(async sparql => {
      if (armed && sparql.includes('rv:OperationReceipt')) {
        proofReads++;
        throw failure;
      }
      return query(sparql);
    });
    try {
      await owner.qualify();
      armed = true;
      if (status === 400) {
        expect(await owner.attempt()).toMatchObject({ state: 'held', disposition: 'conflict', replayed: true });
        expect(owner.row.state).toBe('held');
        expect(owner.row.hold_reason).toContain(failure.message);
        expect(proofReads).toBe(1);
        expect(run.fuseki.held).toBe(false);
        expect(run.access.open).toBe(false);
        const commands = run.fuseki.commands.length;
        armed = false;
        expect(await owner.attempt()).toMatchObject({ state: 'held', disposition: 'conflict', replayed: true });
        expect(proofReads).toBe(1);
        expect(run.fuseki.commands).toHaveLength(commands);
      } else {
        await expectRestoreInterrupted(owner.attempt, failure);
        expect(proofReads).toBe(1);
        expect(owner.row).toMatchObject({ state: 'running', hold_reason: null });
        expect(run.fuseki.held).toBe(false);
        expect(run.access.open).toBe(false);
        armed = false;
        expect(await owner.attempt()).toMatchObject({ state: 'reconciled', disposition: 'matched', replayed: true });
        expect(owner.row.state).toBe('reconciled');
        expect(run.access.open).toBe(true);
        expect(run.fuseki.commands).toHaveLength(1);
      }
      expect(owner.qualifications).toBe(1);
    } finally { proof.mockRestore(); owner.stop(); run.stop(); }
  });
}

test('qualified restore expectation-read TimeoutError leaves the same key resumable without duplicate effects', async () => {
  const run = fixture();
  const owner = outerRestore(run);
  const readGraph = run.fuseki.query.bind(run.fuseki);
  let armed = false, timeoutReads = 0, timeoutClientUsed = true;
  let resolveExpectationRead!: () => void;
  const expectationRead = new Promise<void>(resolve => { resolveExpectationRead = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const sparql = await request.text();
    if (armed && sparql.includes('SELECT ?savedMainSequence ?reconciledMainSequence ?savedSequence')) {
      timeoutReads++;
      resolveExpectationRead();
      return new Promise<Response>(() => {});
    }
    return Response.json(await readGraph(sparql));
  } });
  const http = new FusekiClient(server.url.href);
  const network = spyOn(run.fuseki, 'query').mockImplementation(async sparql => {
    if (armed && timeoutClientUsed
      && sparql.includes('SELECT ?savedMainSequence ?reconciledMainSequence ?savedSequence')) {
      timeoutClientUsed = false;
      return new FusekiClient(server.url.href, undefined, undefined, AbortSignal.timeout(250)).query(sparql);
    }
    return http.query(sparql);
  });
  try {
    await owner.qualify();
    armed = true;
    const interrupted = owner.attempt();
    await expectationRead;
    let failure: unknown;
    try { await interrupted; throw new Error('expectation-read timeout unexpectedly settled'); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OwnerOperationUnavailable);
    expect((failure as Error).cause).toBeInstanceOf(RestoreInterrupted);
    let cause: unknown = failure;
    while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
    expect(cause).toMatchObject({ name: 'TimeoutError' });
    expect(timeoutReads).toBe(1);
    expect(owner.row).toMatchObject({ state: 'running', hold_reason: null });
    expectBothHeld(run);

    armed = false;
    expect(await owner.attempt()).toMatchObject({ state: 'reconciled', disposition: 'matched', replayed: true });
    expect(run.access.open).toBe(true);
    expect(run.access.generation).toBe('6');
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.trace.filter(event => event === 'graph:release')).toHaveLength(1);
    const releases = owner.releaseSpy.mock.calls.length;
    expect(await owner.attempt()).toMatchObject({ state: 'reconciled', replayed: true });
    expect(owner.releaseSpy).toHaveBeenCalledTimes(releases);
    expect(run.fuseki.commands).toHaveLength(1);
    expect(owner.qualifications).toBe(1);
  } finally {
    network.mockRestore(); await server.stop(true); owner.stop(); run.stop();
  }
}, 10_000);

test('qualified graph release preserves an absent-receipt command timeout and safely resends the same key', async () => {
  const run = fixture();
  const owner = outerRestore(run, false, true);
  const timeout = new Error('command request timed out');
  const commandFailure = new CommandOutcomeUnknown('Fuseki command transport outcome unknown', { cause: timeout });
  try {
    await owner.qualify();
    run.fuseki.receiptAwareRelease = true;
    run.fuseki.commandFailure = commandFailure;

    let interrupted: unknown;
    try { await owner.attempt(); }
    catch (error) { interrupted = error; }
    expect(interrupted).toBeInstanceOf(OwnerOperationUnavailable);
    expect((interrupted as Error).cause).toBeInstanceOf(RestoreInterrupted);
    const causeChain: unknown[] = [];
    let cause: unknown = interrupted;
    while (cause instanceof Error) {
      causeChain.push(cause);
      if (cause.cause === undefined) break;
      cause = cause.cause;
    }
    expect(causeChain).toContain(commandFailure);
    expect(causeChain.at(-1)).toBe(timeout);
    expect(causeChain.some(cause => cause instanceof CommandOutcomeUnknown
      && cause.message === 'Fuseki command outcome unknown; receipt absent')).toBe(true);
    expect(run.fuseki.receiptLookups).toBe(1);
    expect(owner.row).toMatchObject({ state: 'running', hold_reason: null });
    expectBothHeld(run);

    expect(await owner.attempt()).toMatchObject({ state: 'reconciled', disposition: 'matched', replayed: true });
    expect(run.fuseki.commands).toHaveLength(2);
    expect(run.fuseki.commands[1]).toMatchObject({ receipt: run.fuseki.commands[0]!.receipt,
      digest: run.fuseki.commands[0]!.digest });
    expect(run.fuseki.releaseEffects).toBe(1);
    expect(run.trace.filter(event => event === 'graph:release')).toHaveLength(1);
    expect(run.access.open).toBe(true);
    const commandCount = run.fuseki.commands.length;
    expect(await owner.attempt()).toMatchObject({ state: 'reconciled', replayed: true });
    expect(run.fuseki.commands).toHaveLength(commandCount);
    expect(run.fuseki.releaseEffects).toBe(1);
    expect(owner.qualifications).toBe(1);
  } finally { owner.stop(); run.stop(); }
});

for (const method of ['GET', 'HEAD'] as const) {
  for (const status of [503, 404, 403] as const) {
    test(`qualified model custody resume preserves S3 ${method} ${status} status semantics`, async () => {
      const run = fixture();
      const objects = new Map<string, Uint8Array>();
      let armed = false, failedRequests = 0;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        const key = new URL(request.url).pathname.split('/').at(-1) ?? '';
        if (armed && request.method === method) {
          failedRequests++;
          return new Response('object service unavailable', { status });
        }
        const bytes = objects.get(key);
        if (request.method === 'HEAD') return new Response(null, { status: bytes ? 200 : 404 });
        if (request.method === 'GET') return bytes
          ? new Response(Buffer.from(bytes), { status: 200 }) : new Response(null, { status: 404 });
        return new Response(null, { status: 405 });
      } });
      const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
        bucket: 'rezics-semantic', accessKeyId: 'restore-test-key', secretAccessKey: 'restore-test-secret',
        prefix: 'semantic/model/' });
      const model = seedRetainedModelCustody(objects, store, `${method}-${status}`);
      run.evidence.objectStore = { directory: '/nonexistent-retained-model-custody', workObjects: store };
      const owner = outerRestore(run, false, true);
      try {
        await owner.qualify();
        const verifyReleasedCustody = async () => {
          try {
            const retained = await readExactModelGeneration(model.environment, model.generation);
            expect(retained.manifestSha256).toBe(model.manifestDigest);
            await store.probe(model.manifestDigest);
          } catch (error) {
            if (restoreLineage.isRestoreTransientFailure(error)) throw error;
            throw new erasureReconciliation.ErasureRestoreHold(
              'restored command or model custody is unavailable or divergent', { cause: error });
          }
        };
        const releaseErasures = run.evidence.releaseErasures!;
        run.evidence.releaseErasures = async (clients, releaseGraph) => {
          await verifyReleasedCustody();
          await releaseErasures(clients, releaseGraph);
        };
        armed = true;

        if (status === 503) {
          let interrupted: unknown;
          try { await owner.attempt(); }
          catch (error) { interrupted = error; }
          expect(interrupted).toBeInstanceOf(OwnerOperationUnavailable);
          expect((interrupted as Error).cause).toBeInstanceOf(RestoreInterrupted);
          let cause: unknown = interrupted;
          while (cause instanceof Error && cause.cause !== undefined) cause = cause.cause;
          expect(cause).toBeInstanceOf(ObjectUnavailable);
          expect((cause as ObjectUnavailable).status).toBe(503);
          expect(owner.row).toMatchObject({ state: 'running', hold_reason: null });
          expectBothHeld(run);
          expect(run.fuseki.releaseEffects).toBe(0);

          armed = false;
          expect(await owner.attempt()).toMatchObject({ state: 'reconciled', disposition: 'matched', replayed: true });
          expect(run.fuseki.commands).toHaveLength(1);
          expect(run.fuseki.releaseEffects).toBe(1);
          expect(run.access.open).toBe(true);
          expect(run.access.generation).toBe('6');
          expect(owner.qualifications).toBe(1);
        } else {
          expect(await owner.attempt()).toMatchObject({ state: 'held', replayed: true });
          expect(owner.row.state).toBe('held');
          expectBothHeld(run);
          expect(run.fuseki.releaseEffects).toBe(0);
          const commandCount = run.fuseki.commands.length;
          expect(await owner.attempt()).toMatchObject({ state: 'held', replayed: true });
          expect(run.fuseki.commands).toHaveLength(commandCount);
        }
        expect(failedRequests).toBe(1);
      } finally {
        armed = false;
        owner.stop(); run.stop(); await server.stop(true);
      }
    });
  }
}

for (const status of [408, 429, 499, 500, 502, 503, 504, 599, 600, 400, 404, 500.5, '503', NaN]) {
  test(`qualified HTTP classifier uses numeric status evidence: ${status}`, () => {
    const original = { status };
    expect(restoreLineage.isRestoreTransientFailure(new RestoreLineageConflict('owner differs', {
      cause: new Error('adapter failed', { cause: original }),
    }))).toBe(typeof status === 'number' && (status === 408 || status === 429
      || Number.isInteger(status) && status >= 500 && status <= 599));
  });
}

for (const site of qualifiedSites) {
  const failures = site === 'account-rows'
    ? ['ECONNRESET', '57P01', 'integrity', 'pg-client-transport'] as const
    : ['ECONNRESET', '57P01', 'integrity'] as const;
  for (const code of failures) {
    test(`qualified ${site}: ${code} preserves cause and settles the same-key owner operation correctly`, async () => {
      const run = fixture();
      const failure = code === 'integrity'
        ? new RestoreLineageConflict('integrity mismatch: connection timeout ECONNRESET 57P01')
        : code === 'pg-client-transport'
          ? new Error(DRIVER_TRANSPORT_FAILURES[0])
          : Object.assign(new Error('owner unavailable'), { code });
      let armed = false;
      const extraSpies: { mockRestore: () => void }[] = [];
      if (site === 'captured-journal' || site === 'retained-authority') {
        run.coverage.accessFenceGeneration = '5';
        run.coverage.erasureJournal = { version: 1, epoch: null, count: '0',
          digest: hash(JSON.stringify(['relay-erasure-journal-core-v1', null])) };
        run.seal();
        const current = { ...run.coverage, accountPg: { ...run.coverage.accountPg, flushedLsn: '0/2000' } };
        run.evidence.retainedAuthorityCoverage = JSON.stringify(sealRecoveryPayload(current, hmacKey, 'graph-recovery-coverage'));
        extraSpies.push(spyOn(erasureAuthority, 'assertRetainedAuthorityCapture').mockImplementation(async () => {
          if (armed && site === 'retained-authority') throw failure;
          return current;
        }));
      }
      if (site === 'deleted-account-access-state') {
        run.access.deletionMarkers = [{ principal_id: 'deleted', authority_epoch: '1' }];
        run.evidence.deletions = { accountPool: run.evidence.accountPool, hmacKey,
          sealedSets: [JSON.stringify(sealRecoveryPayload({ deletion: {
            accessPrincipalId: 'deleted', enforcementEpoch: '1' } }, hmacKey, 'deletion-recovery-set'))] };
        extraSpies.push(spyOn(deletionRecovery, 'assertDeletionRecoverySet').mockImplementation(async () => {
          if (armed) throw failure;
        }));
      }
      const owner = outerRestore(run, site.startsWith('borrowed-'));
      try {
        await owner.qualify();
        armed = true;
        if (ownerChecks.includes(site as OwnerCheck)) {
          run.state.failAt = site as OwnerCheck; run.state.failError = failure;
        } else if (site === 'captured-relay-connect') run.capturedRelay.connectFailure = failure;
        else if (site === 'captured-journal') run.capturedRelay.queryGate = async sql => {
          if (armed && sql === 'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure') throw failure;
        };
        else if (site === 'retained-reconciliation-content') run.evidence.releaseErasures = async () => { throw failure; };
        else if (site === 'borrowed-Access-transaction' || site === 'borrowed-relay-transaction') {
          const borrowed = site === 'borrowed-Access-transaction' ? run.access : run.relay;
          borrowed.queryGate = async sql => { if (armed && sql === 'SHOW transaction_isolation') throw failure; };
        }
        else if (site === 'native-graph-release') extraSpies.push(
          spyOn(run.fuseki, 'commandWithReceipt').mockImplementation(async () => { throw failure; }));

        if (code === 'integrity') {
          expect(await owner.attempt()).toMatchObject({ state: 'held', replayed: true });
          expect(owner.row.state).toBe('held');
        } else {
          try { await owner.attempt(); throw new Error('transport unexpectedly settled'); }
          catch (error) {
            expect(error).toBeInstanceOf(OwnerOperationUnavailable);
            expect((error as Error).cause).toBeInstanceOf(RestoreInterrupted);
            let original: unknown = error;
            while (original instanceof Error && original.cause !== undefined) original = original.cause;
            expect(original).toBe(failure);
          }
          expect(owner.row).toMatchObject({ state: 'running', hold_reason: null });
        }
        expectBothHeld(run);
        armed = false; run.state.failAt = undefined; run.state.failError = undefined;
        run.capturedRelay.connectFailure = undefined; run.capturedRelay.queryGate = undefined;
        run.access.queryGate = undefined; run.relay.queryGate = undefined;
        if (site === 'native-graph-release') extraSpies.pop()!.mockRestore();
        run.evidence.releaseErasures = async (clients, releaseGraph) => {
          await releaseGraph(); await openAccess(clients);
        };
        expect(await owner.attempt()).toMatchObject({ state: code === 'integrity' ? 'held' : 'reconciled', replayed: true });
        expect(owner.qualifications).toBe(1);
        if (code === 'integrity') expectBothHeld(run);
        else {
          expect(run.fuseki.commands).toHaveLength(1);
          expect(run.access.open).toBe(true); expect(run.access.generation).toBe('6');
          const calls = owner.releaseSpy.mock.calls.length;
          expect(await owner.attempt()).toMatchObject({ state: 'reconciled', replayed: true });
          expect(owner.releaseSpy).toHaveBeenCalledTimes(calls);
          expect(run.fuseki.commands).toHaveLength(1);
        }
      } finally { owner.stop(); for (const spy of extraSpies) spy.mockRestore(); run.stop(); }
    });
  }
}

for (const site of ['content', 'objects'] as const) {
  for (const code of ['ECONNRESET', '57P01', 'integrity']) {
    test(`prequalification ${site}: ${code} retains the original cause without bypassing C0 verification`, async () => {
      const run = fixture();
      const failure = code === 'integrity' ? new RestoreLineageConflict('connection timeout mismatch')
        : Object.assign(new Error('owner unavailable'), { code });
      run.state.failAt = site; run.state.failError = failure;
      try {
        try { await run.release(); throw new Error('C0 mismatch accepted'); }
        catch (error) {
          expect(error).toBeInstanceOf(RestoreLineageConflict);
          expect((error as Error).cause).toBe(failure);
          expect(restoreLineage.isRestoreTransientFailure(error)).toBe(code !== 'integrity');
        }
        expectBothHeld(run);
      } finally { run.stop(); }
    });
  }
}

for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '08000', '08006',
  '08P01', '57P01', '57P02', '57P03', '40001', '40P01', '53300']) {
  test(`qualified transport classifier walks wrapped ${code} causes`, () => {
    const original = { code };
    expect(restoreLineage.isRestoreTransientFailure(new RestoreLineageConflict('owner differs', {
      cause: new Error('adapter failed', { cause: original }) }))).toBe(true);
  });
}

test('qualified transport classifier refuses message-only integrity errors and cause cycles', () => {
  for (const message of ['connection timeout', 'ECONNRESET', '57P01', 'pool timeout', 'fetch failed']) {
    expect(restoreLineage.isRestoreTransientFailure(new RestoreLineageConflict(message))).toBe(false);
  }
  const cycle = new Error('connection timeout'); cycle.cause = cycle;
  expect(restoreLineage.isRestoreTransientFailure(cycle)).toBe(false);
});

test('qualified transport classifier recognizes a real pg-pool checkout timeout through wrappers', async () => {
  const pool = new PgPool({ max: 1, connectionTimeoutMillis: 10 });
  // Occupy the sole slot without opening a network connection. The real pool
  // owns its pending queue, timer and error construction.
  const clients = (pool as unknown as { _clients: object[] })._clients;
  clients.push({});
  try {
    try { await pool.connect(); throw new Error('pool unexpectedly checked out'); }
    catch (error) {
      expect((error as Error).message).toBe('timeout exceeded when trying to connect');
      expect(restoreLineage.isRestoreTransientFailure(new RestoreLineageConflict('owner differs', { cause: error }))).toBe(true);
    }
    const plain = new Error('timeout exceeded when trying to connect');
    expect(restoreLineage.isRestoreTransientFailure(plain)).toBe(true);
  } finally { clients.length = 0; await pool.end(); }
});

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

for (const source of ['missing', 'current-owner'] as const) {
  test(`restore release refuses a ${source} captured relay source before opening the current owner transaction`, async () => {
    const run = fixture();
    if (source === 'missing') delete run.evidence.restoredRelayPool;
    else run.evidence.restoredRelayPool = run.relay.pool;
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      expectBothHeld(run);
      expect(run.state.callbackCalls).toBe(0);
      expect(run.access.borrowCount).toBe(0);
      expect(run.relay.borrowCount).toBe(0);
      expect(run.capturedRelay.borrowCount).toBe(0);
      expect(run.fuseki.commands).toHaveLength(0);
    } finally { run.stop(); }
  });
}

test('the actual captured relay coverage reader leaves the current relay transaction and allocator held through the callback', async () => {
  const run = fixture({ actualCapturedRelay: true });
  const { locks } = contentionFixture(run);
  const currentClient = await run.relay.pool.connect();
  let callbacks = 0;
  run.evidence.releaseErasures = async ({ accessClient, relayClient }) => {
    callbacks++;
    expect(relayClient).toBe(currentClient);
    expect(accessClient).toBe(run.access.client);
    expect(run.capturedRelay.active).toBe(false);
    expect(run.capturedRelay.transactionOpen).toBe(false);
    expect(run.capturedRelay.borrowCount).toBe(1);
    expect(run.capturedRelay.releaseCount).toBe(1);
    expect(run.capturedRelay.queries[0]?.sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(run.capturedRelay.queries.at(-1)?.sql).toBe('COMMIT');
    expect(run.capturedRelay.queries.some(query => query.sql.includes('FROM relay.checkpoint'))).toBe(true);
    expect(run.coverage.relay).toMatchObject({ sequence: '0', batchCount: '0', batchDigest: hash(''),
      eventCount: '0', eventDigest: hash('') });
    expect(run.relay.transactionOpen).toBe(true);
    expect(run.relay.queries.filter(query => query.sql.startsWith('BEGIN')))
      .toEqual([{ sql: 'BEGIN ISOLATION LEVEL READ COMMITTED', values: undefined }]);
    expect(run.relay.queries.some(query => query.sql === 'COMMIT' || query.sql === 'ROLLBACK')).toBe(false);
    expect(run.relay.queries.some(query => query.sql.includes('FROM relay.checkpoint'))).toBe(false);
    expect(locks.held.get('relay-allocator')).toBe('restore');
    expect(locks.held.get('access-fence')).toBe('restore');
    await currentClient.query('SELECT 1 /* still inside current owner transaction */');
    throw new RestoreLineageConflict('refuse after observing the live caller transaction');
  };
  try {
    await expect(run.release(currentClient)).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(callbacks).toBe(1);
    expectBothHeld(run);
    expect(run.relay.borrowCount).toBe(1);
    expect(run.relay.maximumBorrowed).toBe(1);
    expect(run.relay.releaseCount).toBe(0);
    expect(run.relay.active).toBe(true);
    expect(run.relay.transactionOpen).toBe(false);
    expect(run.relay.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(run.relay.queries.some(query => query.sql === 'COMMIT')).toBe(false);
    expect(locks.held.size).toBe(0);
    expect(run.fuseki.commands).toHaveLength(0);
  } finally { currentClient.release(); run.stop(); }
});

for (const delivery of ['search', 'download'] as const) {
  test(`a current ${delivery} delivery veto runs before native graph release on the same Access client`, async () => {
    const run = fixture();
    const guardedRelease = run.evidence.releaseErasures!;
    run.evidence.releaseErasures = async (clients, releaseGraph) => {
      if (delivery === 'search') run.access.deliveringSearch = true;
      else run.access.deliveringDownload = true;
      await guardedRelease(clients, releaseGraph);
    };
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      expectBothHeld(run);
      expect(run.state.callbackCalls).toBe(1);
      expect(run.fuseki.commands).toHaveLength(0);
      expect(run.trace).toContain('access:delivery-veto');
      expect(run.access.queries.some(query => query.sql.includes('FROM access.search_read_lease')
        && query.sql.includes('FROM access.download_read_lease'))).toBe(true);
      expect(run.access.borrowCount).toBe(1);
      expect(run.access.maximumBorrowed).toBe(1);
      expect(run.access.releaseCount).toBe(1);
      expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
    } finally { run.stop(); }
  });
}

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

for (const failure of ['missing', 'ambiguous', 'malformed', 'diagnostic-substitution', 'stale-reconciled'] as const) {
  test(`restore release refuses ${failure} Main cut evidence before erasure callback`, async () => {
    const run = fixture();
    if (failure === 'missing') run.fuseki.mainCutRows = [];
    if (failure === 'ambiguous') {
      const row = { savedMainSequence: { type: 'literal' as const, value: '4' } };
      run.fuseki.mainCutRows = [row, row];
    }
    if (failure === 'malformed') run.fuseki.savedMainSequence = 'not-a-position';
    if (failure === 'diagnostic-substitution') run.fuseki.savedMainSequence = '900';
    if (failure === 'stale-reconciled') run.fuseki.reconciledMainSequence = '5';
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
      expectBothHeld(run);
      expect(run.state.callbackCalls).toBe(0);
      expect(run.fuseki.commands).toHaveLength(0);
      expect(run.fuseki.queries.some(query => query.includes('SELECT ?savedMainSequence ?reconciledMainSequence'))).toBe(true);
      expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
      expect(run.relay.queries.at(-1)?.sql).toBe('ROLLBACK');
    } finally { run.stop(); }
  });
}

test('restore release retains the exact legacy receipt digest for a marker with no separate Main cut', async () => {
  const run = fixture();
  run.coverage.priorSequence = '4';
  run.fuseki.priorSequence = '4';
  run.fuseki.savedMainSequence = undefined;
  run.seal();
  try {
    await run.release();
    expect(run.fuseki.commands).toHaveLength(1);
    expect(run.fuseki.commands[0]?.digest).toBe(hash(JSON.stringify({ family: 'restore-release-v1', lineage,
      priorDataEpoch, priorSequence: '4' })));
    expect(run.fuseki.releaseReceipt?.priorMainSequence).toBeUndefined();
    expect(run.fuseki.releaseReceipt?.streamScope).toBeUndefined();
    expect(run.access.open).toBe(true);
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
    expect(run.fuseki.commands[0]?.digest).toBe(hash(JSON.stringify({ family: 'restore-release-v2', lineage,
      priorDataEpoch, priorSequence: '900', priorMainSequence: '4', streamScope: MAIN_RELAY_STREAM_SCOPE })));
    expect(run.fuseki.releaseReceipt).toMatchObject({ priorMainSequence: '4', streamScope: MAIN_RELAY_STREAM_SCOPE });
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

test('restore callback failure preserves both supplied owner transactions and their locks for the caller', async () => {
  const run = fixture();
  const { locks } = contentionFixture(run);
  const relayClient = await run.relay.pool.connect();
  const accessClient = await run.access.pool.connect();
  await relayClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await relayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch', 0))");
  await accessClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await accessClient.query('SELECT open FROM access.recovery_fence WHERE id = true FOR UPDATE');
  const relayStart = run.relay.queries.length;
  const accessStart = run.access.queries.length;
  let callbacks = 0;
  const refusal = new RestoreLineageConflict('caller-owned erasure reconciliation refused');
  run.evidence.releaseErasures = async clients => {
    callbacks++;
    expect(clients.relayClient).toBe(relayClient);
    expect(clients.accessClient).toBe(accessClient);
    expect(run.relay.transactionOpen).toBe(true);
    expect(run.access.transactionOpen).toBe(true);
    expect(locks.held.get('relay-allocator')).toBe('restore');
    expect(locks.held.get('access-fence')).toBe('restore');
    throw refusal;
  };
  try {
    await expect(run.release(relayClient, accessClient)).rejects.toBe(refusal);
    expect(callbacks).toBe(1);
    expectBothHeld(run);
    for (const [owner, start] of [[run.relay, relayStart], [run.access, accessStart]] as const) {
      expect(owner.queries.slice(start).some(query => query.sql.startsWith('BEGIN')
        || query.sql === 'COMMIT' || query.sql === 'ROLLBACK')).toBe(false);
      expect(owner.transactionOpen).toBe(true);
      expect(owner.active).toBe(true);
      expect(owner.borrowCount).toBe(1);
      expect(owner.releaseCount).toBe(0);
    }
    expect(locks.held.get('relay-allocator')).toBe('restore');
    expect(locks.held.get('access-fence')).toBe('restore');
    expect(run.fuseki.commands).toHaveLength(0);
  } finally {
    await accessClient.query('ROLLBACK');
    await relayClient.query('ROLLBACK');
    accessClient.release();
    relayClient.release();
    run.stop();
  }
});

test('a supplied Access client without its relay client is refused without touching either owner transaction', async () => {
  const run = fixture();
  const accessClient = await run.access.pool.connect();
  await accessClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const before = run.access.queries.length;
  try {
    await expect(run.release(undefined, accessClient)).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.access.queries).toHaveLength(before);
    expect(run.access.transactionOpen).toBe(true);
    expect(run.access.releaseCount).toBe(0);
    expect(run.relay.borrowCount).toBe(0);
    expect(run.capturedRelay.borrowCount).toBe(0);
  } finally { await accessClient.query('ROLLBACK'); accessClient.release(); run.stop(); }
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

for (const failure of ['missing', 'mismatched', 'missing-main', 'wrong-main', 'wrong-scope'] as const) {
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
      if (failure === 'mismatched') run.fuseki.releaseReceipt!.digest = 'b'.repeat(64);
      if (failure === 'missing-main') delete run.fuseki.releaseReceipt!.priorMainSequence;
      if (failure === 'wrong-main') run.fuseki.releaseReceipt!.priorMainSequence = '900';
      if (failure === 'wrong-scope') run.fuseki.releaseReceipt!.streamScope = 'urn:rezics:relay:foreign';
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

const releaseDigest = hash(JSON.stringify({ family: 'restore-release-v2', lineage, priorDataEpoch,
  priorSequence: '900', priorMainSequence: '4', streamScope: MAIN_RELAY_STREAM_SCOPE }));
const expectedRelease = {
  lineage, restoreCutover: `urn:rezics:restore:${lineage.dataEpoch}`,
  saved: { dataEpoch: priorDataEpoch, graphSequence: '900',
    main: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: priorDataEpoch, sequence: '4' } },
  effective: { dataEpoch: priorDataEpoch, graphSequence: '900',
    main: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: priorDataEpoch, sequence: '4' } },
};
const openAccess = async (clients: Pick<Parameters<ReleaseErasures>[0], 'accessClient' | 'fenceGeneration'>) => {
  const opened = await clients.accessClient.query(`UPDATE access.recovery_fence
    SET open = true, generation = generation + 1 WHERE id = true AND open = false AND generation = $1`,
  [clients.fenceGeneration]);
  if (opened.rowCount !== 1) throw new RestoreLineageConflict('Access recovery fence changed');
};

test('durable qualification commits the retained record while both holds are closed and then releases in fresh transactions', async () => {
  const run = fixture();
  run.evidence.qualification = { resume: false };
  const owners: string[] = [];
  run.evidence.releaseErasures = async (clients, releaseGraph) => {
    expect(clients.graphRelease).toEqual(expectedRelease);
    await clients.relayClient.query('SELECT 1 /* qualification record */');
    await clients.commitQualification();
    owners.push(run.trace.slice().join(','));
    // Both holds are still closed after the commit, and the fresh transactions retook the locks.
    expect(run.fuseki.held).toBe(true);
    expect(run.access.open).toBe(false);
    expect(run.access.transactionOpen).toBe(true);
    expect(run.relay.transactionOpen).toBe(true);
    expect(clients.fenceGeneration).toBe('5');
    await releaseGraph();
    await openAccess(clients);
  };
  try {
    await run.release();
    expect(owners[0]).not.toContain('graph:release');
    expect(owners[0]).not.toContain('access:open');
    expect(run.trace.filter(item => item === 'relay:commit' || item === 'access:commit')).toEqual(
      ['relay:commit', 'access:commit', 'relay:commit', 'access:commit']);
    expect(run.relay.queries.filter(query => query.sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(run.access.open).toBe(true);
    expect(run.access.generation).toBe('6');
    expect(run.fuseki.releaseReceipt?.digest).toBe(releaseDigest);
    expect(run.access.maximumBorrowed).toBe(1);
    expect(run.relay.maximumBorrowed).toBe(1);
    for (const check of ownerChecks) {
      expect(run.trace.filter(item => item === `validated:${check}`)).toHaveLength(1);
    }
  } finally { run.stop(); }
});

test('an interruption after the durable qualification leaves its record committed and both holds closed', async () => {
  const run = fixture();
  run.evidence.qualification = { resume: false };
  run.evidence.releaseErasures = async (clients, releaseGraph) => {
    await clients.commitQualification();
    await releaseGraph();
    throw new RestoreInterrupted('Access connection lost after the native release');
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreInterrupted);
    expect(run.trace.filter(item => item === 'relay:commit')).toHaveLength(1);
    expect(run.fuseki.held).toBe(false);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(run.relay.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

test('a lost Access commit after durable relay qualification remains resumable with both holds closed', async () => {
  const run = fixture();
  run.evidence.qualification = { resume: false };
  run.evidence.releaseErasures = async clients => { await clients.commitQualification(); };
  run.access.queryGate = async sql => {
    if (sql === 'COMMIT') throw Object.assign(new Error('Access connection lost'), { code: '57P01' });
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreInterrupted);
    expect(run.trace.filter(item => item === 'relay:commit')).toHaveLength(1);
    expect(run.trace.filter(item => item === 'access:commit')).toHaveLength(0);
    expect(run.fuseki.held).toBe(true);
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

for (const failure of ['connect', 'scan'] as const) {
  test(`a captured relay ${failure} connection failure after durable qualification resumes and completes`, async () => {
    const run = fixture();
    let restoreAuthoritySpy: (() => void) | undefined;
    if (failure === 'scan') {
      run.coverage.accessFenceGeneration = '5';
      run.coverage.erasureJournal = { version: 1, epoch: null, count: '0',
        digest: hash(JSON.stringify(['relay-erasure-journal-core-v1', null])) };
      run.seal();
      // A distinct authenticated C1 with a later WAL floor preserves every
      // owner fact while selecting the two-cut captured-journal comparison.
      const current = { ...run.coverage, accountPg: { ...run.coverage.accountPg, flushedLsn: '0/2000' } };
      run.evidence.retainedAuthorityCoverage = JSON.stringify(sealRecoveryPayload(
        current, hmacKey, 'graph-recovery-coverage'));
      const authoritySpy = spyOn(erasureAuthority, 'assertRetainedAuthorityCapture')
        .mockImplementation(async (client, consumer, evidence) => {
          expect(client).toBe(run.relay.client);
          expect(consumer).toBe(run.coverage.relay.consumer);
          expect(evidence.sealedCoverage).toBe(run.evidence.retainedAuthorityCoverage!);
          return current;
        });
      restoreAuthoritySpy = () => { authoritySpy.mockRestore(); };
    }
    run.evidence.qualification = { resume: false };
    let qualificationCommits = 0;
    run.evidence.releaseErasures = async clients => {
      await clients.relayClient.query('SELECT 1 /* qualification record */');
      await clients.commitQualification();
      qualificationCommits++;
      throw new RestoreInterrupted('interrupted after durable qualification');
    };
    try {
      await expect(run.release()).rejects.toBeInstanceOf(RestoreInterrupted);
      expect(qualificationCommits).toBe(1);
      expect(run.trace.filter(item => item === 'relay:commit')).toHaveLength(1);
      expectBothHeld(run);

      run.evidence.qualification = { resume: true };
      if (failure === 'scan') {
        run.evidence.qualification.authenticateResume = async clients => {
          expect(qualificationCommits).toBe(1);
          expect(clients.relayClient).toBe(run.relay.client);
          expect(clients.accessClient).toBe(run.access.client);
          expect(clients.fenceGeneration).toBe('5');
        };
      }
      run.evidence.releaseErasures = async (clients, releaseGraph) => {
        await releaseGraph();
        await openAccess(clients);
      };
      const unavailable = Object.assign(new Error('captured relay connection lost'), { code: '08006' });
      if (failure === 'connect') run.capturedRelay.connectFailure = unavailable;
      else run.capturedRelay.queryGate = async sql => {
        if (sql === 'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure') throw unavailable;
      };
      await expect(run.release()).rejects.toBeInstanceOf(RestoreInterrupted);
      if (failure === 'scan') {
        expect(run.trace.filter(item => item === 'validated:captured-relay')).toHaveLength(2);
        expect(run.capturedRelay.queries.at(-2)?.sql)
          .toBe('SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure');
      }
      expectBothHeld(run);
      expect(run.capturedRelay.active).toBe(false);
      expect(run.capturedRelay.transactionOpen).toBe(false);
      expect(run.access.active).toBe(false);
      expect(run.relay.active).toBe(false);
      expect(qualificationCommits).toBe(1);

      run.capturedRelay.connectFailure = undefined;
      run.capturedRelay.queryGate = undefined;
      await run.release();
      expect(run.fuseki.held).toBe(false);
      expect(run.fuseki.commands).toHaveLength(1);
      expect(run.access.open).toBe(true);
      expect(run.access.generation).toBe('6');
      expect(qualificationCommits).toBe(1);
      for (const owner of [run.capturedRelay, run.access, run.relay]) {
        expect(owner.active).toBe(false);
        expect(owner.borrowCount).toBe(owner.releaseCount);
      }
    } finally { restoreAuthoritySpy?.(); run.stop(); }
  });
}

test('a resumed qualification skips the replay-sensitive base comparison and continues from the released graph', async () => {
  const run = fixture();
  run.evidence.qualification = { resume: true };
  run.fuseki.held = false;
  run.fuseki.releaseReceipt = { receipt: `urn:rezics:receipt:restore-release:${hash(lineage.dataEpoch)}`,
    digest: releaseDigest, priorMainSequence: '4', streamScope: MAIN_RELAY_STREAM_SCOPE };
  run.evidence.releaseErasures = async clients => {
    expect(clients.graphRelease).toEqual(expectedRelease);
    await openAccess(clients);
  };
  try {
    await run.release();
    expect(run.fuseki.commands).toHaveLength(0);
    expect(run.access.open).toBe(true);
    expect(run.access.generation).toBe('6');
    expect(run.trace).not.toContain('validated:content');
    expect(run.trace).not.toContain('validated:objects');
    for (const check of ownerChecks.filter(check => check !== 'content' && check !== 'objects')) {
      expect(run.trace.filter(item => item === `validated:${check}`)).toHaveLength(1);
    }
    expect(run.trace.filter(item => item === 'relay:commit' || item === 'access:commit'))
      .toEqual(['relay:commit', 'access:commit']);
  } finally { run.stop(); }
});

test('a resumed qualification still refuses a graph that is neither held nor exactly released', async () => {
  const run = fixture();
  run.evidence.qualification = { resume: true };
  run.fuseki.held = false;
  run.fuseki.releaseReceipt = null;
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(run.state.callbackCalls).toBe(0);
    expect(run.access.open).toBe(false);
    expect(run.access.generation).toBe('5');
  } finally { run.stop(); }
});

test('durable qualification is refused when the caller owns neither transaction or the mode is absent', async () => {
  const run = fixture();
  run.evidence.releaseErasures = async clients => { await clients.commitQualification(); };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expectBothHeld(run);
    expect(run.trace).not.toContain('relay:commit');
    expect(run.access.queries.at(-1)?.sql).toBe('ROLLBACK');
  } finally { run.stop(); }
});

test('the Access fence moving between the qualification commit and the fresh release keeps both holds closed', async () => {
  const run = fixture();
  run.evidence.qualification = { resume: false };
  let committed = false;
  run.evidence.releaseErasures = async clients => {
    run.access.generation = '5';
    run.access.open = true;
    committed = true;
    await clients.commitQualification();
  };
  try {
    await expect(run.release()).rejects.toBeInstanceOf(RestoreLineageConflict);
    expect(committed).toBe(true);
    expect(run.fuseki.commands).toHaveLength(0);
  } finally { run.stop(); }
});


for (const profile of [undefined, 'access-state-v5', 'access-authority-v6'] as const) {
  test(`restore release verifies signed Access coverage with profile ${profile ?? 'legacy absent discriminator'}`, async () => {
    const run = fixture();
    try {
      run.coverage.accessStateProfile = profile;
      if (profile === 'access-authority-v6') run.coverage.accessLeaseEpochs = { derivedGeneration: '3', discoveryRefresh: '3' };
      run.seal();
      await run.release();
      expect(run.access.open).toBe(true);
      expect(run.fuseki.held).toBe(false);
    } finally { run.stop(); }
  });
}


test('ordinary release resets against the authenticated retained lease floor even when authority rows are unchanged', async () => {
  const run = fixture();
  const floor = { derivedGeneration: '3', discoveryRefresh: '3' };
  run.coverage.accessStateProfile = 'access-authority-v6';
  run.coverage.accessLeaseEpochs = { derivedGeneration: '1', discoveryRefresh: '1' };
  run.coverage.accessFenceGeneration = '5';
  run.coverage.erasureJournal = { version: 1, epoch: null, count: '0',
    digest: hash(JSON.stringify(['relay-erasure-journal-core-v1', null])) };
  run.seal();
  const current = { ...run.coverage, accessLeaseEpochs: floor };
  run.evidence.retainedAuthorityCoverage = JSON.stringify(sealRecoveryPayload(current, hmacKey, 'graph-recovery-coverage'));
  const authority = spyOn(erasureAuthority, 'assertRetainedAuthorityCapture').mockImplementation(async (client, consumer, evidence) => {
    expect(client).toBe(run.relay.client);
    expect(consumer).toBe(run.coverage.relay.consumer);
    expect(evidence.sealedCoverage).toBe(run.evidence.retainedAuthorityCoverage!);
    run.trace.push('validated:current-coverage-head');
    return current;
  });
  const reset = spyOn(accessCoverage, 'resetAccessRecoveryState').mockImplementation(async (client, epochs) => {
    expect(client).toBe(run.access.client);
    expect(epochs).toEqual(floor);
    expect(run.access.transactionOpen).toBe(true);
    expect(run.access.open).toBe(false);
  });
  try {
    await run.release();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(run.access.open).toBe(true);
  } finally { reset.mockRestore(); authority.mockRestore(); run.stop(); }
});

/** Exercise the callback supplied by OwnerOperations, including its profile and reset decisions. */
function retainedCaller(run: ReturnType<typeof fixture>, current: RecoveryCoverage) {
  const owner = outerRestore(run, false, true, current);
  const spies = [
    spyOn(restoreBinding, 'readBindings').mockResolvedValue({ qualification: 'qualified', release: null }),
    spyOn(restoreBinding, 'requireQualification').mockResolvedValue(undefined),
    spyOn(restoreBinding, 'recordRelease').mockResolvedValue(undefined),
    spyOn(restoreLineage, 'assertRestoreAuthorityBaseline').mockResolvedValue(current),
    spyOn(erasureAuthority, 'assertRetainedAuthorityCoverage').mockImplementation(async (_relay, _pool, _consumer, authority, client) => {
      expect(client).toBe(run.access.client);
      expect(authority.sealedCoverage).toBe(JSON.stringify(sealRecoveryPayload(current, hmacKey, 'graph-recovery-coverage')));
    }),
  ];
  owner.releaseSpy.mockImplementation(async (_graph, _access, _relay, _lineage, evidence, relayClient) => {
    const accessClient = await run.access.pool.connect();
    try {
      await relayClient!.query('BEGIN');
      await accessClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const clients = { relayClient: relayClient!, accessClient, fenceGeneration: '5',
        graphRelease: await restoreLineage.readRestoredGraphReleaseExpectation(run.fuseki, lineage, run.coverage),
        commitQualification: async () => { throw new Error('resume must retain its durable qualification'); } };
      expect(evidence.qualification?.resume).toBe(true);
      await evidence.qualification!.authenticateResume!(clients);
      await evidence.releaseErasures!(clients, async () => { run.fuseki.held = false; });
      await accessClient.query('COMMIT');
      await relayClient!.query('COMMIT');
    } catch (error) {
      await accessClient.query('ROLLBACK');
      await relayClient!.query('ROLLBACK');
      throw error;
    } finally { accessClient.release(); }
  });
  return { ...owner, stop: () => { for (const spy of spies) spy.mockRestore(); owner.stop(); } };
}

for (const baseProfile of [undefined, 'access-state-v5', 'access-authority-v6'] as const) {
  for (const currentProfile of [undefined, 'access-state-v5', 'access-authority-v6'] as const) {
    for (const live of ['base', 'current', 'changed', 'changed-outbox'] as const) {
      test(`OwnerOperations qualified resume ${baseProfile ?? 'absent'} -> ${currentProfile ?? 'absent'}: ${live}`, async () => {
        const run = fixture();
        run.coverage.accessStateProfile = baseProfile;
        run.coverage.accessLeaseEpochs = { derivedGeneration: '9', discoveryRefresh: '2' };
        run.seal();
        const journal = { version: 1 as const, epoch: null, count: '0', digest };
        const current: RecoveryCoverage = { ...run.coverage, accessStateProfile: currentProfile,
          accessStateDigest: 'b'.repeat(64), accessLeaseEpochs: { derivedGeneration: '3', discoveryRefresh: '8' },
          nativeAccessErasure: { baseCoverageDigest: digest, baseErasureJournal: journal, sourceErasureJournal: journal,
            summary: { plaintextDigest: digest, baseFenceGeneration: '5' } } as RecoveryCoverage['nativeAccessErasure'] };
        const owner = retainedCaller(run, current);
        const profiles: accessCoverage.AccessRecoveryProfile[] = [];
        const verifier = { verifyAdmissions: async () => {}, assertComplete: () => {} };
        const importSpy = spyOn(accessErasureRecovery, 'importAccessErasureRecoveryAttachment')
          .mockResolvedValue({ imported: '1', alreadyPresent: '0' });
        const basisSpy = spyOn(restoreBinding, 'captureReleaseBasis').mockImplementation(async (_pool, client, cut, reset) => {
          expect(client).toBe(run.access.client);
          expect(cut).toEqual(current);
          expect(reset).toEqual({ dataEpoch: lineage.dataEpoch, floors: { derivedGeneration: '9', discoveryRefresh: '8' } });
          return {} as restoreBinding.ReleaseBasis;
        });
        const extraSpies = [importSpy, basisSpy,
          spyOn(coreJournalCoverage, 'createPublicRevisionJournalDeltaVerifier').mockResolvedValue(verifier),
          spyOn(accessCoverage, 'accessStateCoverage').mockImplementation(async (_pool, client, profile) => {
            expect(client).toBe(run.access.client);
            profiles.push(profile!);
            const cut = live === 'base' ? run.coverage : current;
            return { count: '1', digest: live === 'changed' || profile !== (cut.accessStateProfile ?? 'access-state-v5')
              ? 'c'.repeat(64) : cut.accessStateDigest };
          }),
          spyOn(accessCoverage, 'accessOutboxCoverage').mockResolvedValue({ count: '1',
            digest: live === 'changed-outbox' ? 'c'.repeat(64) : digest }),
          spyOn(restoreBinding, 'proveReleaseTransition').mockResolvedValue({} as restoreBinding.ReleaseTransition),
          spyOn(erasureReconciliation, 'releaseErasureRestoreHold').mockImplementation(async (_relay, _owners, _id, _generation, _authority, options) => {
            await options!.beforeAccessRelease!();
            await openAccess({ ...options!.clients!, fenceGeneration: _generation });
          }),
        ];
        try {
          const refused = live === 'changed' || live === 'changed-outbox';
          expect(await owner.attempt()).toMatchObject({ state: refused ? 'held' : 'reconciled' });
          expect(profiles).toEqual(live === 'base' ? [baseProfile ?? 'access-state-v5']
            : [baseProfile ?? 'access-state-v5', currentProfile ?? 'access-state-v5']);
          expect(importSpy).toHaveBeenCalledTimes(live === 'base' ? 1 : 0);
          expect(basisSpy).toHaveBeenCalledTimes(refused ? 0 : 1);
          expect(run.access.open).toBe(!refused);
          if (refused) {
            expect(owner.row.hold_reason).toContain('qualified Access differs from both authenticated cuts');
            expect(run.fuseki.held).toBe(true);
          }
        } finally { for (const spy of extraSpies) spy.mockRestore(); owner.stop(); run.stop(); }
      });
    }
  }
}

for (const profile of [undefined, 'access-state-v5', 'access-authority-v6'] as const) {
  test(`OwnerOperations release proves ${profile ?? 'absent'} reset bytes through the real release binding`, async () => {
    const run = fixture();
    run.coverage.accessStateProfile = profile;
    run.coverage.accessLeaseEpochs = { derivedGeneration: '9', discoveryRefresh: '2' };
    const current = { ...run.coverage, accessLeaseEpochs: { derivedGeneration: '3', discoveryRefresh: '8' } };
    let reset = false;
    let opened = false;
    const changes = ['access.discovery_source_change', 'access.also_enjoyed_source_change'];
    const records = (name: string) => opened ? [{ id: '1', ...(name === changes[0]
      ? { context_key: '', statement: '' } : { privacy: true }) }] : [];
    const rows = (name: string): ownerFrontier.RowCoverage => {
      const values = records(name);
      const hash = createHash('sha256');
      for (const row of values) hash.update(JSON.stringify([[row.id], JSON.stringify(row)]) + '\n');
      return { count: String(values.length), digest: hash.digest('hex') };
    };
    const tables = (selected: accessCoverage.AccessRecoveryProfile): accessCoverage.AccessStateTables => {
      const covered: Record<string, ownerFrontier.RowCoverage> = { 'access.permission_grant': { count: '1', digest } };
      if (selected === 'access-state-v5') {
        covered['access.realm_directory_position'] = { count: '1', digest: (reset ? 'b' : 'c').repeat(64) };
        for (const name of changes) covered[name] = rows(name);
      }
      return { catalogDigest: digest, excluded: {}, tables: covered, state: ownerFrontier.foldRowCoverage(selected,
        { digest, excluded: {}, tables: Object.keys(covered).map(name => ({ name }) as ownerFrontier.OwnerTable) }, covered) };
    };
    const before = tables(profile ?? 'access-state-v5').state;
    run.coverage.accessStateCount = current.accessStateCount = before.count;
    run.coverage.accessStateDigest = current.accessStateDigest = before.digest;
    run.seal();
    const owner = retainedCaller(run, current);
    const releaseSpy = spyOn(restoreBinding, 'recordRelease').mockResolvedValue(undefined);
    const resetSpy = spyOn(accessCoverage, 'resetAccessRecoveryState').mockImplementation(async (client, floors, epoch) => {
      expect(client).toBe(run.access.client);
      expect(floors).toEqual({ derivedGeneration: '9', discoveryRefresh: '8' });
      expect(epoch).toBe(lineage.dataEpoch);
      reset = true;
    });
    const extraSpies = [releaseSpy, resetSpy,
      spyOn(accessCoverage, 'accessStateTables').mockImplementation(async (_pool, client, selected) => {
        expect(client).toBe(run.access.client);
        return tables(selected!);
      }),
      spyOn(accessCoverage, 'accessOutboxCoverage').mockResolvedValue({ count: '1', digest }),
      spyOn(ownerFrontier, 'scanOwnerTable').mockImplementation(async (client, table, visit) => {
        expect(client).toBe(run.access.client);
        for (const row of records(table.name)) await visit!([row.id], JSON.stringify(row));
        return rows(table.name);
      }),
      spyOn(erasureReconciliation, 'releaseErasureRestoreHold').mockImplementation(async (_relay, _owners, _id, _generation, _authority, options) => {
        await options!.beforeAccessRelease!();
        await accessCoverage.resetAccessRecoveryState(run.access.client,
          { derivedGeneration: '9', discoveryRefresh: '8' }, lineage.dataEpoch);
        await openAccess({ ...options!.clients!, fenceGeneration: _generation });
        opened = true;
      }),
    ];
    run.access.queryGate = async sql => {
      if (sql === 'ROLLBACK TO SAVEPOINT access_release_reset_preview') reset = false;
    };
    try {
      expect(await owner.attempt()).toMatchObject({ state: 'reconciled' });
      expect(resetSpy).toHaveBeenCalledTimes(profile === 'access-authority-v6' ? 1 : 2);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy.mock.calls[0]![8]).toMatchObject({ pre: { state: before },
        post: { state: tables(profile ?? 'access-state-v5').state },
        identities: { [changes[0]!]: '1', [changes[1]!]: '1' } });
      expect(run.access.open).toBe(true);
    } finally { for (const spy of extraSpies) spy.mockRestore(); owner.stop(); run.stop(); }
  });
}
