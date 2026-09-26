import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrateContent } from '../../content/src/migrate.ts';
import { InvalidStructureObject, STRUCTURE_LIMITS, checkOccurrenceRecord, checkStructureManifest,
  checkStructurePage, type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { stageJob, stagePage } from '../src/modules/structure/stage-schema.ts';
import { InvalidZoneConfiguration, checkZoneConfiguration, type ZoneConfiguration }
  from '../src/modules/zone/config-format.ts';
import { InexactQuantity, exactRational, scaleExact } from '../src/modules/recipe/quantity.ts';
import { ObjectUnavailable } from '../src/infrastructure/immutable-objects.ts';
import { StaleStructureProgress, StructureProgressConflict, StructureProgressStore }
  from '../src/modules/progress/store.ts';
import { checkedOperations } from '../src/modules/structure/change.ts';
import { pinTree } from '../src/modules/structure/change.ts';
import { discoverStructureProfiles } from '../src/modules/structure/profiles.ts';
import { readCompositionSeal } from '../src/modules/structure/seal-read.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { StructureTree, newCost } from '../src/modules/structure/tree.ts';
import { evenKeys, keyBetween } from '../src/modules/structure/order-key.ts';

const root = resolve(import.meta.dir, '../../..');
const migrations = join(root, 'services/content/migrations');
const STAGE_MIGRATION = 30;
const id = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (seed: string) => new Bun.CryptoHasher('sha256').update(seed).digest('hex');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test('COMP05: ordered immutable pages copy a bounded path and dense keys rebalance locally', async () => {
    const retained = new Map<string, Uint8Array>();
    const objects = { put: async (value: Uint8Array) => {
      const digest = createHash('sha256').update(value).digest('hex');
      retained.set(digest, value);
      return digest;
    }, get: async (digest: string) => {
      const value = retained.get(digest);
      if (!value) throw new ObjectUnavailable('test object is missing');
      return value;
    } };
    const parent = id();
    const tree = new StructureTree<{ occurrence: string; parent: string; segmentKey: string;
      orderKey: string }>(objects, 'order',
      entry => entry.orderKey);
    const cost = newCost();
    const initial = await tree.empty(cost);
    const keys = evenKeys(1024);
    const records = new Map(keys.map(key => [key,
      { occurrence: id(), parent, segmentKey: 'a', orderKey: key }]));
    const root = await tree.apply(initial, records, cost);
    expect(root.count).toBe(1024);
    expect(root.level).toBeGreaterThan(0);
    const before = await tree.range(root, '', '\uffff', 1025, newCost());
    expect(before.map(row => row.orderKey)).toEqual(keys);
    const inserted = keyBetween(keys[511]!, keys[512]!);
    expect(inserted > keys[511]!).toBe(true);
    expect(inserted < keys[512]!).toBe(true);
    const editCost = newCost();
    const next = await tree.apply(root, new Map([[inserted,
      { occurrence: id(), parent, segmentKey: 'a', orderKey: inserted }]]), editCost);
    expect(next.count).toBe(1025);
    expect(editCost.pagesWritten).toBeLessThanOrEqual(4);
    expect(editCost.pagesRead).toBeLessThanOrEqual(3);
    expect((await tree.range(root, '', '\uffff', 1025, newCost())).length).toBe(1024);
    expect((await tree.range(next, '', '\uffff', 1026, newCost()))[512]?.orderKey).toBe(inserted);
});

test('COMP01: a second owner registers a Structure profile without changing the Book command', async () => {
  const directory = resolve('.temp', `structure-profile-${randomUUID()}`);
  const ownerDirectory = join(directory, 'collection');
  mkdirSync(ownerDirectory, { recursive: true });
  try {
    await Bun.write(join(ownerDirectory, 'structure-profile.ts'), `export const structureProfiles = [{
      id: 'collection-membership', graphProfile: 'https://rezics.com/vocab/CollectionMembership',
      ownerType: 'https://rezics.com/vocab/Collection', componentType: 'https://rezics.com/vocab/Collection',
      structurePredicate: 'https://rezics.com/vocab/structure', editScopePrefix: 'collection:edit:',
      ownerValidation: { profile: 'collection-curation-v1',
        shape: 'https://rezics.com/definition/collection-curation-v1/collection-shape' },
      editPermission: 'collection:edit', editAction: 'collection.edit', receiptFamily: 'structure-command',
      catalogTargetTypes: ['https://schema.org/Book'],
      roles: ['group', 'member'], targetRoles: ['member'], selectionRequiredRoles: ['member']
    }];`);
    const recipeDirectory = join(directory, 'recipe');
    mkdirSync(recipeDirectory);
    await Bun.write(join(recipeDirectory, 'structure-profile.ts'), `export const structureProfiles = [{
      id: 'recipe-composition', graphProfile: 'https://rezics.com/vocab/RecipeComposition',
      ownerType: 'https://rezics.com/vocab/Recipe', componentType: 'https://rezics.com/vocab/Recipe',
      structurePredicate: 'https://rezics.com/vocab/structure', editScopePrefix: 'recipe:edit:',
      editPermission: 'recipe:edit', editAction: 'recipe.edit', receiptFamily: 'structure-command',
      roles: ['group', 'ingredient', 'step'], targetRoles: [], optionalTargetRoles: ['ingredient'],
      projectQualifier: () => null, hydrateQualifier: async () => undefined
    }];`);
    const profiles = await discoverStructureProfiles(directory);
    expect(profiles.get('collection-membership')?.roles).toEqual(['group', 'member']);
    expect(checkedOperations([{ op: 'insert', parent: id(), position: 'last',
      role: 'member', target: id() }], profiles.get('collection-membership'))).toHaveLength(1);
    expect(() => checkedOperations([{ op: 'insert', parent: id(), position: 'last',
      role: 'member', target: id() }], 'book-composition')).toThrow('role');
    const catalog = 'https://schema.org/Book';
    const catalogOperation = checkedOperations([{ op: 'insert', parent: id(), position: 'last',
      role: 'member', target: catalog }], profiles.get('collection-membership'))[0]!;
    expect(catalogOperation).toMatchObject({ op: 'insert', role: 'member', target: catalog });
    expect(catalogOperation.op === 'insert' ? catalogOperation.selection : 'unexpected').toBeUndefined();
    const activeCatalogMember: OccurrenceRecord = { occurrence: id(), parent: id(), role: 'member',
      state: 'active', segmentKey: 'a', orderKey: 'a', target: catalog, labels: [], introducedBy: id() };
    checkOccurrenceRecord(activeCatalogMember, 'collection-membership', [catalog]);
    expect(() => checkOccurrenceRecord({ ...activeCatalogMember, target: id() },
      'collection-membership', [catalog], ['member'])).toThrow('content target requires a selection policy');
    expect(() => checkedOperations([{ op: 'insert', parent: id(), position: 'last',
      role: 'member', target: 'https://schema.org/Thing' }], profiles.get('collection-membership')))
      .toThrow('native identity');
    expect(checkedOperations([{ op: 'insert', parent: id(), position: 'last',
      role: 'ingredient', qualifier: { type: 'ingredient-line',
        originalText: { value: 'Flour', language: 'en' }, optional: false,
        scaling: 'linear', substituteFor: [], parseStatus: 'unparsed' } }],
    profiles.get('recipe-composition'))).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('COMP01: Zone and Collection own their Structures directly', async () => {
  const profiles = await discoverStructureProfiles();
  const zone = profiles.get('zone-navigation')!;
  const collection = profiles.get('collection-membership')!;
  expect(zone.componentPredicate).toBeUndefined();
  expect(zone.structurePredicate).toBe('https://rezics.com/vocab/navigation');
  expect(collection.componentPredicate).toBeUndefined();
  expect(collection.structurePredicate).toBe('https://rezics.com/vocab/structure');
  expect(collection.selectionRequiredRoles).toEqual(['member']);
});

test('BOOK03: an exact composition seal retains its selected Content revision', async () => {
  const retained = new Map<string, Uint8Array>();
  const objects = { put: async (value: Uint8Array) => {
    const hash = createHash('sha256').update(value).digest('hex');
    retained.set(hash, value);
    return hash;
  }, get: async (hash: string) => {
    const value = retained.get(hash);
    if (!value) throw new ObjectUnavailable('retained seal object missing');
    return value;
  } };
  const structure = id(), seal = id(), structureRevision = id(), occurrence = id(), target = id();
  const selectedRevision = `urn:rezics:content:revision:${randomUUID()}`;
  const tree = pinTree(objects);
  const cost = newCost();
  const pins = await tree.apply(await tree.empty(cost), new Map([[`${occurrence}\u0001`,
    { occurrence, target, revision: selectedRevision }]]), cost);
  const sealDigest = await objects.put(bytes({ format: 'rezics-structure-seal-v1', structure,
    structureRevision, structureManifest: `sha256:${digest('structure')}`, pins,
    coverage: 'complete', unavailableCount: 0,
    model: 'https://rezics.com/definition/structure-composition-v1' }));
  const binding = (value: string) => ({ type: 'literal', value });
  const env = { structureObjects: objects, fuseki: { query: async () => ({ results: { bindings: [{
    revision: binding(structureRevision), manifest: binding(`urn:rezics:sha256:${sealDigest}`),
    coverage: binding('https://rezics.com/vocab/Complete'), unavailable: binding('0'),
    epoch: binding(randomUUID()), sequence: binding('3'),
  }] } }) } } as unknown as WorkActivationEnvironment;
  const first = await readCompositionSeal(env, { structure, seal, limit: 10,
    canReadTarget: async () => true });
  expect(first.pins).toEqual([{ occurrence, target, revision: selectedRevision }]);
  const afterPublication = await readCompositionSeal(env, { structure, seal, limit: 10,
    canReadTarget: async () => true });
  expect(afterPublication.pins).toEqual(first.pins);
  const hidden = await readCompositionSeal(env, { structure, seal, limit: 10,
    canReadTarget: async () => false });
  expect(hidden.pins).toEqual([{ occurrence, unavailable: 'undisclosed' }]);
});

let state = '';
let data = '';
let port = 0;
let server: Pool | undefined;
const pools: Pool[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      probe.close(() => resolvePort(address.port));
    });
  });
}

async function database(name: string): Promise<Pool> {
  await server!.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: name, max: 4 });
  pools.push(pool);
  return pool;
}

async function rejects(action: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try { await action; } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  const detail = failure as { message?: string; constraint?: string };
  expect(`${detail.message ?? ''} ${detail.constraint ?? ''}`).toMatch(pattern);
}

beforeAll(async () => {
  state = join(root, '.temp', `structure-schema-${randomUUID()}`);
  data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  server = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 2 });
});

afterAll(async () => {
  await Promise.all([...pools, ...(server ? [server] : [])].map(pool => pool.end()));
  if (data) execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
  if (state) rmSync(state, { recursive: true, force: true });
});

test('COMP03 owner schema: Content migrations install 030 empty and upgrade from the current head', async () => {
  const local = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  const versions = local.map(name => Number(name.slice(0, 3)));
  expect(versions).toContain(STAGE_MIGRATION);

  const empty = await database('structure_empty');
  await migrateContent(empty);
  await migrateContent(empty);
  const installed = await empty.query<{ version: number }>(
    'SELECT version FROM content.schema_migration ORDER BY version');
  expect(installed.rows.map(row => row.version)).toEqual(versions);
  const tables = await empty.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'structure' ORDER BY table_name`);
  expect(tables.rows.map(row => row.table_name)).toEqual(
    ['progress', 'progress_command', 'stage_job', 'stage_page']);

  // An owner at the head before this task: every earlier migration plus retained rows.
  const upgraded = await database('structure_upgrade');
  await upgraded.query(`CREATE SCHEMA content;
    CREATE TABLE content.schema_migration (version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const name of local.filter(name => Number(name.slice(0, 3)) < STAGE_MIGRATION)) {
    await upgraded.query(readFileSync(join(migrations, name), 'utf8'));
    await upgraded.query('INSERT INTO content.schema_migration (version) VALUES ($1)',
      [Number(name.slice(0, 3))]);
  }
  const variant = `urn:rezics:variant:${randomUUID()}`;
  await upgraded.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'und', 'ltr')`, [variant, id()]);
  const record = randomUUID();
  await upgraded.query(`INSERT INTO source.record (id, provider, namespace, external_id)
    VALUES ($1, 'open-library', 'work', 'OL1W')`, [record]);
  await migrateContent(upgraded);
  await migrateContent(upgraded);
  const after = await upgraded.query<{ version: number }>(
    'SELECT version FROM content.schema_migration ORDER BY version');
  expect(after.rows.map(row => row.version)).toEqual(versions);
  expect((await upgraded.query('SELECT 1 FROM content.variant WHERE id = $1', [variant])).rowCount).toBe(1);
  expect((await upgraded.query('SELECT 1 FROM source.record WHERE id = $1', [record])).rowCount).toBe(1);
  const triggers = await upgraded.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger
    WHERE tgrelid IN ('structure.stage_job'::regclass, 'structure.stage_page'::regclass)
      AND NOT tgisinternal ORDER BY tgname`);
  expect(triggers.rows.map(row => row.tgname)).toEqual(
    ['stage_job_monotone', 'stage_page_checkpoint', 'stage_page_pinned']);
});

test('BOOK02/COMP06: progress keys each occurrence and replays a private command after removal', async () => {
  const pool = pools.find(candidate => candidate.options.database === 'structure_upgrade')!;
  const store = new StructureProgressStore(pool);
  const principal = { issuer: 'https://account.example', subject: randomUUID() };
  const other = { ...principal, subject: randomUUID() };
  const structure = id(), first = id(), repeated = id();
  const command = { principal, structure, occurrence: first, completed: true,
    position: 'paragraph:4', expectedVersion: 0, idempotencyKey: `progress:${randomUUID()}` };
  expect(await store.read(principal, structure, first)).toMatchObject({ version: 0, completed: false });
  expect(await store.write(command)).toMatchObject({ version: 1, completed: true, replayed: false });
  expect(await store.write(command)).toMatchObject({ version: 1, completed: true, replayed: true });
  expect(await store.read(principal, structure, repeated)).toMatchObject({ version: 0, completed: false });
  expect(await store.read(other, structure, first)).toMatchObject({ version: 0, completed: false });
  await expect(store.write({ ...command, occurrence: repeated })).rejects.toBeInstanceOf(
    StructureProgressConflict);
  await expect(store.write({ ...command, idempotencyKey: `progress:${randomUUID()}` }))
    .rejects.toBeInstanceOf(StaleStructureProgress);
  await rejects(pool.query(`DELETE FROM structure.progress_command WHERE principal_issuer = $1
    AND principal_subject = $2 AND idempotency_key = $3`,
  [principal.issuer, principal.subject, command.idempotencyKey]), /immutable/);
  // No active-placement foreign key exists: removing and restoring a placement
  // never rekeys this private state away from the stable occurrence ID.
  expect(await store.read(principal, structure, first)).toMatchObject({ version: 1, position: 'paragraph:4' });
});

interface JobSeed { kind?: string; structure?: string; key?: string; principal?: string;
  sourceRef?: string | null; sourceRevision?: string | null; mappingPolicy?: string | null;
  restoredFrom?: string | null }

async function insertJob(pool: Pool, seed: JobSeed = {}): Promise<{ id: string; structure: string;
  holder: string }> {
  const job = randomUUID();
  const holder = randomUUID();
  const structure = seed.structure ?? id();
  const kind = seed.kind ?? 'import';
  const sourced = ['import', 'refresh', 'capture'].includes(kind);
  await pool.query(`INSERT INTO structure.stage_job (id, principal_id, idempotency_key, request_digest,
      authority_scope, structure, generation, kind, base_head, source_ref, source_revision,
      mapping_policy, restored_from, lease_holder, lease_fence, lease_expires_at, deadline_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1,
      clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 day')`,
  [job, seed.principal ?? randomUUID(), seed.key ?? `stage:${job}`, digest(job),
    `structure:edit:${structure}`, structure, id(), kind, id(),
    seed.sourceRef !== undefined ? seed.sourceRef : sourced ? `urn:rezics:source:${job}` : null,
    seed.sourceRevision !== undefined ? seed.sourceRevision : sourced ? 'source-revision-1' : null,
    seed.mappingPolicy !== undefined ? seed.mappingPolicy
      : ['import', 'refresh'].includes(kind) ? 'source-key' : null,
    seed.restoredFrom !== undefined ? seed.restoredFrom : kind === 'restore' ? id() : null,
    holder]);
  return { id: job, structure, holder };
}

function page(pool: Pool, job: string, ordinal: number, fence: number, tree = 'record', level = 0,
  entries = 3): Promise<unknown> {
  return pool.query(`INSERT INTO structure.stage_page (job_id, ordinal, page_digest, tree, level,
      entry_count, byte_length, lease_fence) VALUES ($1, $2, $3, $4, $5, $6, 1024, $7)`,
  [job, ordinal, digest(`${job}:${ordinal}`), tree, level, entries, fence]);
}

test('COMP03 owner schema: stage pages advance a fenced contiguous checkpoint and settle once', async () => {
  const pool = pools.find(candidate => candidate.options.database === 'structure_upgrade')!;
  const principal = randomUUID();
  const job = await insertJob(pool, { principal, key: 'import:one' });

  // Idempotency and one open stage per Structure.
  await rejects(insertJob(pool, { principal, key: 'import:one' }), /stage_job_principal_id_idempotency_key_key/);
  await rejects(insertJob(pool, { structure: job.structure }), /stage_job_open_structure_idx/);
  await rejects(insertJob(pool, { kind: 'import', sourceRef: null }), /stage_job_check/);
  await rejects(insertJob(pool, { kind: 'replace', mappingPolicy: 'source-key' }), /stage_job_check/);
  await rejects(insertJob(pool, { kind: 'restore', restoredFrom: null }), /stage_job_check/);

  await page(pool, job.id, 0, 1);
  await page(pool, job.id, 1, 1, 'order');
  await rejects(page(pool, job.id, 3, 1), /stage_page_contiguous/);
  await rejects(page(pool, job.id, 2, 2), /stage_page_current_lease/);
  await rejects(pool.query('UPDATE structure.stage_job SET staged_pages = 9 WHERE id = $1', [job.id]),
    /counters advance only with staged pages/);
  const typed = drizzle({ client: pool });
  const [checkpoint] = await typed.select().from(stageJob).where(eq(stageJob.id, job.id));
  expect(checkpoint).toMatchObject({ status: 'staging', stagedPages: 2, stagedRecords: 3,
    stagedBytes: 2048, leaseFence: 1n, kind: 'import', mappingPolicy: 'source-key' });

  // A takeover must advance the fence; the previous holder can no longer stage.
  await rejects(pool.query('UPDATE structure.stage_job SET lease_holder = $2 WHERE id = $1',
    [job.id, randomUUID()]), /fence must advance/);
  await pool.query(`UPDATE structure.stage_job SET lease_holder = $2, lease_fence = 2,
    lease_expires_at = clock_timestamp() + interval '5 minutes' WHERE id = $1`, [job.id, randomUUID()]);
  await rejects(page(pool, job.id, 2, 1), /stage_page_current_lease/);
  await page(pool, job.id, 2, 2, 'record', 1, 2);
  await pool.query(`UPDATE structure.stage_job SET lease_expires_at = clock_timestamp() - interval '1 second'
    WHERE id = $1`, [job.id]);
  await rejects(page(pool, job.id, 3, 2), /stage_page_current_lease/);

  // Seal fixes the complete manifest; activation requires exact graph proof.
  await rejects(pool.query(`UPDATE structure.stage_job SET status = 'sealed' WHERE id = $1`, [job.id]),
    /stage_job_check/);
  await pool.query(`UPDATE structure.stage_job SET status = 'sealed', root_manifest = $2,
    placement_count = 3, source_cursor = 'done', lease_expires_at = clock_timestamp() + interval '5 minutes'
    WHERE id = $1`, [job.id, digest('root')]);
  await rejects(page(pool, job.id, 3, 2), /stage_page_open_job/);
  await rejects(pool.query(`UPDATE structure.stage_job SET status = 'staging' WHERE id = $1`, [job.id]),
    /cannot reopen/);
  await rejects(pool.query(`UPDATE structure.stage_job SET root_manifest = $2 WHERE id = $1`,
    [job.id, digest('other')]), /manifest is immutable/);
  await rejects(pool.query(`UPDATE structure.stage_job SET status = 'activated', lease_holder = NULL,
    lease_expires_at = NULL, settled_at = clock_timestamp() WHERE id = $1`, [job.id]), /stage_job_check/);
  await rejects(pool.query('DELETE FROM structure.stage_page WHERE job_id = $1', [job.id]), /pinned/);
  await pool.query(`UPDATE structure.stage_job SET graph_started = true, projection_batches = 1 WHERE id = $1`,
    [job.id]);
  await rejects(pool.query(`UPDATE structure.stage_job SET projection_batches = 0 WHERE id = $1`, [job.id]),
    /cannot regress/);
  await pool.query(`UPDATE structure.stage_job SET status = 'activated', lease_holder = NULL,
    lease_expires_at = NULL, graph_receipt = $2, graph_data_epoch = $3, graph_sequence = 7,
    revision = $4, settled_at = clock_timestamp() WHERE id = $1`,
  [job.id, `urn:rezics:receipt:${digest('activate')}`, randomUUID(), id()]);
  await rejects(pool.query(`UPDATE structure.stage_job SET failure_reason = 'late' WHERE id = $1`, [job.id]),
    /settled Structure stage job is immutable/);
  await rejects(pool.query('DELETE FROM structure.stage_job WHERE id = $1', [job.id]), /cannot be deleted/);
  await rejects(pool.query('UPDATE structure.stage_page SET level = 0 WHERE job_id = $1', [job.id]), /pinned/);
  expect((await pool.query('DELETE FROM structure.stage_page WHERE job_id = $1', [job.id])).rowCount).toBe(3);

  // A job that reached the graph settles a cancellation only with graph proof.
  const capture = await insertJob(pool, { kind: 'capture' });
  await rejects(pool.query(`UPDATE structure.stage_job SET status = 'sealed', root_manifest = $2,
    placement_count = 0 WHERE id = $1`, [capture.id, digest('capture')]), /stage_job_check/);
  await pool.query('UPDATE structure.stage_job SET graph_started = true WHERE id = $1', [capture.id]);
  await rejects(pool.query(`UPDATE structure.stage_job SET status = 'cancelled', lease_holder = NULL,
    lease_expires_at = NULL, settled_at = clock_timestamp() WHERE id = $1`, [capture.id]), /stage_job_check/);
  await pool.query(`UPDATE structure.stage_job SET status = 'cancelled', lease_holder = NULL,
    lease_expires_at = NULL, graph_receipt = $2, graph_data_epoch = $3, graph_sequence = 8,
    settled_at = clock_timestamp() WHERE id = $1`,
  [capture.id, `urn:rezics:receipt:${digest('cancel')}`, randomUUID()]);
  const replacement = await insertJob(pool, { kind: 'replace', structure: capture.structure });
  expect((await typed.select({ id: stagePage.jobId }).from(stagePage)
    .where(eq(stagePage.jobId, replacement.id))).length).toBe(0);
});

test('COMP01/WIKI01/RECIPE01 owner schema: graph profiles publish shapes and focus roles', async () => {
  // Loaded by path: the model compiler is type-checked by its own owner, not Main's project.
  const { buildArtifacts } = await import(join(root, 'model/compiler/generate.ts')) as
    { buildArtifacts(root: string): Map<string, string> };
  const artifacts = buildArtifacts(root);
  const registry = artifacts.get('packages/model/src/generated/profiles.ts')!;
  const expected: Record<string, string[]> = {
    'structure-composition-v1': ['structure', 'generation', 'segment', 'occurrence', 'placement',
      'removed-placement', 'revision', 'seal'],
    'zone-capability-v1': ['zone', 'mount', 'revision'],
    'collection-curation-v1': ['collection', 'revision', 'definition', 'definition-revision'],
    'recipe-structure-v1': ['ingredient-line', 'step', 'measure'],
  };
  for (const [profile, roles] of Object.entries(expected)) {
    const shape = artifacts.get(`generated/model/shapes/${profile}.ttl`)!;
    for (const role of roles) expect(shape).toContain(`<https://rezics.com/definition/${profile}/${role}-shape>`);
    expect(registry).toContain(`"focusRoles": [\n      ${roles.map(role => `"${role}"`).join(',\n      ')}\n    ]`);
  }
  const structure = artifacts.get('generated/model/shapes/structure-composition-v1.ttl')!;
  expect(structure).toContain('sh:path rv:structureHead ; sh:minCount 1 ; sh:maxCount 1 ; sh:class rv:StructureRevision');
  expect(structure).toContain('sh:path rv:orderKey ; sh:maxCount 0');
  expect(structure).toContain('sh:path rv:pinnedRevision ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
  expect(structure).toContain('sh:path rv:restoredFrom ; sh:minCount 1 ; sh:maxCount 1 ; sh:class rv:StructureRevision');
  const recipe = artifacts.get('generated/model/shapes/recipe-structure-v1.ttl')!;
  expect(recipe).toContain('sh:path rv:amountDenominator ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype xsd:integer ; sh:minInclusive 1');
  expect(recipe).toContain('sh:path rv:basis ; sh:minCount 1 ; sh:maxCount 1 ; sh:in ( rv:PerServing rv:WholeRecipe )');
  const collection = artifacts.get('generated/model/shapes/collection-curation-v1.ttl')!;
  expect(collection).toContain('sh:path rv:capturedFrom ; sh:minCount 1 ; sh:maxCount 1 ; sh:class rv:DynamicCollectionRevision');
});

function record(overrides: Partial<OccurrenceRecord> = {}): OccurrenceRecord {
  return { occurrence: id(), state: 'active', parent: id(), segmentKey: 'm', orderKey: 'h',
    role: 'member', target: id(), selection: { mode: 'follow-context' }, labels: [],
    introducedBy: id(), ...overrides };
}

test('COMP01/COMP06/RECIPE02 owner schema: immutable object formats keep uses, tombstones and exact quantities', () => {
  const target = id();
  const first = record({ target });
  const repeated = record({ target, orderKey: 'p', selection: { mode: 'fixed-revision',
    revision: 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000001' } });
  expect(first.occurrence).not.toBe(repeated.occurrence);
  for (const use of [first, repeated]) checkOccurrenceRecord(use, 'collection-membership', [], ['member']);
  const tombstone = record({ state: 'removed', segmentKey: undefined, orderKey: undefined, removedBy: id() });
  checkOccurrenceRecord(tombstone, 'collection-membership', [], ['member']);
  expect(() => checkOccurrenceRecord({ ...tombstone, orderKey: 'h' }, 'collection-membership', [], ['member']))
    .toThrow(InvalidStructureObject);
  expect(() => checkOccurrenceRecord(first, 'book-composition')).toThrow('not admitted');
  expect(() => checkOccurrenceRecord(record({ role: 'mount', selection: undefined }), 'zone-navigation', [], [])).toThrow('qualifier');
  expect(() => checkOccurrenceRecord(record({ role: 'group', selection: undefined }), 'collection-membership', [], ['member'])).toThrow('target');
  const line = record({ role: 'ingredient', target: undefined, selection: undefined, qualifier: {
    type: 'ingredient-line', originalText: { value: '1½ cups flour, sifted', language: 'en' },
    amountLexical: '1½', amount: { numerator: 3, denominator: 2 }, unitText: 'cups',
    optional: false, scaling: 'linear', substituteFor: [], parseStatus: 'partial' } });
  checkOccurrenceRecord(line, 'recipe-composition');

  const leaf = { format: 'rezics-structure-page-v1', tree: 'record', level: 0,
    entries: [first, repeated, tombstone, line] };
  expect(checkStructurePage(bytes(leaf)).entries).toHaveLength(4);
  expect(() => checkStructurePage(bytes({ ...leaf,
    entries: Array.from({ length: STRUCTURE_LIMITS.pageEntries + 1 }, () => first) })))
    .toThrow(InvalidStructureObject);
  expect(() => checkStructurePage(bytes({ ...leaf, level: 1 }))).toThrow(InvalidStructureObject);

  const manifest: StructureManifest = { format: 'rezics-structure-manifest-v1', structure: id(),
    structureOf: id(), profile: 'recipe-composition', generation: id(),
    pageFormat: 'rezics-structure-page-v1',
    records: { page: `sha256:${digest('records')}`, level: 0, count: 4 },
    order: { page: `sha256:${digest('order')}`, level: 0, count: 3 }, placementCount: 3,
    measures: [{ kind: 'nutrient', nutrient: 'https://schema.org/calories',
      value: { numerator: 250, denominator: 1 }, unitText: 'kcal', basis: 'per-serving',
      coverage: 'partial', provenance: 'computed', evidence: `urn:rezics:sha256:${digest('nutrition')}` }],
    restoredFrom: id(),
    model: 'https://rezics.com/definition/structure-composition-v1',
    shape: 'https://rezics.com/definition/structure-composition-v1' };
  expect(checkStructureManifest(bytes(manifest)).restoredFrom).toBe(manifest.restoredFrom);
  expect(() => checkStructureManifest(bytes({ ...manifest, head: id() }))).toThrow(InvalidStructureObject);

  expect(exactRational(6n, 4n)).toEqual({ numerator: 3n, denominator: 2n });
  expect(scaleExact({ numerator: 3n, denominator: 2n }, { numerator: 1n, denominator: 3n }))
    .toEqual({ numerator: 1n, denominator: 2n });
  expect(exactRational(0n, 8n)).toEqual({ numerator: 0n, denominator: 1n });
  expect(() => exactRational(1n, 0n)).toThrow(InexactQuantity);
  expect(() => exactRational(10n ** 13n, 1n)).toThrow(InexactQuantity);
});

test('VIEW05/VIEW06 owner schema: Zone configuration retains opaque advanced settings and bounds nesting', () => {
  const config: ZoneConfiguration = { format: 'rezics-zone-config-v1', zone: id(), space: id(),
    navigation: id(), state: 'active', disclosure: 'public', defaultRealm: id(),
    budget: { timeMs: 500, rows: 200 },
    queryBlocks: [{ block: 'latest', definition: id(), maxRows: 20 },
      { block: 'latest-by-tag', definition: id(), parent: 'latest', maxRows: 10 }],
    advanced: `sha256:${digest('unknown advanced settings')}`,
    model: 'https://rezics.com/definition/zone-capability-v1' };
  expect(checkZoneConfiguration(bytes(config)).advanced).toBe(config.advanced);
  expect(() => checkZoneConfiguration(bytes({ ...config, theme: 'unknown' }))).toThrow(InvalidZoneConfiguration);
  const chain = Array.from({ length: 5 }, (_, index) => ({ block: `b${index}`, definition: id(),
    ...(index ? { parent: `b${index - 1}` } : {}), maxRows: 1 }));
  expect(() => checkZoneConfiguration(bytes({ ...config, queryBlocks: chain }))).toThrow('nesting');
  expect(() => checkZoneConfiguration(bytes({ ...config,
    queryBlocks: [{ block: 'orphan', definition: id(), parent: 'missing', maxRows: 1 }] }))).toThrow('nesting');
});
