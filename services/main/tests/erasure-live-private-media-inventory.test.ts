import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import sharp from 'sharp';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ObjectNotFound, ObjectReadBudgetExceeded, ObjectListingUnavailable,
  type ImmutableObjects, type ImmutableObjectListOptions } from '../src/infrastructure/immutable-objects.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { applyContentErasure } from '../src/modules/erasure/content.ts';
import { graphErasureReceipt, GraphErasureUnavailable } from '../src/modules/erasure/graph.ts';
import { journalErasure, readErasure, createErasurePreflightBudget, type ErasureTargetInput } from '../src/modules/erasure/journal.ts';
import { applyLiveObjectErasure, objectErasureAbsent } from '../src/modules/erasure/replay-objects.ts';
import { MediaErasureUnsupported, replayMediaErasure, withMediaErasureInventory,
  type MediaErasureBudget, type MediaErasureJournal,
  type MediaErasureSelection } from '../src/modules/media/erasure.ts';
import { assetIri, assetManifest, assetNamespace, assetVariant, DEFAULT_MEDIA_CONTEXT, MediaFenced,
  MediaMissing, MediaStale, MediaStore, type MediaAdmission, type UploadReservation } from '../src/modules/media/store.ts';
import { parseProfile, pixelCrop } from '../src/modules/media-rendition/policy.ts';
import type { RenditionLease } from '../src/modules/media-rendition/store.ts';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const root = resolve(import.meta.dir, '../../..');
const owner = assetIri(randomUUID()), principal = randomUUID();
const mediaAdmission = (): MediaAdmission => ({ admissionId: randomUUID(), principalId: principal,
  actingSubject: owner, authorityEpoch: '1', requestDigest: sha(randomUUID()) });
let image: Buffer;
let cluster: PostgresCluster | undefined;
let admin: Pool;
let reservation: UploadReservation;
let revisionId: string;
let originalId: string;
let templateData: Map<string, Uint8Array>;

class MemoryNamespaces {
  readonly data: Map<string, Uint8Array>;
  readonly listings: { prefix: string; options: ImmutableObjectListOptions }[] = [];
  readonly deletes: string[] = [];
  listingFailure: Error | undefined;
  unexpectedKey: string | undefined;
  onList: ((prefix: string) => Promise<void>) | undefined;
  constructor(data = new Map<string, Uint8Array>()) { this.data = new Map(data); }
  objects = (namespace: string): ImmutableObjects => ({
    put: async (bytes, signal) => {
      signal?.throwIfAborted();
      const digest = sha(bytes);
      this.data.set(`${namespace}sha256/${digest}`, bytes.slice());
      return digest;
    },
    get: async digest => {
      const bytes = this.data.get(`${namespace}sha256/${digest}`);
      if (!bytes) throw new ObjectNotFound('absent');
      return bytes.slice();
    },
    probe: async digest => {
      if (!this.data.has(`${namespace}sha256/${digest}`)) throw new ObjectNotFound('absent');
    },
    deleteAndVerifyAbsent: async digest => {
      const key = `${namespace}sha256/${digest}`;
      this.deletes.push(key);
      this.data.delete(key);
    },
    listPrefix: async (prefix, options) => {
      this.listings.push({ prefix, options });
      await this.onList?.(prefix);
      options.signal?.throwIfAborted();
      if (this.listingFailure) throw this.listingFailure;
      const keys = [...this.data.keys()].filter(key => key.startsWith(prefix)).sort();
      if (this.unexpectedKey) keys.push(this.unexpectedKey);
      if (keys.length > options.maxEntries) throw new ObjectReadBudgetExceeded('complete listing exceeds entry budget');
      return keys;
    },
  });
}

async function activate(store: MediaStore, memory: MemoryNamespaces, bytes: Buffer, asset: string | null) {
  const reserved = await store.reserveUpload(mediaAdmission(), { asset, mediaType: 'image/png',
    byteLength: bytes.length, sha256: sha(bytes), disclosure: 'private' });
  const activated = await store.settleUpload(reserved.upload, { status: 'activated', sha256: sha(bytes),
    byteLength: bytes.length, mediaType: 'image/png', width: 640, height: 320 }, async signal => {
    await memory.objects(`${reserved.quarantineKey}/`).put(bytes, signal);
    return memory.objects(reserved.objectNamespace).put(bytes, signal);
  });
  const recorded = await store.recordAssetRevision(reserved.upload);
  return { reserved, activated, recorded };
}

beforeAll(async () => {
  image = await sharp({ create: { width: 640, height: 320, channels: 3, background: '#bd335b' } }).png().toBuffer();
  cluster = await startPostgresCluster();
  admin = new Pool(cluster.connection);
  await admin.query('CREATE DATABASE media_inventory_template');
  const template = boundedPool({ ...cluster.connection, database: 'media_inventory_template', max: 8 });
  try {
    await migrateContent(template);
    for (const file of schemaFiles(root, 'relay')) {
      await template.query(readFileSync(join(root, 'services/main/migrations/relay', file), 'utf8'));
    }
    await template.query(`CREATE SCHEMA access;
      CREATE TABLE access.governance_preservation_hold (
        id uuid PRIMARY KEY,target_resource text NOT NULL,reason text NOT NULL,released_at timestamptz);
      CREATE TABLE access.governance_erasure_postponement (
        hold_id uuid NOT NULL,operation_id text NOT NULL,material_ref text NOT NULL,reason text NOT NULL,
        PRIMARY KEY (hold_id,operation_id,material_ref))`);
    const memory = new MemoryNamespaces();
    const prepared = await activate(new MediaStore(template, new ContentCore(template)), memory, image, null);
    reservation = prepared.reserved;
    revisionId = prepared.recorded.revision;
    originalId = prepared.activated.representation;
    templateData = memory.data;
  } finally { await template.end(); }
}, 60_000);

afterAll(async () => { await admin?.end(); cluster?.remove(); });

async function fixture(run: (f: Awaited<ReturnType<typeof mediaFixture>>) => Promise<void>) {
  const name = `media_inventory_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE media_inventory_template`);
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  // Keep the owner/request boundaries even though their schemas share one
  // restored fixture database. Every runtime pool remains instrumented.
  const preservationPool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  const relay = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  const contentWriter = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  try { await run(await mediaFixture(pool, preservationPool, relay, contentWriter)); }
  finally {
    await Promise.all([pool.end(), preservationPool.end(), relay.end(), contentWriter.end()]);
    await admin.query(`DROP DATABASE ${name}`);
  }
}

async function mediaFixture(pool: Pool, preservationPool: Pool, relay: Pool, contentWriter: Pool) {
  const content = new ContentCore(pool), store = new MediaStore(pool, content);
  const memory = new MemoryNamespaces(templateData);
  const revisions = [revisionId];
  const admission: RegisteredAdmission = { id: randomUUID(), principalId: principal, actingSubject: owner,
    scope: `erasure:${assetIri(reservation.asset)}`, action: 'erasure.request', idempotencyKey: randomUUID(),
    requestDigest: sha(randomUUID()), authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: false };
  const selection: MediaErasureSelection = { asset: reservation.asset, revisionIds: revisions, admission };
  const lineage = { dataEpoch: randomUUID(), routingEpoch: '0' };
  let graphSuppressed = true;
  const graph = { lineage, fuseki: new class extends FusekiClient {
    constructor() { super('http://media-inventory.invalid'); }
    override async query() {
      return { results: { bindings: graphSuppressed ? revisions.map(id => ({
        target: { type: 'uri' as const, value: `urn:rezics:content:revision:${id}` },
        sequence: { type: 'literal' as const, value: '1' },
        currentSequence: { type: 'literal' as const, value: '1' },
        receiptEpoch: { type: 'literal' as const, value: lineage.dataEpoch },
      })) : [] } };
    }
  }() };
  const preflight = <T>(accept: Parameters<typeof withMediaErasureInventory<T>>[4], budget?: MediaErasureBudget) =>
    withMediaErasureInventory(pool, selection, preservationPool, memory.objects, accept, budget);
  const journal = async (targets: readonly ErasureTargetInput[]): Promise<MediaErasureJournal> => {
    const entry = await journalErasure(relay, { operationId: `erasure:${admission.id}`,
      requestDigest: admission.requestDigest, kind: 'revision', principalId: admission.principalId,
      admissionId: admission.id, authorityEpoch: admission.authorityEpoch, targets: [...targets] });
    return { relay, erasureId: entry.erasureId, erasureEpoch: entry.erasureEpoch, graph };
  };
  const erase = () => preflight(async (inventory, apply) => {
    const retained = await journal(inventory.targets);
    await apply(retained);
    return { inventory, retained };
  });
  const newRevision = async (number: number) => {
    const head = (await store.readAsset(reservation.asset))!.revision;
    const result = await content.saveDraft({ operationId: `retained-media-revision:${number}:${randomUUID()}`,
      variant: { id: assetVariant(reservation.asset), resourceId: assetIri(reservation.asset),
        language: { kind: 'zxx' }, direction: 'none' }, expectedHead: head, model: 'media-asset-v1',
      sourceRevision: null, provenance: {}, serializedJson: assetManifest(reservation.asset, { id: originalId,
        sha256: sha(image), byteLength: image.length, mediaType: 'image/png', width: 640, height: 320 }) });
    if (result.outcome !== 'succeeded' || !result.revisionId) throw new Error('fixture revision was refused');
    return result.revisionId;
  };
  const queue = async (crop: string | null) => {
    const selected = await store.selectAvatar(mediaAdmission(), { target: owner, context: DEFAULT_MEDIA_CONTEXT,
      expectedSelection: (await store.avatarRows([owner], DEFAULT_MEDIA_CONTEXT)).rows.get(owner)?.selection ?? null,
      asset: reservation.asset, crop });
    if (selected.outcome !== 'succeeded') throw new Error('fixture Use was refused');
    const use = (await pool.query<{ use_id: string }>('SELECT use_id::text FROM media.selection_revision WHERE id=$1',
      [selected.id])).rows[0]!.use_id;
    const basis = await store.renditions.requestBasis(use);
    await store.renditions.queue(basis, { width: 640, height: 320 });
  };
  const outputFor = async (lease: Pick<RenditionLease, 'profile' | 'crop'>) => {
    const profile = parseProfile(lease.profile), crop = pixelCrop(lease.crop, { width: 640, height: 320 });
    const width = Math.min(profile.width, crop.width), height = Math.round(crop.height * width / crop.width);
    const bytes = await sharp(image).extract(crop).resize(width, height).toFormat(profile.type === 'image/webp' ? 'webp' : 'avif').toBuffer();
    return { bytes, width, height, type: profile.type };
  };
  return { pool, preservationPool, relay, contentWriter, content, store, memory, revisions, admission, selection, graph, preflight, journal, erase,
    newRevision, queue, outputFor, suppressGraph: (value: boolean) => { graphSuppressed = value; } };
}

async function assertUnchanged(f: Awaited<ReturnType<typeof mediaFixture>>,
  before: Awaited<ReturnType<MediaStore['readAsset']>>, keys: readonly string[]) {
  expect(await f.store.readAsset(reservation.asset)).toEqual(before);
  expect([...f.memory.data.keys()].sort()).toEqual([...keys].sort());
  expect(f.memory.deletes).toEqual([]);
  expect((await f.pool.query('SELECT id FROM relay.erasure')).rows).toEqual([]);
}

test('P3 exact originals, quarantine, crop, width and small thumbnail outputs enter one complete closure', async () => {
  await fixture(async f => {
    await f.queue(null);
    await f.queue('xywh=percent:0,0,10,10');
    const dimensions: number[] = [];
    for (;;) {
      const lease = await f.store.renditions.leaseNext();
      if (!lease) break;
      const output = await f.outputFor(lease);
      expect(await f.store.renditions.settle(lease, output, signal => f.memory.objects(lease.namespace).put(output.bytes, signal)))
        .toBe(true);
      dimensions.push(output.width);
    }
    expect(dimensions).toContain(320);
    expect(dimensions).toContain(640);
    expect(dimensions).toContain(64);
    const keys = [...f.memory.data.keys()];
    const { inventory, retained } = await f.erase();
    const objectRefs = inventory.targets.filter(target => target.kind === 'object').map(target => target.ref);
    expect(objectRefs).toHaveLength(keys.length);
    expect(inventory.targets).toContainEqual({ kind: 'content_variant', ref: assetVariant(reservation.asset) });
    expect(f.memory.listings.map(list => list.prefix).sort()).toEqual([
      reservation.objectNamespace, `${reservation.quarantineKey}/`,
    ].sort());
    expect(f.memory.listings.reduce((sum, list) => sum + list.options.maxResponseBytes!, 0)).toBeLessThanOrEqual(1024 * 1024);
    expect((await f.store.readAsset(reservation.asset))!).toMatchObject({ lifecycle: 'erased', erasureEpoch: '1' });
    expect((await f.pool.query('SELECT DISTINCT availability FROM media.representation')).rows).toEqual([{ availability: 'erased' }]);
    // Media terminalization precedes the completion owner's physical work.
    expect([...f.memory.data.keys()].sort()).toEqual(keys.sort());
    const objectStore = { directory: '.temp/media-inventory-no-work-objects', mediaObjects: {
      asset: (asset: string) => f.memory.objects(assetNamespace(asset)),
      quarantine: (upload: string) => f.memory.objects(`media-quarantine/${upload}/`),
    } };
    for (const ref of objectRefs) {
      expect(await applyLiveObjectErasure(objectStore, ref, { kind: 'live-bounded', references: new Set() }, true)).toBe('replayed');
      expect(await objectErasureAbsent(objectStore, ref)).toBe(true);
    }
    expect(f.memory.data.size).toBe(0);
    const before = await f.store.readAsset(reservation.asset);
    await replayMediaErasure(f.pool, f.selection, f.preservationPool, retained);
    expect(await f.store.readAsset(reservation.asset)).toEqual(before);
    expect((await f.pool.query('SELECT id FROM media.asset_state WHERE lifecycle=\'erased\'')).rowCount).toBe(1);
    const erasedReport = await readErasure(f.pool, retained.erasureId);
    expect(erasedReport.destruction).toBe('pending');
  });
});

test('P3 put then rollback and expired-lease rendition orphans are inventoried without representation rows', async () => {
  await fixture(async f => {
    await f.queue(null);
    const first = (await f.store.renditions.leaseNext())!, output = await f.outputFor(first);
    await expect(f.store.renditions.settle(first, output, async signal => {
      await f.memory.objects(first.namespace).put(output.bytes, signal);
      throw new Error('settlement failed after put');
    })).rejects.toThrow('settlement failed after put');
    // Encode the next queued output before taking its short lease. Only the controlled
    // persistence delay consumes the lease, independent of encoder speed on this host.
    const queued = (await f.pool.query<{ id: string; profile: string; crop: string | null }>(
      "SELECT id::text,profile,crop FROM media.transform_job WHERE status='queued' ORDER BY created_at,id LIMIT 1")).rows[0]!;
    const orphan = await f.outputFor(queued);
    const fresh = (await f.store.renditions.leaseNext(2_000))!;
    expect(fresh.job).toBe(queued.id);
    let persisted = false;
    expect(await f.store.renditions.settle(fresh, orphan, async signal => {
      const digest = await f.memory.objects(fresh.namespace).put(orphan.bytes, signal);
      persisted = true;
      await new Promise(resolve => setTimeout(resolve, 2_010));
      return digest;
    })).toBe(false);
    expect(persisted).toBe(true);
    for (const digest of [sha(output.bytes), sha(orphan.bytes)]) {
      expect((await f.pool.query('SELECT id FROM media.representation WHERE byte_digest=$1', [digest])).rowCount).toBe(0);
    }
    const { inventory } = await f.erase();
    for (const digest of [sha(output.bytes), sha(orphan.bytes)]) {
      expect(inventory.targets).toContainEqual({ kind: 'object', ref: `media-asset:v1:${reservation.asset}:sha256:${digest}` });
    }
  });
});

test('P3 an already absent quarantine copy retains its exact original/upload identity', async () => {
  await fixture(async f => {
    f.memory.data.delete(`${reservation.quarantineKey}/sha256/${sha(image)}`);
    const { inventory } = await f.erase();
    expect(inventory.targets).toContainEqual({ kind: 'object', ref: `media-quarantine:v1:${reservation.upload}:sha256:${sha(image)}` });
  });
});

test('P5 incomplete revision selection refuses the complete asset before listing or mutation', async () => {
  await fixture(async f => {
    const next = await activate(f.store, f.memory, await sharp(image).negate().png().toBuffer(), reservation.asset);
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.erase()).rejects.toBeInstanceOf(MediaErasureUnsupported);
    expect(f.memory.listings).toEqual([]);
    await assertUnchanged(f, before, keys);
    f.revisions.push(next.recorded.revision);
    const { inventory } = await f.erase();
    expect([...inventory.revisionIds].sort()).toEqual([...f.revisions].sort());
    expect(inventory.targets.filter(target => target.kind === 'object')).toHaveLength(4);
  });
});

test('P5 a 65th retained revision refuses without trimming or reading manifests', async () => {
  await fixture(async f => {
    for (let number = 1; number <= 64; number++) {
      const id = await f.newRevision(number);
      if (number < 64) f.revisions.push(id);
    }
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.erase()).rejects.toBeInstanceOf(MediaErasureUnsupported);
    expect(f.memory.listings).toEqual([]);
    await assertUnchanged(f, before, keys);
  });
});

test('P5 indexed upload and physical orphan overflow refuse before any erasure', async () => {
  await fixture(async f => {
    for (let number = 0; number < 64; number++) {
      await f.store.reserveUpload(mediaAdmission(), { asset: reservation.asset, mediaType: 'image/png',
        byteLength: image.length, sha256: sha(image), disclosure: 'private' });
    }
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.erase()).rejects.toBeInstanceOf(MediaErasureUnsupported);
    expect(f.memory.listings).toEqual([]);
    await assertUnchanged(f, before, keys);
  });
  await fixture(async f => {
    for (let number = 0; number < 257; number++) await f.memory.objects(reservation.objectNamespace).put(Buffer.from(`orphan:${number}`));
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.erase()).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
    expect(f.memory.listings).toHaveLength(1);
    expect(f.memory.listings[0]!.options.maxEntries).toBe(252);
    await assertUnchanged(f, before, keys);
  });
});

test('P5 shared target and metadata ceilings refuse before lifecycle or physical erasure', async () => {
  await fixture(async f => {
    const budget: MediaErasureBudget = { ...createErasurePreflightBudget(), targets: Array.from({ length: 254 }, (_, index) => ({ kind: 'object', ref: `sha256:${sha(String(index))}` })),
      indexedUnits: 0, inventoryEntries: 0, metadataBytes: 0, listingBytes: 0 };
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.preflight(async () => { throw new Error('must not accept overflow'); }, budget)).rejects.toBeInstanceOf(MediaErasureUnsupported);
    expect(f.memory.listings).toEqual([]);
    await assertUnchanged(f, before, keys);
  });
  await fixture(async f => {
    const budget: MediaErasureBudget = { ...createErasurePreflightBudget(), targets: [], indexedUnits: 0, inventoryEntries: 0,
      metadataBytes: 8 * 1024 * 1024, listingBytes: 0 };
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.preflight(async () => { throw new Error('must not accept overflow'); }, budget)).rejects.toBeInstanceOf(MediaErasureUnsupported);
    await assertUnchanged(f, before, keys);
  });
});

test('P5 SQL inventory stops at one lookahead when another owner consumed the shared entry budget', async () => {
  for (const overflow of ['revisions', 'uploads'] as const) await fixture(async f => {
    if (overflow === 'revisions') {
      f.revisions.push(await f.newRevision(1), await f.newRevision(2));
    } else {
      for (let index = 0; index < 5; index++) await f.store.reserveUpload(mediaAdmission(), {
        asset: reservation.asset, mediaType: 'image/png', byteLength: image.length, sha256: sha(image), disclosure: 'private' });
    }
    const budget: MediaErasureBudget = { ...createErasurePreflightBudget(), targets: [], indexedUnits: 0,
      inventoryEntries: overflow === 'revisions' ? 255 : 251, metadataBytes: 0, listingBytes: 0 };
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.preflight(async () => { throw new Error('must not accept overflow'); }, budget))
      .rejects.toBeInstanceOf(MediaErasureUnsupported);
    expect(budget.inventoryEntries).toBeLessThanOrEqual(257);
    expect(f.memory.listings).toEqual([]);
    await assertUnchanged(f, before, keys);
  });
});

test('P5 history inventory plans use owner indexes without sorting and examine only one lookahead as history grows', async () => {
  await fixture(async f => {
    // Capture the SQL issued by the owner rather than prove a separately authored query.
    const spies: { mock: { calls: unknown[][] }; mockRestore: () => void }[] = [];
    const clients = new Set<PoolClient>();
    const observe = (client: PoolClient) => {
      if (clients.has(client)) return;
      clients.add(client);
      spies.push(spyOn(client, 'query'));
    };
    f.pool.on('acquire', observe);
    let queries: { sql: string; values: unknown[] }[];
    try {
      await f.preflight(async inventory => inventory);
      queries = spies.flatMap(spy => spy.mock.calls.flatMap(([sql, values]) =>
        typeof sql === 'string' && Array.isArray(values) && sql.startsWith('SELECT')
          && /FROM (content\.revision|media\.(representation|upload)) \w+ WHERE/.test(sql)
          ? [{ sql, values: [...values] }] : []));
    } finally {
      f.pool.off('acquire', observe);
      for (const spy of spies) spy.mockRestore();
    }
    expect(queries).toHaveLength(3);
    const indexes = new Map([
      ['content.revision', 'revision_variant_created_idx'],
      ['media.representation', 'representation_asset_id_id_key'],
      ['media.upload', 'upload_asset_id_id_key'],
    ]);
    type Plan = {
      'Node Type': string;
      'Index Name'?: string;
      'Index Cond'?: string;
      'Actual Rows'?: number;
      'Actual Loops'?: number;
      'Rows Removed by Filter'?: number;
      'Rows Removed by Index Recheck'?: number;
      Plans?: Plan[];
    };
    const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const samples: number[][] = [];
    // Scale validated owner records without command/encoder latency; every media
    // constraint and lifecycle trigger remains enabled, with no planner overrides.
    const seedHistory = async (asset: string, count: number) => {
      const client = await f.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE TEMP TABLE inventory_seed ON COMMIT DROP AS
          SELECT n,gen_random_uuid() AS upload,gen_random_uuid() AS representation,gen_random_uuid() AS revision
          FROM generate_series(1,$1::int) n`, [count]);
        await client.query('UPDATE content.owner_control SET sequence=sequence+$1', [count * 2]);
        await client.query(`INSERT INTO content.receipt
          SELECT (jsonb_populate_record(NULL::content.receipt,to_jsonb(r) || jsonb_build_object(
            'operation_id',identity.operation_id,'revision_id',NULL,
            'sequence',c.sequence-$2::int*2+identity.position))).*
          FROM inventory_seed i CROSS JOIN content.owner_control c
          JOIN media.upload u ON u.asset_id=$1 AND u.id=(SELECT id FROM media.upload WHERE asset_id=$1 LIMIT 1)
          CROSS JOIN LATERAL (VALUES
            (u.operation_id,'inventory-upload:'||i.upload,i.n*2-1),
            (u.settle_operation_id,'inventory-settle:'||i.upload,i.n*2))
            identity(template_operation,operation_id,position)
          JOIN content.receipt r ON r.operation_id=identity.template_operation`, [asset, count]);
        await client.query(`INSERT INTO media.upload
          SELECT (jsonb_populate_record(NULL::media.upload,to_jsonb(u) || jsonb_build_object(
            'id',i.upload,'operation_id','inventory-upload:'||i.upload,
            'quarantine_key','media-quarantine/'||i.upload,'status','reserved','reason',NULL,
            'settle_operation_id',NULL,'settled_at',NULL,'expires_at',clock_timestamp()+interval '1 hour'))).*
          FROM inventory_seed i CROSS JOIN LATERAL
            (SELECT * FROM media.upload WHERE asset_id=$1 AND status='activated' LIMIT 1) u`, [asset]);
        await client.query(`INSERT INTO media.representation
          SELECT (jsonb_populate_record(NULL::media.representation,to_jsonb(r) || jsonb_build_object(
            'id',i.representation,'upload_id',i.upload,'operation_id','inventory-settle:'||i.upload))).*
          FROM inventory_seed i CROSS JOIN LATERAL
            (SELECT * FROM media.representation WHERE asset_id=$1 AND kind='original' LIMIT 1) r`, [asset]);
        // Timestamp ties also exercise UUID ordering in the retained-revision index.
        await client.query(`INSERT INTO content.revision
          SELECT (jsonb_populate_record(NULL::content.revision,to_jsonb(r) || jsonb_build_object(
            'id',i.revision,'operation_id','inventory-revision:'||i.revision,'predecessor',r.id))).*
          FROM inventory_seed i CROSS JOIN LATERAL
            (SELECT * FROM content.revision WHERE variant_id=$1 LIMIT 1) r`, [assetVariant(asset)]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    };
    // Keep unrelated history fixed and large enough that the 100-row sample is
    // selective too, rather than benchmark the planner's tiny-table fallback.
    const other = await activate(f.store, f.memory, image, null);
    await seedHistory(other.reserved.asset, 9999);
    let seeded = 1;
    for (const size of [100, 1000]) {
      await seedHistory(reservation.asset, size - seeded);
      seeded = size;
      await f.pool.query('ANALYZE content.revision; ANALYZE media.representation; ANALYZE media.upload');
      const examined: number[] = [];
      for (const { sql, values } of queries) {
        const table = [...indexes.keys()].find(name => sql.includes(`FROM ${name} `))!;
        const inventoryKey = table === 'content.revision' ? assetVariant(reservation.asset) : reservation.asset;
        const keyColumn = table === 'content.revision' ? 'variant_id' : 'asset_id';
        expect((await f.pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${keyColumn}=$1`,
          [inventoryKey])).rows).toEqual([{ count: size }]);
        const explain = async (analyze: boolean) => (await f.pool.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
          `EXPLAIN (${analyze ? 'ANALYZE, TIMING OFF, ' : ''}FORMAT JSON) ${sql}`, values)).rows[0]!['QUERY PLAN'][0]!.Plan;
        // The planned shape is a Limit directly over the migration's owner index.
        for (const plan of [await explain(false), await explain(true)]) {
          expect(nodes(plan).filter(node => node['Node Type'].includes('Sort'))).toEqual([]);
          expect(plan['Node Type']).toBe('Limit');
          expect(plan.Plans).toHaveLength(1);
          const child = plan.Plans![0]!;
          expect(['Index Scan', 'Index Only Scan']).toContain(child['Node Type']);
          expect(child['Index Name']).toBe(indexes.get(table));
          expect(child['Index Cond']).toContain(keyColumn);
          if (child['Actual Rows'] !== undefined) {
            expect(child['Actual Loops']).toBe(1);
            const read = child['Actual Rows'] + (child['Rows Removed by Filter'] ?? 0)
              + (child['Rows Removed by Index Recheck'] ?? 0);
            expect(read).toBe(values[1] as number);
            expect(plan['Actual Rows']).toBe(values[1] as number);
            examined.push(read);
          }
        }
      }
      samples.push(examined);
      const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
      const listings = f.memory.listings.length;
      await expect(f.erase()).rejects.toBeInstanceOf(MediaErasureUnsupported);
      expect(f.memory.listings).toHaveLength(listings);
      await assertUnchanged(f, before, keys);
    }
    expect(samples).toEqual([[65, 65, 64], [65, 65, 64]]);
  });
}, 120_000);

test('P3 incomplete, unsupported and unexpected-key listings refuse before mutation', async () => {
  for (const failure of ['incomplete', 'unsupported', 'unexpected'] as const) await fixture(async f => {
    if (failure === 'incomplete') f.memory.listingFailure = new ObjectListingUnavailable('truncated listing');
    if (failure === 'unsupported') {
      const objects = f.memory.objects;
      f.memory.objects = namespace => ({ ...objects(namespace), listPrefix: undefined });
    }
    if (failure === 'unexpected') f.memory.unexpectedKey = 'media/asset/foreign/sha256/' + sha('foreign');
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.erase()).rejects.toThrow();
    await assertUnchanged(f, before, keys);
  });
});

test('P3 attachment authority and preservation holds cannot admit media erasure', async () => {
  await fixture(async f => {
    f.admission.action = 'media.manage';
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.erase()).rejects.toBeInstanceOf(MediaFenced);
    expect(f.memory.listings).toEqual([]);
    await assertUnchanged(f, before, keys);
    f.admission.action = 'erasure.request';
    f.admission.scope = `erasure:${assetIri(randomUUID())}`;
    await expect(f.erase()).rejects.toBeInstanceOf(MediaFenced);
    await assertUnchanged(f, before, keys);
  });
  await fixture(async f => {
    await f.pool.query(`INSERT INTO access.governance_preservation_hold(id,target_resource,reason)
      VALUES ($1,$2,'retained evidence')`, [randomUUID(), assetIri(reservation.asset)]);
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.erase()).rejects.toBeInstanceOf(MediaFenced);
    expect(f.memory.listings).toEqual([]);
    await assertUnchanged(f, before, keys);
    expect((await f.pool.query('SELECT material_ref FROM access.governance_erasure_postponement')).rows)
      .toEqual([{ material_ref: assetIri(reservation.asset) }]);
  });
});

test('P4 a missing native graph proof, wrong journal epoch or omitted object refuses owner mutation', async () => {
  for (const mismatch of ['graph', 'epoch', 'object'] as const) await fixture(async f => {
    const before = await f.store.readAsset(reservation.asset), keys = [...f.memory.data.keys()];
    await expect(f.preflight(async (inventory, apply) => {
      const retained = await f.journal(mismatch === 'object' ? inventory.targets.filter(target => target.kind !== 'object') : inventory.targets);
      if (mismatch === 'graph') f.suppressGraph(false);
      if (mismatch === 'epoch') retained.erasureEpoch = String(BigInt(retained.erasureEpoch) + 1n);
      await apply(retained);
    })).rejects.toBeInstanceOf(mismatch === 'graph' ? GraphErasureUnavailable : MediaFenced);
    expect(await f.store.readAsset(reservation.asset)).toEqual(before);
    expect([...f.memory.data.keys()].sort()).toEqual(keys.sort());
    expect(f.memory.deletes).toEqual([]);
    expect((await f.pool.query('SELECT id FROM relay.erasure')).rowCount).toBe(1);
    expect((await f.pool.query('SELECT id FROM media.asset_state WHERE lifecycle=\'erased\'')).rowCount).toBe(0);
  });
});

test('P4 callback failure rolls back terminalization; the retained journal retries the same identity', async () => {
  await fixture(async f => {
    let retained: MediaErasureJournal | undefined;
    await expect(f.preflight(async (inventory, apply) => {
      retained = await f.journal(inventory.targets);
      await apply(retained);
      throw new Error('lost before commit');
    })).rejects.toThrow('lost before commit');
    expect((await f.store.readAsset(reservation.asset))!.lifecycle).toBe('active');
    const retried = await f.erase();
    expect(retried.retained.erasureId).toBe(retained!.erasureId);
    expect(retried.retained.erasureEpoch).toBe(retained!.erasureEpoch);
    await expect(replayMediaErasure(f.pool, f.selection, f.preservationPool, { ...retried.retained, erasureEpoch: '999' })).rejects.toBeInstanceOf(MediaFenced);
    await expect(f.store.recordAssetRevision(reservation.upload)).rejects.toBeInstanceOf(MediaStale);
  });
});

test('P4 Content committed before Media rollback recovers only its exact retained journal closure', async () => {
  for (const recovery of ['exact', 'foreign-tombstone', 'new-orphan'] as const) await fixture(async f => {
    let retained: MediaErasureJournal | undefined;
    await expect(f.preflight(async (inventory, apply, preservationFence) => {
      retained = await f.journal(inventory.targets);
      await apply(retained);
      const erasureId = recovery === 'foreign-tombstone' ? randomUUID() : retained.erasureId;
      await applyContentErasure(f.contentWriter, { preservationAccess: preservationFence, erasureId,
        erasureEpoch: retained.erasureEpoch, resourceId: assetIri(reservation.asset), revisionIds: f.revisions,
        graphProof: { receipt: graphErasureReceipt(erasureId), dataEpoch: f.graph.lineage.dataEpoch, sequence: '1' } });
      throw new Error('Media commit was lost after Content committed');
    })).rejects.toThrow('Media commit was lost after Content committed');
    expect((await f.store.readAsset(reservation.asset))!.lifecycle).toBe('active');
    expect((await f.pool.query('SELECT availability,body,serialized_bytes FROM content.revision')).rows)
      .toEqual([{ availability: 'erased', body: null, serialized_bytes: null }]);
    if (recovery === 'new-orphan') await f.memory.objects(reservation.objectNamespace).put(Buffer.from('unexpected new orphan'));
    const keys = [...f.memory.data.keys()].sort();
    const replay = replayMediaErasure(f.pool, f.selection, f.preservationPool, retained!, f.memory.objects);
    if (recovery === 'exact') {
      await replay;
      expect((await f.store.readAsset(reservation.asset))!).toMatchObject({ lifecycle: 'erased', erasureEpoch: '1' });
      await replayMediaErasure(f.pool, f.selection, f.preservationPool, retained!);
      expect((await f.pool.query("SELECT id FROM media.asset_state WHERE lifecycle='erased'")).rowCount).toBe(1);
    } else {
      await expect(replay).rejects.toBeInstanceOf(recovery === 'foreign-tombstone' ? MediaErasureUnsupported : MediaFenced);
      expect((await f.store.readAsset(reservation.asset))!.lifecycle).toBe('active');
    }
    expect([...f.memory.data.keys()].sort()).toEqual(keys);
    expect(f.memory.deletes).toEqual([]);
    expect((await f.pool.query('SELECT id FROM relay.erasure')).rowCount).toBe(1);
  });
});

test('P4 inventory holds the writer fence until terminalization; queued upload cannot add a new key', async () => {
  await fixture(async f => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.memory.onList = async prefix => { if (prefix === reservation.objectNamespace) { entered(); await gate; } };
    const erasure = f.erase();
    await ready;
    let settled = false;
    const writer = f.store.reserveUpload(mediaAdmission(), { asset: reservation.asset, mediaType: 'image/png',
      byteLength: image.length, sha256: sha(image), disclosure: 'private' });
    const outcome = writer.then(value => { settled = true; return value; }, error => { settled = true; return error as unknown; });
    try {
      const deadline = Date.now() + 1_500;
      let blocked = false;
      do {
        blocked = Boolean((await f.contentWriter.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND position('FOR SHARE OF a' in query)>0 AND cardinality(pg_blocking_pids(pid))>0`)).rowCount);
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      expect(blocked).toBe(true);
      expect(settled).toBe(false);
    } finally { release(); }
    await erasure;
    expect(await outcome).toBeInstanceOf(MediaMissing);
    expect((await f.pool.query('SELECT id FROM media.upload')).rowCount).toBe(1);
  });
});
