import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS, DBOSClient, WORKFLOW_STATUS_SCAN_RAW_LIMIT } from '@dbos-inc/dbos-sdk';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { installDbosSchema } from '../../scripts/database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import {
  assertScanProducer,
  createScanClient,
  deleteScanRows,
  expectScanIndex,
  insertScanPayload,
  insertScanStatus,
  readAllPages,
  readScanIndex,
  scanPrefix,
} from './support/sdk-workflow-selection.ts';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (databaseUrl === '') throw new Error('DATABASE_URL must name the migrated test database');

const cutoff = 1_700_000_000_000;
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const prefix = scanPrefix();
const names: string[] = [];
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
let client: DBOSClient;
const timeout = 120_000;

beforeAll(async () => {
  assertScanProducer();
  client = await createScanClient(databaseUrl, pool);
});

afterAll(async () => {
  await deleteScanRows(pool, `${prefix}%`);
  await client.destroy();
  await pool.end();
  for (const name of names) await dropTestDatabase(admin, name);
  await admin.end();
});

function id(label: string, index = 0): string {
  return `${prefix}${label}:${String(index).padStart(4, '0')}`;
}

function scratchUrl(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.href;
}

async function createScratch(label: string): Promise<string> {
  const name = `kernel_scan_${label}_${process.pid}`;
  names.push(name);
  await admin.query(`CREATE DATABASE ${name}`);
  return scratchUrl(name);
}

test('DBOS and DBOSClient export the same payload-free scan producer', () => {
  expect(typeof DBOS.openWorkflowStatusScan).toBe('function');
  expect(typeof DBOS.readWorkflowStatusScanPage).toBe('function');
  expect(typeof client.openWorkflowStatusScan).toBe('function');
  expect(typeof client.readWorkflowStatusScanPage).toBe('function');
  expect(WORKFLOW_STATUS_SCAN_RAW_LIMIT).toBe(1000);
});

test('empty, short and full pages advance exclusive keys and report honest examined counts', async () => {
  const application = `${prefix}pages`;
  const empty = await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff });
  expect(empty).toMatchObject({
    applicationName: application,
    createdBefore: cutoff,
    upperKey: null,
    lastExaminedKey: null,
  });
  const vacant = await client.readWorkflowStatusScanPage(empty, { rawLimit: 10 });
  expect(vacant).toMatchObject({ copies: [], examined: 0, exhausted: true, lastExaminedKey: null });

  const shortIds = [id('short', 1), id('short', 2)];
  await insertScanStatus(pool, shortIds, {
    application,
    status: 'SUCCESS',
    createdAt: cutoff - 50,
    completedAt: cutoff - 40,
  });
  await insertScanPayload(pool, shortIds);
  const shortOpen = await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff });
  const short = await client.readWorkflowStatusScanPage(shortOpen, { rawLimit: 10 });
  expect(short.examined).toBe(2);
  expect(short.exhausted).toBe(true);
  expect(short.copies.map((copy) => copy.workflowID)).toEqual(shortIds);
  expect(short.copies[0]).toEqual({
    workflowID: shortIds[0]!,
    workflowName: 'scan.fixture',
    status: 'SUCCESS',
    createdAt: cutoff - 50,
    completedAt: cutoff - 40,
    applicationName: application,
  });

  const fullIds = Array.from({ length: 12 }, (_, index) => id('full', index));
  await insertScanStatus(pool, fullIds, {
    application: `${application}.full`,
    status: 'SUCCESS',
    createdAt: cutoff - 30,
    completedAt: cutoff - 20,
  });
  const fullOpen = await client.openWorkflowStatusScan({
    applicationName: `${application}.full`,
    createdBefore: cutoff,
  });
  const first = await client.readWorkflowStatusScanPage(fullOpen, { rawLimit: 5 });
  expect(first.examined).toBe(5);
  expect(first.exhausted).toBe(false);
  expect(first.copies.map((copy) => copy.workflowID)).toEqual(fullIds.slice(0, 5));
  const second = await client.readWorkflowStatusScanPage(first.continuation, { rawLimit: 5 });
  expect(second.copies.map((copy) => copy.workflowID)).toEqual(fullIds.slice(5, 10));
  const last = await client.readWorkflowStatusScanPage(second.continuation, { rawLimit: 5 });
  expect(last.copies.map((copy) => copy.workflowID)).toEqual(fullIds.slice(10));
  expect(last.examined).toBe(2);
  expect(last.exhausted).toBe(true);
});

test('timestamp ties cross pages by immutable workflow_uuid', async () => {
  const application = `${prefix}ties`;
  const createdAt = cutoff - 100;
  const ids = ['tie-c', 'tie-a', 'tie-b', 'tie-d'].map((label, index) => id(label, index));
  for (const workflowID of ids) {
    await insertScanStatus(pool, [workflowID], { application, status: 'SUCCESS', createdAt, completedAt: createdAt });
  }
  const open = await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff });
  const first = await client.readWorkflowStatusScanPage(open, { rawLimit: 2 });
  const second = await client.readWorkflowStatusScanPage(first.continuation, { rawLimit: 2 });
  expect([...first.copies, ...second.copies].map((copy) => copy.workflowID)).toEqual([...ids].sort());
  expect(first.lastExaminedKey).toEqual({ createdAt, workflowID: [...ids].sort()[1]! });
  expect(second.exhausted).toBe(true);
});

test('pending and old-created recent-completed prefixes cannot starve later eligible copies', async () => {
  const application = `${prefix}prefix`;
  const pending = Array.from({ length: 6 }, (_, index) => id('pending', index));
  const recent = Array.from({ length: 4 }, (_, index) => id('recent', index));
  const eligible = Array.from({ length: 3 }, (_, index) => id('eligible', index));
  await insertScanStatus(pool, pending, {
    application,
    status: 'PENDING',
    createdAt: cutoff - 300,
    completedAt: null,
  });
  await insertScanStatus(pool, recent, {
    application,
    status: 'SUCCESS',
    createdAt: cutoff - 200,
    completedAt: cutoff + 50,
  });
  await insertScanStatus(pool, eligible, {
    application,
    status: 'ERROR',
    createdAt: cutoff - 100,
    completedAt: cutoff - 80,
  });
  await insertScanStatus(pool, [id('foreign', 0)], {
    application: `${application}.other`,
    status: 'SUCCESS',
    createdAt: cutoff - 400,
    completedAt: cutoff - 400,
  });
  const pages = await readAllPages(
    client,
    await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff }),
    5,
  );
  expect(pages.reduce((sum, page) => sum + page.examined, 0)).toBe(13);
  expect(pages.flatMap((page) => page.copies.map((copy) => copy.workflowID))).toEqual(eligible);
  expect(pages.some((page) => page.examined === 5 && page.copies.length === 0)).toBe(true);
  expect(pages.at(-1)?.exhausted).toBe(true);
});

test('serialized continuation resumes after interruption and survives deletion of the previous key', async () => {
  const application = `${prefix}resume`;
  const ids = Array.from({ length: 6 }, (_, index) => id('resume', index));
  await insertScanStatus(pool, ids, {
    application,
    status: 'SUCCESS',
    createdAt: cutoff - 10,
    completedAt: cutoff - 10,
  });
  const open = await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff });
  const first = await client.readWorkflowStatusScanPage(open, { rawLimit: 2 });
  const saved = JSON.parse(JSON.stringify(first.continuation)) as typeof first.continuation;
  await pool.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid = $1', [first.lastExaminedKey?.workflowID]);
  const resumed = await client.readWorkflowStatusScanPage(saved, { rawLimit: 2 });
  expect(resumed.copies.map((copy) => copy.workflowID)).toEqual(ids.slice(2, 4));
  expect(resumed.continuation.applicationName).toBe(application);
  expect(resumed.continuation.createdBefore).toBe(cutoff);
  expect(resumed.continuation.upperKey).toEqual(open.upperKey);
});

test('concurrent insertion and completion follow the fixed horizon; later pending recovery needs a new open', async () => {
  const application = `${prefix}live`;
  const seenPending = id('live', 0);
  const upperPending = id('live', 1);
  const behind = id('live', 2);
  const inside = id('live', 3);
  const after = id('live', 4);
  await insertScanStatus(pool, [seenPending], {
    application,
    status: 'PENDING',
    createdAt: cutoff - 40,
    completedAt: null,
  });
  await insertScanStatus(pool, [upperPending], {
    application,
    status: 'PENDING',
    createdAt: cutoff - 10,
    completedAt: null,
  });
  const open = await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff });
  expect(open.upperKey).toEqual({ createdAt: cutoff - 10, workflowID: upperPending });
  const page = await client.readWorkflowStatusScanPage(open, { rawLimit: 1 });
  expect(page.copies).toEqual([]);
  expect(page.examined).toBe(1);
  expect(page.lastExaminedKey?.workflowID).toBe(seenPending);
  await insertScanStatus(pool, [behind], {
    application,
    status: 'SUCCESS',
    createdAt: cutoff - 50,
    completedAt: cutoff - 50,
  });
  await insertScanStatus(pool, [inside], {
    application,
    status: 'SUCCESS',
    createdAt: cutoff - 25,
    completedAt: cutoff - 25,
  });
  await insertScanStatus(pool, [after], {
    application,
    status: 'SUCCESS',
    createdAt: cutoff - 5,
    completedAt: cutoff - 5,
  });
  await pool.query(`UPDATE dbos.workflow_status SET status = 'SUCCESS', completed_at = $2 WHERE workflow_uuid = $1`, [
    seenPending,
    cutoff - 35,
  ]);
  const rest = await readAllPages(client, page.continuation, 10);
  const seen = rest.flatMap((entry) => entry.copies.map((copy) => copy.workflowID));
  expect(seen).toEqual([inside]);
  expect(seen).not.toContain(behind);
  expect(seen).not.toContain(after);
  expect(seen).not.toContain(seenPending);
  const recovered = await readAllPages(
    client,
    await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff }),
    10,
  );
  expect(recovered.flatMap((entry) => entry.copies.map((copy) => copy.workflowID)).sort()).toEqual(
    [behind, seenPending, inside, after].sort(),
  );
});

test('rawLimit is applied before eligibility and refuses an oversized page', async () => {
  const application = `${prefix}limit`;
  await insertScanStatus(pool, [id('limit', 0)], {
    application,
    status: 'PENDING',
    createdAt: cutoff - 1,
    completedAt: null,
  });
  const open = await client.openWorkflowStatusScan({ applicationName: application, createdBefore: cutoff });
  await expect(client.readWorkflowStatusScanPage(open, { rawLimit: 1001 })).rejects.toThrow(/rawLimit/);
  await expect(client.openWorkflowStatusScan({ applicationName: '', createdBefore: cutoff })).rejects.toThrow(
    /application name/,
  );
});

test(
  'fresh and upgraded SDK schema install the covering scan index without moving earlier migrations',
  async () => {
    const freshUrl = await createScratch('fresh');
    installDbosSchema(freshUrl);
    const fresh = new pg.Client(freshUrl);
    await fresh.connect();
    try {
      expectScanIndex(await readScanIndex(fresh));
      const before = await readScanIndex(fresh);
      installDbosSchema(freshUrl);
      expect(await readScanIndex(fresh)).toBe(before);
      expect(
        (
          await fresh.query<{ version: string }>(
            `SELECT version::text AS version FROM dbos.dbos_migrations ORDER BY version DESC LIMIT 1`,
          )
        ).rows[0]?.version,
      ).toBeDefined();
    } finally {
      await fresh.end();
    }

    const upgradeUrl = await createScratch('upgrade');
    installDbosSchema(upgradeUrl);
    const upgrade = new pg.Client(upgradeUrl);
    await upgrade.connect();
    try {
      await upgrade.query('DROP INDEX dbos.idx_workflow_status_scan');
      await upgrade.query('UPDATE dbos.dbos_migrations SET version = version - 1');
      expect(await readScanIndex(upgrade)).toBeUndefined();
      installDbosSchema(upgradeUrl);
      expectScanIndex(await readScanIndex(upgrade));
      const patch = readFileSync(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../../../patches/@dbos-inc%2Fdbos-sdk@5.5.3-preview.patch',
        ),
        'utf8',
      );
      expect(patch).toContain('Keep the downstream fence migrations at their already-applied positions');
      expect(patch).toContain("require('./selected_step_execution').selectedStepExecutionMigration");
      expect(patch).toContain('workflowStatusScanMigration');
    } finally {
      await upgrade.end();
    }
  },
  timeout,
);
