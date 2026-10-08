import { sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { accountRecoveryCoverage, type AccountRecoveryCoverage } from '../../account/src/recovery-coverage.ts';
import type { DeletionRecoverySet } from '../../account/src/deletion-recovery-set.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode,
} from '../src/infrastructure/pg-pool.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { captureCommerceRecoveryCoverage, type CommerceRecoveryCoverage } from
  '../src/modules/commerce/recovery-coverage.ts';
import { OwnerOperations } from '../src/modules/owner/operations.ts';
import { reconcileRelayGap } from '../src/modules/owner/relay-gap.ts';
import { relayCoverage, type RelayCoverage } from '../src/modules/outbox/relay.ts';
import { accessOutboxCoverage, accessStateCoverage } from '../src/modules/work/access-recovery-coverage.ts';
import { capturePgRecoveryFrontier, type PgRecoveryFrontier } from '../src/modules/work/pg-recovery-frontier.ts';
import type { RecoveryCoverage } from '../src/modules/work/restore-lineage.ts';

const root = resolve(import.meta.dir, '../../..');
const tag = `np${process.pid}`;
const socketDir = `/tmp/${tag}-sock`;
const archive = `/tmp/${tag}-arch`;
const state = join(root, '.temp', `nested-pool-${process.pid}`);
const primaryData = join(state, 'primary');
const backupData = join(state, 'backup');
const restoredData = join(state, 'restored');
const hmacKey = '11'.repeat(32);
const epoch = '11111111-1111-4111-8111-111111111111';
const routingEpoch = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const deactivatedId = '44444444-4444-4444-8444-444444444444';
const deletionId = '55555555-5555-4555-8555-555555555555';
const issuer = 'https://accounts.example/issuer';
const subject = '66666666-6666-4666-8666-666666666666';
const consumer = 'product';
const user = process.env.USER ?? 'edge';

const ACCOUNT_TABLES = [
  'account', 'jwks', 'oauthAccessToken', 'oauthClient', 'oauthClientAssertion',
  'oauthClientResource', 'oauthConsent', 'oauthRefreshToken', 'oauthResource',
  'rezics_account_recovery_activation', 'rezics_account_recovery_approval',
  'rezics_account_recovery_claim', 'rezics_account_recovery_policy',
  'rezics_account_recovery_guardian_invitation',
  'rezics_oauth_code_basis', 'rezics_oauth_first_party_client', 'rezics_oauth_installation', 'rezics_signing_key',
  'session', 'user', 'verification',
  'passkey', 'twoFactor', 'rezics_account_email', 'rezics_account_rate_limit',
  'rezics_account_pending_consent', 'rezics_account_step_up', 'rezics_account_security_event',
  'rezics_account_security', 'rezics_account_grant', 'rezics_account_operator',
  'rezics_account_operator_bootstrap', 'rezics_account_operator_audit', 'rezics_account_operator_note',
  'rezics_account_operator_command', 'rezics_account_operator_preference', 'rezics_account_operator_job',
  'rezics_account_operator_job_item', 'rezics_display_preferences',
  'rezics_account_email_change',
  'rezics_policy_acceptance', 'rezics_mail_suppression', 'rezics_content_preferences',
] as const;
const ACCOUNT_KEYS: Record<string, readonly string[]> = {
  rezics_account_rate_limit: ['key'],
  rezics_account_step_up: ['session_id'],
  rezics_account_security: ['user_id'],
  rezics_account_grant: ['user_id', 'client_id'],
  rezics_account_operator: ['user_id'],
  rezics_account_operator_bootstrap: ['singleton'],
  rezics_account_operator_command: ['actor_id', 'command_id'],
  rezics_account_operator_preference: ['user_id'],
  rezics_account_operator_job_item: ['job_id', 'position'],
  rezics_content_preferences: ['user_id'],
  rezics_display_preferences: ['user_id'],
  rezics_account_email_change: ['user_id'],
  rezics_oauth_first_party_client: ['client_id'],
  rezics_policy_acceptance: ['user_id', 'policy_id', 'version_digest'],
  rezics_mail_suppression: ['address', 'purpose'],
};
const COMMERCE_TABLES: readonly (readonly [string, readonly string[]])[] = [
  ['payment_provider', ['id']], ['offering', ['id']], ['offering_revision', ['offering_id', 'revision']],
  ['plan_group', ['offering_id', 'group_key']], ['plan', ['offering_id', 'offering_revision', 'plan_key']],
  ['price', ['offering_id', 'offering_revision', 'plan_key', 'price_key']],
  ['plan_benefit', ['offering_id', 'offering_revision', 'plan_key', 'benefit_key']],
  ['subscription', ['id']], ['quote', ['id']], ['subscription_change', ['id']],
  ['receipt', ['principal_id', 'idempotency_key']], ['settlement', ['id']],
  ['provider_callback', ['provider', 'provider_event_id']], ['reconciliation', ['id']],
  ['settlement_event', ['settlement_id', 'generation']], ['entitlement', ['id']],
  ['entitlement_event', ['entitlement_id', 'generation']], ['benefit_epoch', ['beneficiary']],
];

const pools: Pool[] = [];
let restoredPort = 0;
let account: Pool;
let access: Pool;
let relay: Pool;
let content: Pool;
let sealedCoverage = '';
let sealedDeletion = '';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

function startPostgres(data: string, port: number, label: string): void {
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, `${label}.log`),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socketDir}`, '-w', 'start'], { cwd: state });
}

function stopPostgres(data: string): void {
  try { execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state, stdio: 'ignore' }); }
  catch { /* already stopped */ }
}

function database(port: number, name: string, max = 4): Pool {
  const pool = new Pool({ host: '127.0.0.1', port, user, database: name, max });
  pools.push(pool);
  return pool;
}

function boundedDatabase(name: string): Pool {
  const pool = boundedPool({ host: '127.0.0.1', port: restoredPort, user, database: name, max: 1 });
  pools.push(pool);
  return pool;
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(label);
}

beforeAll(async () => {
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', primaryData, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  appendFileSync(join(primaryData, 'postgresql.conf'),
    `\nwal_level = replica\narchive_mode = on\narchive_command = 'test ! -e ${archive}/%f && cp %p ${archive}/%f'\n`);
  const primaryPort = await freePort();
  startPostgres(primaryData, primaryPort, 'primary');
  const admin = database(primaryPort, 'postgres');
  await admin.query('CREATE DATABASE account');
  await admin.query('CREATE DATABASE access');
  await admin.query('CREATE DATABASE relay');
  const accountDb = database(primaryPort, 'account');
  const accessDb = database(primaryPort, 'access');
  const relayDb = database(primaryPort, 'relay');
  for (const table of ACCOUNT_TABLES) {
    const columns = ACCOUNT_KEYS[table] ?? ['id'];
    const defs = columns.map(column => `"${column}" text NOT NULL`).join(', ');
    const key = columns.map(column => `"${column}"`).join(', ');
    await accountDb.query(`CREATE TABLE "${table}" (${defs}, PRIMARY KEY (${key}))`);
  }
  await accessDb.query(`CREATE SCHEMA access`);
  await accessDb.query(`CREATE TABLE access.recovery_fence (
    id boolean PRIMARY KEY, open boolean NOT NULL)`);
  await accessDb.query(`INSERT INTO access.recovery_fence (id, open) VALUES (true, false)`);
  await accessDb.query(`CREATE TABLE access.outbox (
    id uuid PRIMARY KEY, kind text NOT NULL, admission_id uuid, scope_id text,
    principal_id uuid, authority_epoch bigint NOT NULL)`);
  await accessDb.query(`CREATE TABLE access.principal (
    id uuid PRIMARY KEY, active boolean NOT NULL, enforcement_epoch bigint NOT NULL,
    account_issuer text NOT NULL, account_subject text NOT NULL)`);
  await accessDb.query(`CREATE TABLE access.admission (
    id uuid PRIMARY KEY, principal_id uuid NOT NULL, state text NOT NULL)`);
  await accessDb.query(`INSERT INTO access.principal
    (id, active, enforcement_epoch, account_issuer, account_subject)
    VALUES ($1, false, 1, $2, $3)`, [principalId, issuer, subject]);
  await accessDb.query(`INSERT INTO access.outbox (id, kind, principal_id, authority_epoch)
    VALUES ($1, 'principal.deactivated', $2, 1), ($3, 'account.deletion_fenced', $2, 1)`,
  [deactivatedId, principalId, deletionId]);
  await accessDb.query('CREATE SCHEMA commerce');
  for (const [table, columns] of COMMERCE_TABLES) {
    const defs = columns.map(column => `"${column}" text NOT NULL`).join(', ');
    const key = columns.map(column => `"${column}"`).join(', ');
    await accessDb.query(`CREATE TABLE commerce."${table}" (${defs}, PRIMARY KEY (${key}))`);
  }
  await relayDb.query('CREATE SCHEMA relay');
  await relayDb.query(`CREATE TABLE relay.checkpoint (
    consumer text PRIMARY KEY, stream_scope text NOT NULL, data_epoch text NOT NULL, sequence numeric NOT NULL)`);
  await relayDb.query(`CREATE TABLE relay.delivered_batch (
    stream_scope text NOT NULL, data_epoch text NOT NULL, sequence numeric NOT NULL,
    batch_id text NOT NULL, routing_epoch text NOT NULL, event_count integer NOT NULL,
    PRIMARY KEY (stream_scope, data_epoch, sequence))`);
  await relayDb.query(`CREATE TABLE relay.delivered_event (
    stream_scope text NOT NULL, source text NOT NULL, event_id text NOT NULL,
    data_epoch text NOT NULL, sequence numeric NOT NULL, envelope jsonb NOT NULL,
    PRIMARY KEY (stream_scope, source, event_id))`);
  await relayDb.query(`CREATE TABLE relay.account_deletion_intent (
    outbox_id uuid PRIMARY KEY, principal_id uuid NOT NULL UNIQUE, authority_epoch numeric NOT NULL)`);
  await relayDb.query(`CREATE TABLE relay.account_subject_deletion (
    issuer text NOT NULL, account_subject text NOT NULL, PRIMARY KEY (issuer, account_subject))`);
  await relayDb.query(`CREATE TABLE relay.recovery_coverage_head (
    consumer text PRIMARY KEY, coverage_digest text NOT NULL, generation bigint NOT NULL DEFAULT 1)`);
  await relayDb.query(`CREATE TABLE relay.owner_reconciliation (
    id uuid PRIMARY KEY, operation_id text NOT NULL UNIQUE, request_digest text NOT NULL,
    kind text NOT NULL, scope text NOT NULL, consumer text, state text NOT NULL DEFAULT 'running',
    hold_reason text, outcome_digest text, completed_at timestamptz, coverage_generation bigint)`);
  await relayDb.query(`CREATE TABLE relay.owner_reconciliation_item (
    reconciliation_id uuid NOT NULL, ordinal integer NOT NULL, owner text NOT NULL,
    item_kind text NOT NULL, item_ref text NOT NULL, disposition text NOT NULL, evidence_digest text,
    PRIMARY KEY (reconciliation_id, ordinal))`);
  await relayDb.query(`INSERT INTO relay.checkpoint (consumer, stream_scope, data_epoch, sequence)
    VALUES ($1, 'urn:rezics:stream:main-rdf', $2, 0)`, [consumer, epoch]);
  await relayDb.query(`INSERT INTO relay.account_deletion_intent (outbox_id, principal_id, authority_epoch)
    VALUES ($1, $2, 1)`, [deletionId, principalId]);

  const frontier = await capturePgRecoveryFrontier(accountDb);
  const accountRows = await accountRecoveryCoverage(accountDb);
  const outbox = await accessOutboxCoverage(accessDb);
  const stateRows = await accessStateCoverage(accessDb);
  const commerce = await captureCommerceRecoveryCoverage(accessDb);
  const relayCut = await relayCoverage(relayDb, consumer);
  await admin.query('SELECT pg_switch_wal()');
  await waitFor(async () => existsSync(join(archive, frontier.walFile)),
    `WAL ${frontier.walFile} was not archived`);
  execFileSync('pg_basebackup', ['-D', backupData, '-Fp', '-Xs', '--checkpoint=fast',
    '-h', '127.0.0.1', '-p', String(primaryPort), '-U', user], { cwd: state });
  await Promise.all(pools.splice(0).map(pool => pool.end()));
  stopPostgres(primaryData);
  cpSync(backupData, restoredData, { recursive: true });
  appendFileSync(join(restoredData, 'postgresql.auto.conf'),
    `\narchive_mode = off\nrestore_command = 'cp ${archive}/%f %p'\nrecovery_target = 'immediate'\nrecovery_target_action = 'promote'\n`);
  writeFileSync(join(restoredData, 'recovery.signal'), '');
  restoredPort = await freePort();
  startPostgres(restoredData, restoredPort, 'restored');
  const restored = database(restoredPort, 'postgres');
  await waitFor(async () => (await restored.query<{ recovering: boolean }>(
    'SELECT pg_is_in_recovery() AS recovering')).rows[0]?.recovering === false,
  'promoted restore did not leave recovery');
  const covered = await restored.query<{ covered: boolean | null; replay: string | null }>(
    `SELECT pg_last_wal_replay_lsn()::text AS replay,
       pg_last_wal_replay_lsn() >= $1::pg_lsn AS covered`, [frontier.flushedLsn]);
  if (covered.rows[0]?.covered !== true) {
    throw new Error(`replay ${covered.rows[0]?.replay} does not cover ${frontier.flushedLsn}`);
  }
  sealFixture(frontier, accountRows, outbox, stateRows, commerce, relayCut);
  account = boundedDatabase('account');
  access = boundedDatabase('access');
  relay = boundedDatabase('relay');
  content = boundedDatabase('postgres');
}, 180_000);

function sealFixture(frontier: PgRecoveryFrontier, accountRows: AccountRecoveryCoverage,
  outbox: { count: string; digest: string }, stateRows: { count: string; digest: string },
  commerce: CommerceRecoveryCoverage, relayCut: RelayCoverage): void {
  const zeros = 'a'.repeat(64);
  const coverage: RecoveryCoverage = {
    priorDataEpoch: epoch, priorSequence: relayCut.sequence, accountPg: frontier, account: accountRows,
    accessOutboxCount: outbox.count, accessOutboxDigest: outbox.digest,
    accessStateCount: stateRows.count, accessStateDigest: stateRows.digest,
    relay: relayCut, commerce,
    content: { version: 5, dataEpoch: epoch, sequence: '0', graphReferencesCount: '0',
      graphReferencesDigest: zeros, catalogDigest: zeros, tables: {}, excluded: {} },
    objects: { version: 1, referenceCount: '0', referenceDigest: zeros, anchorCount: '0',
      anchorDigest: zeros, objectCount: '0', objectDigest: zeros },
  };
  const deletion: DeletionRecoverySet = {
    version: 1,
    deletion: { issuer, accountSubject: subject, accessPrincipalId: principalId, enforcementEpoch: '1' },
    account: { pg: frontier, rows: accountRows },
    access: { pg: frontier, outbox, state: stateRows },
  };
  sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage, hmacKey, 'graph-recovery-coverage'));
  sealedDeletion = JSON.stringify(sealRecoveryPayload(deletion, hmacKey, 'deletion-recovery-set'));
}

async function withNestedCheckoutThrow<T>(work: () => Promise<T>): Promise<T> {
  const previousMode = nestedPoolCheckoutMode();
  const previousEnv = process.env.REZICS_NESTED_POOL_CHECKOUT;
  process.env.REZICS_NESTED_POOL_CHECKOUT = 'throw';
  setNestedPoolCheckoutMode('throw');
  try { return await work(); }
  finally {
    if (previousEnv === undefined) delete process.env.REZICS_NESTED_POOL_CHECKOUT;
    else process.env.REZICS_NESTED_POOL_CHECKOUT = previousEnv;
    setNestedPoolCheckoutMode(previousMode);
  }
}

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end()));
  stopPostgres(restoredData);
  stopPostgres(primaryData);
  rmSync(state, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
  rmSync(archive, { recursive: true, force: true });
}, 60_000);

test('a relay gap pass reads the retained range on its one held relay connection', async () => {
  const view = await withNestedCheckoutThrow(() => reconcileRelayGap(relay, access, {
    consumer: 'reader', relayConsumer: 'gap-consumer', dataEpoch: epoch,
    afterSequence: '0', throughSequence: '1',
  }, 'gap-pass'));
  expect(view).toMatchObject({ kind: 'relay_gap', state: 'held', disposition: 'gap', replayed: false });
}, 30_000);

test('restore reconciliation reuses the held access and relay connections', async () => {
  const view = await withNestedCheckoutThrow(() => {
    const operations = new OwnerOperations(relay, {
      fuseki: { query: () => { throw new Error('graph was reached before the relay head'); } } as unknown as FusekiClient,
      lineage: { dataEpoch: epoch, routingEpoch }, objectDirectory: state,
    }, { accountPool: account, accessPool: access, contentPool: content, hmacKey,
      objectStore: { directory: state } });
    return operations.reconcileRestore(
      { sealedCoverage, sealedDeletionSets: [sealedDeletion] }, 'restore-pass');
  });
  expect(view).toMatchObject({ kind: 'restore', state: 'held', disposition: 'conflict', replayed: false });
  const reason = await relay.query<{ hold_reason: string }>(
    `SELECT hold_reason FROM relay.owner_reconciliation WHERE operation_id = $1`,
    ['owner:reconcile:restore-pass']);
  expect(reason.rows[0]?.hold_reason).toContain('retained current capture');
}, 30_000);

function checkoutSource(origin: string): string {
  const match = /^(.+):(\d+)(?: \S+)?$/.exec(origin);
  if (!match?.[1] || !match[2]) throw new Error(`not a checkout origin: ${origin}`);
  return readFileSync(resolve(root, match[1]), 'utf8').split('\n')[Number(match[2]) - 1] ?? '';
}

async function nestedOuter(pool: Pool) {
  return pool.connect();
}

async function nestedInner(pool: Pool, text: string) {
  return pool.query(text);
}

test('a nested checkout fault names the outer and inner call sites and omits the query', async () => {
  const secret = 'nested_checkout_query_secret';
  await withNestedCheckoutThrow(async () => {
    const client = await nestedOuter(access);
    try {
      const error = await nestedInner(access, `SELECT '${secret}'`).then(
        () => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(NestedPoolCheckoutError);
      const fault = error as NestedPoolCheckoutError;
      expect(fault.outers.length).toBeGreaterThan(0);
      expect(fault.outers.length).toBeLessThanOrEqual(3);
      for (const field of [fault.inner, ...fault.outers]) {
        expect(field.length).toBeLessThanOrEqual(200);
        expect(field.startsWith('services/main/tests/nested-pool-checkout.test.ts:')).toBe(true);
      }
      expect(fault.outers[0]).toMatch(/nested-pool-checkout\.test\.ts:\d+(?: nestedOuter)?$/);
      expect(fault.inner).toMatch(/nested-pool-checkout\.test\.ts:\d+(?: nestedInner)?$/);
      expect(checkoutSource(fault.outers[0]!)).toContain('pool.connect(');
      expect(checkoutSource(fault.inner)).toContain('pool.query(');
      expect(fault.pool).toBe('access');
      expect(fault.repeats).toBeUndefined();
      const rendered = JSON.stringify(fault);
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain('SELECT');
      expect(rendered).not.toContain('127.0.0.1');
      expect(rendered).not.toContain(String(restoredPort));
    } finally { client.release(); }
  });
}, 30_000);
