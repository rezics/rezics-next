import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import type { FusekiClient, TemplateIndexDelta } from '../src/infrastructure/fuseki.ts';
import {
  boundedPool,
  nestedPoolCheckoutMode,
  setNestedPoolCheckoutMode,
} from '../src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { HeldAccessReceiptCustodyStore } from '../src/modules/access/held-receipt-custody.ts';
import { controlTransaction } from '../src/modules/access/topology-control.ts';
import { AliasRegistry } from '../src/modules/address/registry.ts';
import { DisclosureStore } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { TemplateSeekIndex } from '../src/modules/query/seek-index.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `nested-access-request-paths-${randomUUID()}`);
const data = join(state, 'pgdata');
const previousMode = nestedPoolCheckoutMode();
const holder = () => `https://rezics.com/id/${randomUUID()}`;
const principal: VerifiedPrincipal = {
  issuer: 'https://accounts.example/issuer',
  subject: 'nested-access-reader',
  emailVerified: true,
};
let port: number;
let admin: Pool;
let pool: Pool;
let started = false;

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], {
    cwd: state, stdio: 'pipe',
  });
  port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'), '-o',
    `-h 127.0.0.1 -p ${port} -k /tmp`, '-w', 'start'], { cwd: state, stdio: 'pipe' });
  started = true;
  const config = { host: '127.0.0.1', port, user: process.env.USER, max: 1 };
  admin = boundedPool({ ...config, database: 'postgres' });
  await admin.query('CREATE DATABASE nested_access_paths');
  pool = boundedPool({ ...config, database: 'nested_access_paths', connectionTimeoutMillis: 5_000 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state, stdio: 'pipe' });
  rmSync(state, { recursive: true, force: true });
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

test('an alias read discloses and resolves current holders on the checkout it already holds', async () => {
  const registry = new AliasRegistry(pool);
  const disclosure = new DisclosureStore(pool);
  const subject = holder();
  const decisions = await registry.withRead(async () => {
    const visible = await disclosure.read(
      [{ owner: 'graph', resource: subject, component: 'record' }],
      ANONYMOUS_VIEWER,
      'read',
    );
    const currents = await registry.currents([subject]);
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
  const allowed = await registry.withRead(() => admission.canReadWork(principal, subject, work));
  expect(allowed).toBe(false);
}, 30_000);

test('sibling baseline and topology checkouts of one pool run one at a time', async () => {
  const admission = new AccessAdmissionRegistry(pool);
  const subject = holder();
  const [member] = await Promise.all([
    admission.canReadAsBaselineMember(principal, subject),
    controlTransaction(pool, async () => {}),
    controlTransaction(pool, async () => {}),
  ]);
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
    });
  });
  const rows = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM access.template_seek_pending WHERE epoch = $1', [epoch]);
  expect(rows.rows[0]?.n).toBe(1);
}, 30_000);

test('a topology change during receipt custody reuses the lock connection', async () => {
  const store = new HeldAccessReceiptCustodyStore(pool);
  const receipt = `urn:rezics:receipt:${randomUUID()}`;
  const delta: TemplateIndexDelta = {
    position: { dataEpoch: randomUUID(), sequence: '1' },
    bases: [],
  };
  const fuseki = { attachTemplateIndexWriter() {} } as unknown as FusekiClient;
  await store.withReceipt(receipt, async (session) => {
    await new TemplateSeekIndex(pool, fuseki).apply(delta);
    const state = await session.client!.query<{ in_tx: string | null }>(
      'SELECT pg_current_xact_id_if_assigned()::text AS in_tx');
    expect(state.rows[0]?.in_tx ?? null).toBeNull();
    const pending = await session.client!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM access.template_seek_pending WHERE epoch = $1',
      [delta.position.dataEpoch]);
    expect(pending.rows[0]?.n).toBe(0);
  });
}, 30_000);
