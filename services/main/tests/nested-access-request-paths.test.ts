import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import {
  boundedPool,
  nestedPoolCheckoutMode,
  setNestedPoolCheckoutMode,
} from '../src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { controlTransaction } from '../src/modules/access/topology-control.ts';
import { PostgresReceiptCustodyStore } from '../src/modules/outbox/receipt-custody.ts';
import { AliasRegistry } from '../src/modules/address/registry.ts';
import { DisclosureStore } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';

const root = resolve(import.meta.dir, '../../..');
const previousMode = nestedPoolCheckoutMode();
const holder = () => `https://rezics.com/id/${randomUUID()}`;
const principal: VerifiedPrincipal = {
  issuer: 'https://accounts.example/issuer',
  subject: 'nested-access-reader',
  emailVerified: true,
};
let cluster: PostgresCluster | undefined;
let admin: Pool;
let pool: Pool;

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  cluster = await startPostgresCluster();
  const config = { ...cluster.connection, max: 1 };
  admin = boundedPool(config);
  await admin.query('CREATE DATABASE nested_access_paths');
  pool = boundedPool({ ...config, database: 'nested_access_paths', connectionTimeoutMillis: 5_000 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  cluster?.remove();
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

test('an alias read discloses and resolves current holders on the checkout it already holds', async () => {
  const registry = new AliasRegistry(pool);
  const disclosure = new DisclosureStore(pool);
  const subject = holder();
  const decisions = await registry.withRead(async (client) => {
    const visible = await disclosure.read(
      [{ owner: 'graph', resource: subject, component: 'record' }],
      ANONYMOUS_VIEWER,
      'read',
      client,
    );
    const currents = await registry.currents([subject], client);
    expect(currents.size).toBe(0);
    return visible;
  });
  expect(decisions).toEqual(['visible']);
}, 30_000);

test('a scoped resource read uses the alias checkout instead of a second one', async () => {
  const registry = new AliasRegistry(pool);
  const admission = new AccessAdmissionRegistry(pool);
  const subject = holder();
  const work = holder();
  const allowed = await registry.withRead(client => admission.canReadWork(principal, subject, work, client));
  expect(allowed).toBe(false);
}, 30_000);

test('a baseline read uses the topology transaction that already holds the connection', async () => {
  const admission = new AccessAdmissionRegistry(pool);
  const subject = holder();
  const member = await controlTransaction(pool, client =>
    admission.canReadAsBaselineMember(principal, subject, client));
  expect(member).toBe(false);
}, 30_000);

test('a nested topology change joins the transaction already open', async () => {
  const epoch = randomUUID();
  await controlTransaction(pool, async (client) => {
    await controlTransaction(pool, async (inner) => {
      expect(inner).toBe(client);
      await inner.query(
        `INSERT INTO access.template_seek_pending(epoch, sequence, id, delta) VALUES ($1, 1, $2, $3)`,
        [epoch, 'nested', { bases: [] }],
      );
    }, false, client);
  });
  const rows = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM access.template_seek_pending WHERE epoch = $1', [epoch]);
  expect(rows.rows[0]?.n).toBe(1);
}, 30_000);

test('a topology change during receipt custody reuses the lock connection', async () => {
  const store = new PostgresReceiptCustodyStore(pool);
  const receipt = `urn:rezics:receipt:${randomUUID()}`;
  const epoch = randomUUID();
  await store.withReceipt(receipt, async (session) => {
    await controlTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO access.template_seek_pending(epoch, sequence, id, delta) VALUES ($1, 1, $2, $3)`,
        [epoch, 'custody', { bases: [] }],
      );
    }, false, session.client);
    const state = await session.client!.query<{ in_tx: string | null }>(
      'SELECT pg_current_xact_id_if_assigned()::text AS in_tx');
    expect(state.rows[0]?.in_tx ?? null).toBeNull();
    const pending = await session.client!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM access.template_seek_pending WHERE epoch = $1', [epoch]);
    expect(pending.rows[0]?.n).toBe(1);
  });
}, 30_000);
