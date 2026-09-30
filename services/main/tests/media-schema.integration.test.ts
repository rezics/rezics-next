import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Pool, type PoolClient } from 'pg';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { mediaTables } from '../src/modules/media/typed-schema.ts';

const root = resolve(import.meta.dir, '../../..');
const migrationDirectory = join(root, 'services/content/migrations');
const MEDIA_VERSION = 70;
const state = join(root, '.temp', `media-schema-${randomUUID()}`);
const data = join(state, 'pgdata');
let port = 0;
let admin: Pool;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const iri = (id: string) => `https://rezics.com/id/${id}`;
const DEFAULT_CONTEXT = 'urn:rezics:media:context:default';

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

function migrationFiles(): Array<{ version: number; name: string }> {
  return readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
    .map(name => ({ version: Number(name.slice(0, 3)), name }));
}

async function database(name: string): Promise<Pool> {
  await admin.query(`CREATE DATABASE ${name}`);
  return new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: name, max: 8 });
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** A succeeded Content receipt at the next owner position, as media commands will write. */
async function receipt(client: PoolClient | Pool, action: string): Promise<{ op: string; epoch: string; sequence: string }> {
  const op = `${action}:${randomUUID()}`;
  const result = await client.query<{ data_epoch: string; sequence: string }>(`WITH position AS (
      UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton RETURNING data_epoch, sequence)
    INSERT INTO content.receipt (operation_id, request_digest, action, outcome, data_epoch, sequence)
    SELECT $1, $2, $3, 'succeeded', data_epoch, sequence FROM position
    RETURNING data_epoch, sequence::text AS sequence`, [op, sha(op), action]);
  return { op, epoch: result.rows[0]!.data_epoch, sequence: result.rows[0]!.sequence };
}

async function rejects(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try { await work; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(String((failure as Error).message)).toMatch(pattern);
}

async function createAsset(pool: Pool, owner: string, upload: { bytes: string; mediaType?: string; digest?: boolean }) {
  const asset = randomUUID();
  const initial = randomUUID();
  const uploadId = randomUUID();
  await transaction(pool, async client => {
    const reserve = await receipt(client, 'media.upload.reserve');
    await client.query(`INSERT INTO media.asset (id, variant_id, owner, media_kind, object_namespace,
      state_head, operation_id) VALUES ($1, $2, $3, 'image', $4, $5, $6)`,
    [asset, `urn:rezics:variant:${asset}`, owner, `media/asset/${asset}/`, initial, reserve.op]);
    await client.query(`INSERT INTO media.asset_state (id, asset_id, predecessor, disclosure, moderation,
      lifecycle, erasure_epoch, actor, authority_epoch, operation_id, data_epoch, sequence)
      VALUES ($1, $2, NULL, 'private', 'none', 'active', 0, $3, '1', $4, $5, $6)`,
    [initial, asset, owner, reserve.op, reserve.epoch, reserve.sequence]);
    await reserveUpload(client, asset, uploadId, upload, reserve.op);
  });
  return { asset, initial, uploadId };
}

async function reserveUpload(client: PoolClient | Pool, asset: string, id: string,
  upload: { bytes: string; mediaType?: string; digest?: boolean }, op?: string, epoch = 0, expires = "interval '1 hour'") {
  const operation = op ?? (await receipt(client, 'media.upload.reserve')).op;
  await client.query(`INSERT INTO media.upload (id, asset_id, principal_id, operation_id, erasure_epoch,
    declared_media_type, declared_byte_length, declared_digest, quarantine_key, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp() + ${expires})`,
  [id, asset, randomUUID(), operation, epoch, upload.mediaType ?? 'image/png', upload.bytes.length,
    upload.digest === false ? null : sha(upload.bytes), `media-quarantine/${id}`]);
}

async function activateOriginal(pool: Pool, asset: string, upload: string, bytes: string, length = bytes.length) {
  const id = randomUUID();
  const settle = await receipt(pool, 'media.upload.settle');
  await pool.query(`INSERT INTO media.representation (id, asset_id, kind, upload_id, byte_digest,
    byte_length, media_type, pixel_width, pixel_height, operation_id)
    VALUES ($1, $2, 'original', $3, $4, $5, 'image/png', 640, 480, $6)`,
  [id, asset, upload, sha(bytes), length, settle.op]);
  return id;
}

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  admin = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
});

afterAll(async () => {
  await admin?.end();
  try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
  finally { rmSync(state, { recursive: true, force: true }); }
});

test('BOOK09/VIEW07/VIEW08: media owner schema installs empty and upgrades from the current Content head', async () => {
  const files = migrationFiles();
  expect(files.some(file => file.version === MEDIA_VERSION)).toBe(true);

  const empty = await database('media_empty');
  try {
    await migrateContent(empty);
    await migrateContent(empty);
    const versions = await empty.query<{ version: number }>('SELECT version FROM content.schema_migration ORDER BY version');
    expect(versions.rows.map(row => row.version)).toEqual(files.map(file => file.version));
    const tables = await empty.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'media' ORDER BY table_name`);
    expect(tables.rows.map(row => row.name)).toEqual(['asset', 'asset_state', 'clearance_decision', 'representation', 'screen_result', 'screen_review',
      'selection_revision', 'selection_slot', 'suppressed_digest', 'transform_job', 'upload', 'use']);
    // The module's typed declarations match the migration's columns, nullability and defaults.
    const columns = await empty.query<{ table: string; column: string; nullable: string; defaulted: boolean }>(`
      SELECT table_name AS table, column_name AS column, is_nullable AS nullable,
        column_default IS NOT NULL AS defaulted
      FROM information_schema.columns WHERE table_schema = 'media' ORDER BY table_name, ordinal_position`);
    const declared = Object.values(mediaTables).flatMap(table => {
      const config = getTableConfig(table);
      return config.columns.map(column => ({ table: config.name, column: column.name,
        nullable: column.notNull ? 'NO' : 'YES', defaulted: column.hasDefault }));
    }).sort((a, b) => a.table.localeCompare(b.table));
    expect(declared).toEqual(columns.rows);
  } finally { await empty.end(); }

  // A retained owner at the preceding head keeps its data and every receipt action it admitted.
  const upgraded = await database('media_upgrade');
  try {
    await upgraded.query(`CREATE SCHEMA content; CREATE TABLE content.schema_migration (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of files.filter(file => file.version < MEDIA_VERSION)) {
      await upgraded.query(readFileSync(join(migrationDirectory, file.name), 'utf8'));
      await upgraded.query('INSERT INTO content.schema_migration (version) VALUES ($1)', [file.version]);
    }
    const content = new ContentCore(upgraded);
    const resource = iri(randomUUID());
    const saved = await content.saveDraft({ operationId: `seed:${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: resource,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: 'retained before media' }) });
    expect(saved.outcome).toBe('succeeded');
    const before = await upgraded.query<{ action: string }>('SELECT action FROM content.receipt_action ORDER BY action');
    const priorActions = before.rows.map(row => row.action);
    expect(priorActions).toContain('draft.save');
    await rejects(receipt(upgraded, 'media.upload.reserve'), /receipt_action_registered/);

    // Retained originals are not grandfathered into clearance at the screen upgrade.
    for (const file of files.filter(file => file.version >= MEDIA_VERSION && file.version < 600)) {
      await upgraded.query(readFileSync(join(migrationDirectory, file.name), 'utf8'));
      await upgraded.query('INSERT INTO content.schema_migration (version) VALUES ($1)', [file.version]);
    }
    const retained = await createAsset(upgraded, iri(randomUUID()), { bytes: 'retained-original' });
    const retainedOriginal = await activateOriginal(upgraded, retained.asset, retained.uploadId, 'retained-original');
    await migrateContent(upgraded);
    await migrateContent(upgraded);
    const original = (await upgraded.query(`SELECT p.clearance, j.status, j.profile
      FROM media.representation p JOIN media.transform_job j ON j.source_id = p.id
      WHERE p.id = $1`, [retainedOriginal])).rows[0];
    expect(original).toEqual({ clearance: 'screening',
      status: 'queued', profile: 'image-screen-v1' });
    const versions = await upgraded.query<{ version: number }>('SELECT version FROM content.schema_migration ORDER BY version');
    expect(versions.rows.map(row => row.version)).toEqual(files.map(file => file.version));
    for (const action of priorActions) await receipt(upgraded, action);
    await receipt(upgraded, 'media.selection.change');
    await rejects(receipt(upgraded, 'media.unknown'), /receipt_action_registered/);
    const exact = await content.readExactBatch([saved.revisionId!], async ids => new Set(ids));
    expect(exact[0]?.status).toBe('available');
  } finally { await upgraded.end(); }
}, 60_000);

test('BOOK09/VIEW07/VIEW08: media schema fences activation, exact use basis, avatar selection and lifecycle', async () => {
  const pool = await database('media_invariants');
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool);
    const owner = iri(randomUUID());
    const target = iri(randomUUID());
    const bytes = 'png-bytes-original';

    await rejects(transaction(pool, async client => {
      const reserve = await receipt(client, 'media.upload.reserve');
      const id = randomUUID();
      await client.query(`INSERT INTO media.asset (id, variant_id, owner, media_kind, object_namespace,
        state_head, operation_id) VALUES ($1, $2, $3, 'image', $4, $5, $6)`,
      [id, `urn:rezics:variant:${randomUUID()}`, owner, `media/asset/${id}/`, randomUUID(), reserve.op]);
    }), /asset_variant_id_check|check constraint/);

    const { asset, initial, uploadId } = await createAsset(pool, owner, { bytes });
    await rejects(activateOriginal(pool, asset, uploadId, bytes, bytes.length - 1), /does not admit these bytes/);
    const original = await activateOriginal(pool, asset, uploadId, bytes);
    const settled = await pool.query('SELECT status FROM media.upload WHERE id = $1', [uploadId]);
    expect(settled.rows[0].status).toBe('activated');
    await rejects(activateOriginal(pool, asset, uploadId, bytes), /does not admit these bytes|duplicate key/);

    const pending = randomUUID();
    await reserveUpload(pool, asset, pending, { bytes: 'second-image' });
    await rejects(pool.query(`UPDATE media.upload SET status = 'activated', settle_operation_id = $2,
      settled_at = clock_timestamp() WHERE id = $1`, [pending, (await receipt(pool, 'media.upload.settle')).op]),
    /activates only with its representation/);
    await rejects(pool.query(`UPDATE media.upload SET status = 'expired', settle_operation_id = $2,
      settled_at = clock_timestamp() WHERE id = $1`, [pending, (await receipt(pool, 'media.upload.settle')).op]),
    /has not expired/);
    const unlisted = await activateOriginal(pool, asset, pending, 'second-image');

    // The asset revision is an ordinary Content revision on the asset's variant.
    const manifest = { profile: 'media-asset-v1', asset: iri(asset), mediaKind: 'image',
      representations: [{ id: original, role: 'original', sha256: sha(bytes), byteLength: bytes.length,
        mediaType: 'image/png', width: 640, height: 480 }] };
    const revision = await content.saveDraft({ operationId: `media-asset-revision:${uploadId}`,
      variant: { id: `urn:rezics:variant:${asset}`, resourceId: iri(asset), language: { kind: 'zxx' },
        direction: 'none' }, expectedHead: null, model: 'media-asset-v1', sourceRevision: null,
      provenance: {}, serializedJson: JSON.stringify(manifest) });
    expect(revision.outcome).toBe('succeeded');

    const createUse = async (representation: string, useTarget = target, role = 'avatar', crop: string | null = null) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO media.use (id, asset_id, asset_variant_id, asset_revision_id,
        representation_id, target, context, role, crop, actor, operation_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, asset, `urn:rezics:variant:${asset}`, revision.revisionId, representation, useTarget,
        DEFAULT_CONTEXT, role, crop, owner, (await receipt(pool, 'media.use.create')).op]);
      return id;
    };
    await rejects(createUse(unlisted), /media use basis/);
    const avatarUse = await createUse(original, target, 'avatar', 'xywh=percent:10,10,50,50');
    const otherUse = await createUse(original, iri(randomUUID()));
    await rejects(pool.query('UPDATE media.use SET crop = NULL WHERE id = $1', [avatarUse]), /immutable Content record/);

    // A rendition activates only from its exact, current, leased transform settlement.
    const profile = 'avatar-256-webp-v1';
    const crop = 'xywh=percent:10,10,50,50';
    const requestJob = async (digest: string, epoch = 0) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO media.transform_job (id, asset_id, source_id, input_digest, profile,
        crop, authority_epoch, erasure_epoch, operation_id) VALUES ($1, $2, $3, $4, $5, $6, '1', $7, $8)`,
      [id, asset, original, digest, profile, crop, epoch, (await receipt(pool, 'media.transform.request')).op]);
      return id;
    };
    await rejects(requestJob(sha('other bytes')), /exact current source/);
    const job = await requestJob(sha(bytes));
    await rejects(requestJob(sha(bytes)), /transform_job_live_idx/);
    const insertRendition = async (jobId: string, op: string) => pool.query(`INSERT INTO media.representation
      (id, asset_id, kind, source_id, transform_job_id, profile, crop, byte_digest, byte_length, media_type,
        pixel_width, pixel_height, operation_id)
      VALUES ($1, $2, 'rendition', $3, $4, $5, $6, $7, 100, 'image/webp', 256, 256, $8)`,
    [randomUUID(), asset, original, jobId, profile, crop, sha(`rendition:${jobId}`), op]);
    await rejects(insertRendition(job, (await receipt(pool, 'media.transform.settle')).op), /exact transform settlement/);
    const token = randomUUID();
    await pool.query(`UPDATE media.transform_job SET status = 'leased', attempt = 1, lease_token = $2,
      lease_expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1`, [job, token]);
    await rejects(pool.query(`UPDATE media.transform_job SET attempt = 2, lease_token = $2,
      lease_expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1`, [job, randomUUID()]),
    /lease is held/);
    const settle = (await receipt(pool, 'media.transform.settle')).op;
    const stale = await pool.query(`UPDATE media.transform_job SET status = 'succeeded', settle_operation_id = $3,
      settled_at = clock_timestamp() WHERE id = $1 AND lease_token = $2`, [job, randomUUID(), settle]);
    expect(stale.rowCount).toBe(0);
    await transaction(pool, async client => {
      const current = await client.query(`UPDATE media.transform_job SET status = 'succeeded',
        settle_operation_id = $3, settled_at = clock_timestamp() WHERE id = $1 AND lease_token = $2`,
      [job, token, settle]);
      expect(current.rowCount).toBe(1);
      await client.query(`INSERT INTO media.representation (id, asset_id, kind, source_id, transform_job_id,
        profile, crop, byte_digest, byte_length, media_type, pixel_width, pixel_height, operation_id)
        VALUES ($1, $2, 'rendition', $3, $4, $5, $6, $7, 100, 'image/webp', 256, 256, $8)`,
      [randomUUID(), asset, original, job, profile, crop, sha('rendition'), settle]);
    });

    // Avatar selection is an explicit-null CAS head with append-only history.
    await pool.query(`INSERT INTO media.selection_slot (target, context, role, policy)
      VALUES ($1, $2, 'avatar', 'avatar-selection-v1')`, [target, DEFAULT_CONTEXT]);
    const select = async (predecessor: string | null, use: string | null, client: Pool | PoolClient = pool) => {
      const id = randomUUID();
      const change = await receipt(client, 'media.selection.change');
      await client.query(`INSERT INTO media.selection_revision (id, target, context, role, predecessor, use_id,
        actor, authority_epoch, operation_id, data_epoch, sequence)
        VALUES ($1, $2, $3, 'avatar', $4, $5, $6, '1', $7, $8, $9)`,
      [id, target, DEFAULT_CONTEXT, predecessor, use, owner, change.op, change.epoch, change.sequence]);
      return id;
    };
    await rejects(select(null, otherUse), /selection_revision_use_id_target_context_role_fkey|foreign key/);
    const concurrent = await Promise.allSettled([0, 1].map(() => transaction(pool, client => select(null, avatarUse, client))));
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(String((concurrent.find(result => result.status === 'rejected') as PromiseRejectedResult).reason))
      .toMatch(/selection head has changed/);
    const first = (await pool.query('SELECT head FROM media.selection_slot WHERE target = $1', [target])).rows[0].head;
    const removed = await select(first, null);
    await rejects(pool.query('UPDATE media.selection_slot SET head = $2 WHERE target = $1', [target, first]),
      /changes only through a selection revision/);
    const { selectionRevision, selectionSlot } = mediaTables;
    const hydrated = await drizzle({ client: pool }).select({ head: selectionSlot.head, use: selectionRevision.useId })
      .from(selectionSlot).innerJoin(selectionRevision, eq(selectionRevision.id, selectionSlot.head))
      .where(inArray(selectionSlot.target, [target]));
    expect(hydrated).toEqual([{ head: removed, use: null }]);

    // Disclosure/lifecycle history: CAS, epoch-advancing deletion, terminal erasure and fences.
    const advance = async (predecessor: string, fields: { disclosure?: string; lifecycle?: string; epoch?: number }) => {
      const id = randomUUID();
      const change = await receipt(pool, 'media.asset.state');
      await pool.query(`INSERT INTO media.asset_state (id, asset_id, predecessor, disclosure, moderation,
        lifecycle, erasure_epoch, actor, authority_epoch, operation_id, data_epoch, sequence)
        VALUES ($1, $2, $3, $4, 'none', $5, $6, $7, '1', $8, $9, $10)`,
      [id, asset, predecessor, fields.disclosure ?? 'public', fields.lifecycle ?? 'active', fields.epoch ?? 0,
        owner, change.op, change.epoch, change.sequence]);
      return id;
    };
    const published = await advance(initial, { disclosure: 'public' });
    await rejects(advance(initial, { disclosure: 'private' }), /state head has changed/);
    await rejects(pool.query('UPDATE media.asset SET state_head = $2 WHERE id = $1', [asset, initial]),
      /changes only through a state record/);
    const staleUpload = randomUUID();
    await reserveUpload(pool, asset, staleUpload, { bytes: 'late-image' });
    await rejects(advance(published, { lifecycle: 'deleted', epoch: 0 }), /lifecycle transition/);
    const deleted = await advance(published, { lifecycle: 'deleted', epoch: 1 });
    await rejects(activateOriginal(pool, asset, staleUpload, 'late-image'), /cannot activate bytes/);
    await rejects(requestJob(sha(bytes), 1), /exact current source/);
    const restored = await advance(deleted, { lifecycle: 'active', epoch: 1 });
    await rejects(activateOriginal(pool, asset, staleUpload, 'late-image'), /does not admit these bytes/);
    const erased = await advance(restored, { lifecycle: 'erased', epoch: 2 });
    await rejects(advance(erased, { lifecycle: 'erased', epoch: 3 }), /lifecycle transition/);
    await pool.query(`UPDATE media.representation SET availability = 'erased' WHERE asset_id = $1`, [asset]);
    await rejects(pool.query(`UPDATE media.representation SET availability = 'available' WHERE id = $1`, [original]),
      /immutable media representation/);
    await rejects(pool.query('DELETE FROM media.asset_state WHERE id = $1', [initial]), /immutable Content record/);
  } finally { await pool.end(); }
}, 60_000);
