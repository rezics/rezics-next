import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { meterFuseki, meterPool } from '../../../tests/qa/integration/support/query-cost-meter.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { configureDisclosure, discloseInventory, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { disclosureMedia } from '../src/modules/disclosure/assembly.ts';
import { disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaMissing, MediaStore, type MediaAdmission } from '../src/modules/media/store.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import { REQUIRED_MATCH_PROFILE } from '../src/modules/media-screen/required-match-store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ensureFixtureAuthoritySubject, ensureFixturePrincipal } from './support/access-fixture-identity.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const root = resolve(import.meta.dir, '../../..');
const iri = (value: string) => `https://rezics.com/id/${value}`;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const owner = iri(randomUUID()), ownTarget = iri(randomUUID()), ownUse = randomUUID();
const principal = { issuer: 'https://account.media-disclosure.test', subject: randomUUID() };
let principalId: string;
const admission = (): MediaAdmission => ({ admissionId: randomUUID(), principalId,
  actingSubject: owner, authorityEpoch: '1', requestDigest: sha(randomUUID()) });
let cluster: PostgresCluster | undefined;
let admin: Pool;
let basis: { asset: string; revision: string; representation: string; sha256: string;
  mediaType: string; width: number; height: number };

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = boundedPool(cluster.connection);
  await admin.query('CREATE DATABASE media_disclosure_template');
  const pool = boundedPool({ ...cluster.connection, database: 'media_disclosure_template', max: 8 });
  try {
    await migrateContent(pool);
    for (const file of schemaFiles(root, 'access'))
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    principalId = await ensureFixturePrincipal(pool, principal);
    await ensureFixtureAuthoritySubject(pool, owner);
    await grantFixtureAuthority(pool, { scope: `media:owner:${owner}`, requireDispatch: true,
      representations: [{ principalId, actor: owner, action: 'media.upload', lifetime: 'infinity' }],
      grant: { actor: owner, action: 'media.upload', lifetime: 'infinity' } });
    const store = new MediaStore(pool, new ContentCore(pool));
    const bytes = Buffer.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]);
    const reserved = await store.reserveUpload(admission(), { asset: null, mediaType: 'image/gif',
      byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public' });
    const settled = await store.settleUpload(reserved.upload, { status: 'activated', sha256: sha(bytes),
      byteLength: bytes.length, mediaType: 'image/gif', width: 1, height: 1 }, async () => sha(bytes));
    const revision = await store.recordAssetRevision(reserved.upload);
    basis = { asset: reserved.asset, revision: revision.revision, representation: settled.representation,
      sha256: sha(bytes), mediaType: 'image/gif', width: 1, height: 1 };
    await store.createPublicationUses(randomUUID(), owner, ownTarget, [{ ...basis, use: ownUse }]);
  } finally { await pool.end(); }
}, 60_000);

afterAll(async () => {
  await admin?.end();
  cluster?.remove();
});

type Entry = { public: boolean; hidden?: boolean };
type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: Plan[];
};
const planNodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
const examinedRows = (plan: Plan) => planNodes(plan)
  .filter(node => ['use', 'selection_slot', 'selection_revision'].includes(node['Relation Name'] ?? '')
    && node['Node Type'] !== 'Bitmap Index Scan')
  .reduce((sum, node) => sum + (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)
    + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'], 0);

function fixture(pool: Pool) {
  const entries = new Map<string, Entry>([[ownTarget, { public: true }]]);
  const useTargets = new Map<string, string>([[iri(ownUse), ownTarget]]);
  const authority = { manage: true, baseline: false };
  const probes: string[] = [];
  const graph = new FusekiClient('http://media-disclosure.invalid');
  const literal = (value: string) => ({ type: 'literal', value });
  const uri = (value: string) => ({ type: 'uri', value });
  graph.query = async query => {
    const refs = (variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
      .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const control = { epoch: literal('epoch'), sequence: literal('7') };
      const resources = refs('r');
      probes.push(...resources);
      return { results: { bindings: [control, ...resources.flatMap(reference => {
        const entry = entries.get(reference);
        return !entry || entry.hidden ? [] : [{ ...control, r: uri(reference), type: literal('work'),
          work: uri(reference), head: uri(reference), public: literal(String(entry.public)),
          label: { ...literal('Attachment'), 'xml:lang': 'en' } }];
      })] } };
    }
    if (query.includes('SELECT ?work ?head')) return { results: { bindings: refs('work').map(reference =>
      ({ work: uri(reference), ...(entries.has(reference) ? { head: uri(reference),
        owningWork: uri(reference), owningHead: uri(reference) } : {}) })) } };
    if (query.includes('SELECT ?resource ?head')) return { results: { bindings: refs('resource').map(reference =>
      ({ resource: uri(reference), head: uri(reference) })) } };
    if (query.includes('SELECT ?epoch ?hold ?context')) return { results: { bindings: [] } };
    throw new Error(`Unexpected summary query: ${query.slice(0, 160)}`);
  };
  const fuseki = meterFuseki(graph), allSql = meterPool(pool), contentPool = meterPool(allSql);
  const store = new MediaStore(contentPool, new ContentCore(contentPool));
  const environment = { fuseki, objectDirectory: '.temp/media-disclosure',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(allSql));
  configureFixtureDisclosureAncestry(environment, target => {
    // Each publication Use retains its own Work. Bare Assets rely on their
    // bounded attachment inventory rather than an invented single owner.
    const resource = target.work ?? (target.owner === 'media'
      ? useTargets.get(target.occurrence?.resource ?? target.resource) : target.resource);
    return resource ? { resource, head: resource, ...(target.workRevision !== undefined
      ? { protectedRevision: target.workRevision } : {}) } : undefined;
  });
  configureMediaVisibility({ environment, media: { store }, access: {
    canManageMedia: async () => authority.manage,
    canReadAsBaselineMember: async () => authority.baseline,
    canReadWork: async () => false,
  } } as unknown as MainWorkDependencies);
  const read = (reference: string, viewer = ANONYMOUS_VIEWER) => discloseInventory(environment,
    [{ owner: 'media', resource: reference, component: 'media_use' }], viewer, 'media');
  const attach = async (entry: Entry = { public: true }) => {
    const target = iri(randomUUID()), use = randomUUID();
    entries.set(target, entry);
    await store.createPublicationUses(randomUUID(), owner, target, [{ ...basis, use }]);
    useTargets.set(iri(use), target);
    return { target, use };
  };
  const reset = () => { fuseki.reset(); contentPool.reset(); allSql.reset(); probes.length = 0; };
  const cost = () => ({ statements: allSql.queries, graphQueries: fuseki.queries, graphBytes: fuseki.bytes,
    ownerQueries: contentPool.queries, ownerBytes: contentPool.bytes, probes: [...probes] });
  const visibilityPlan = async (reference: string): Promise<Plan> => {
    let plan: Plan | undefined;
    // Capture and explain the actual store statement rather than a copied query.
    const explaining = new Proxy(pool, { get(target, property) {
      if (property === 'query') return async (sql: string, values: unknown[]) => {
        plan = (await pool.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
          `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${sql}`, values)).rows[0]!['QUERY PLAN'][0]!.Plan;
        return { rows: [] };
      };
      return Reflect.get(target, property, target);
    } });
    await new MediaStore(explaining, new ContentCore(pool)).visibilityFacts([reference]);
    return plan!;
  };
  return { pool, environment, entries, authority, store, attach, read, reset, cost, probes, visibilityPlan };
}

async function isolated(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const name = `media_disclosure_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE media_disclosure_template`);
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  try { await run(fixture(pool)); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); }
}

async function screeningAsset(store: MediaStore, pool: Pool) {
  const bytes = Buffer.from([71, 73, 70, 56, 57, 97, 2, 0, 1, 0]);
  // Launch currently bypasses screening. Exercise the owner's retained-image
  // contract with the screening clearance function in this isolated database.
  await pool.query(`CREATE OR REPLACE FUNCTION media.delivery_clearance(p media.representation)
    RETURNS text LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN o.byte_digest='${sha(bytes)}'
        THEN 'screening' ELSE o.clearance END FROM media.representation o
      WHERE o.id=CASE WHEN p.kind='original' THEN p.id ELSE p.source_id END
    $$`);
  const reserved = await store.reserveUpload(admission(), { asset: null, mediaType: 'image/gif',
    byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public' });
  const settled = await store.settleUpload(reserved.upload, { status: 'activated', sha256: sha(bytes),
    byteLength: bytes.length, mediaType: 'image/gif', width: 2, height: 1 }, async () => sha(bytes));
  await store.recordAssetRevision(reserved.upload);
  return { asset: reserved.asset, representation: settled.representation };
}

test('avatar delivery keeps the previous cleared exact Use while its replacement is screening', async () => {
  await isolated(async f => {
    const target = iri(randomUUID()), context = DEFAULT_MEDIA_CONTEXT;
    f.entries.set(target, { public: true });
    await f.store.moderateOriginal(`clear:${randomUUID()}`, basis.representation,
      (await f.store.readAsset(basis.asset))!.state, false);
    const selected = await f.store.selectAvatar(admission(), { target, context,
      expectedSelection: null, asset: basis.asset, crop: null });
    const delivered = (await f.store.avatarDelivery(selected.id!))!;
    expect(delivered.asset).toBe(basis.asset);
    const replacement = await screeningAsset(f.store, f.pool);
    const pending = await f.store.selectAvatar(admission(), { target, context,
      expectedSelection: selected.id, asset: replacement.asset, crop: null });
    expect(await f.store.avatarDelivery(selected.id!)).toEqual(delivered);
    expect(await f.store.avatarDelivery(pending.id!)).toBeNull();
    expect((await f.store.visibilityFacts([iri(delivered.use!)])).get(iri(delivered.use!))!.attachments)
      .toEqual([{ target, context }]);
    const composed = disclosureMedia(f.store, f.environment);
    expect(await composed.avatarDelivery(selected.id!)).toEqual(delivered);
    configureDisclosure(f.environment, fixtureDisclosureReader(async targets => targets.map(target =>
      target.resource === iri(delivered.use!) ? 'hidden' : 'visible')));
    expect(await composed.avatarDelivery(selected.id!)).toBeNull();
    await f.store.selectAvatar(admission(), { target, context, expectedSelection: pending.id,
      asset: null, crop: null });
    expect((await f.store.visibilityFacts([iri(delivered.use!)])).get(iri(delivered.use!))!.attachments).toEqual([]);
  });
}, 60_000);

for (const role of ['showcase', 'campaign'] as const) {
test(`${role} keeps its exact cleared Use when a screening replacement is refused`, async () => {
  await isolated(async f => {
    const target = iri(randomUUID()), context = DEFAULT_MEDIA_CONTEXT;
    f.entries.set(target, { public: true });
    await f.store.moderateOriginal(`clear:${randomUUID()}`, basis.representation,
      (await f.store.readAsset(basis.asset))!.state, false);
    const input = { target, context, crop: null, focalArea: null, role: 'background-landscape' as const };
    const inspect = async () => ({ width: 1280, height: 720, hasAlpha: false });
    const zone = iri(randomUUID());
    const select = (asset: string, expectedSelection: string | null = null) => role === 'showcase'
      ? f.store.showcase.select(admission(), { ...input, asset, expectedSelection }, inspect)
      : f.store.showcase.createCampaign(admission(), { ...input, asset, zone }, inspect);
    const selected = await select(basis.asset);
    const use = role === 'campaign' ? selected.id! :
      (await f.pool.query('SELECT use_id FROM media.selection_revision WHERE id=$1', [selected.id])).rows[0].use_id as string;
    const replacement = await screeningAsset(f.store, f.pool);
    await expect(select(replacement.asset, selected.id)).rejects.toBeInstanceOf(MediaMissing);
    expect((await f.store.visibilityFacts([iri(use)])).get(iri(use))!.attachments).toEqual([{ target, context }]);
    const composed = disclosureMedia(f.store, f.environment);
    if (role === 'campaign') expect(await composed.itemDelivery(use)).not.toBeNull();
    else expect(await f.read(iri(use))).toEqual(['visible']);
    configureDisclosure(f.environment, fixtureDisclosureReader(async targets => targets.map(target =>
      target.resource === iri(use) ? 'hidden' : 'visible')));
    if (role === 'campaign') expect(await composed.itemDelivery(use)).toBeNull();
    else expect(await f.read(iri(use))).toEqual(['hidden']);
  });
}, 60_000);
}

test('exact Use disclosure has identical summary probes and bytes at 1, 16, 64 and 256 asset attachments', async () => {
  await isolated(async f => {
    let count = 1, baseline: ReturnType<typeof f.cost> | undefined;
    for (const size of [1, 16, 64, 256]) {
      // These Uses only populate the index under test; admit them in one
      // owner transaction rather than paying one receipt transaction per row.
      const target = iri(randomUUID());
      f.entries.set(target, { public: true });
      await f.store.createPublicationUses(randomUUID(), owner, target,
        Array.from({ length: size - count }, () => ({ ...basis, use: randomUUID() })));
      count = size;
      f.reset();
      const disclosed = await f.read(iri(ownUse));
      expect(disclosed).toEqual(['visible']);
      const cost = f.cost();
      expect(disclosed.cost!.statements).toBe(cost.statements);
      expect(disclosed.cost!.mediaStatements).toBeGreaterThan(1);
      expect(cost.probes).toEqual([ownTarget]);
      expect(cost.graphQueries).toBeGreaterThan(0);
      expect(cost.ownerQueries).toBe(1);
      if (baseline) expect(cost).toEqual(baseline);
      else baseline = cost;
    }
  });
}, 60_000);

test('exact Use database work does not grow with unrelated Uses', async () => {
  await isolated(async f => {
    let count = 1;
    const samples: number[] = [];
    for (const size of [256, 1024]) {
      // These Uses only populate the index under test; admit them in one
      // owner transaction rather than paying one receipt transaction per row.
      const target = iri(randomUUID());
      f.entries.set(target, { public: true });
      await f.store.createPublicationUses(randomUUID(), owner, target,
        Array.from({ length: size - count }, () => ({ ...basis, use: randomUUID() })));
      count = size;
      await f.pool.query('ANALYZE media.use');
      const plan = await f.visibilityPlan(iri(ownUse));
      const useScans = planNodes(plan).filter(node => node['Relation Name'] === 'use'
        && node['Actual Loops'] > 0);
      expect(useScans).toHaveLength(1);
      expect(useScans[0]).toMatchObject({ 'Index Cond': expect.stringContaining('id =') });
      samples.push(examinedRows(plan));
    }
    expect(samples).toEqual([1, 1]);
  });
}, 60_000);

test('private, hidden and missing other targets neither hide nor get probed by this Use', async () => {
  await isolated(async f => {
    await f.attach({ public: false });
    await f.attach({ public: true, hidden: true });
    const missing = await f.attach();
    f.entries.delete(missing.target);
    f.reset();
    expect(await f.read(iri(ownUse))).toEqual(['visible']);
    expect(f.probes).toEqual([ownTarget]);
    expect(await f.read(iri(basis.asset))).toEqual(['hidden']);
  });
});

for (const entry of [{ public: false }, { public: true, hidden: true }]) {
  test(`this Use's ${entry.public ? 'hidden' : 'private'} target is hidden like an absent target`, async () => {
    await isolated(async f => {
      f.entries.set(ownTarget, entry);
      expect(await f.read(iri(ownUse))).toEqual(['hidden']);
      f.entries.delete(ownTarget);
      expect(await f.read(iri(ownUse))).toEqual(['hidden']);
    });
  });
}

test('Asset disclosure checks all attachments through 64 and fails closed above 64 without summary probes', async () => {
  await isolated(async f => {
    for (let count = 1; count < 64; count++) await f.attach();
    f.reset();
    expect(await f.read(iri(basis.asset))).toEqual(['visible']);
    expect(f.probes).toHaveLength(64);
    f.entries.set(ownTarget, { public: false });
    expect(await f.read(iri(basis.asset))).toEqual(['hidden']);
    f.entries.set(ownTarget, { public: true });
    for (let count = 64; count < 256; count++) {
      await f.attach();
      if (count !== 64 && count !== 255) continue;
      const fact = (await f.store.visibilityFacts([iri(basis.asset)])).get(iri(basis.asset))!;
      expect(fact.attachments).toHaveLength(64);
      expect(fact.attachmentOverflow).toBe(true);
      f.reset();
      expect(await f.read(iri(basis.asset))).toEqual(['hidden']);
      expect(f.cost()).toMatchObject({ graphQueries: 0, graphBytes: 0, probes: [] });
      expect(await f.read(iri(ownUse))).toEqual(['visible']);
    }
  });
}, 60_000);

test('mixed Asset and Use facts retain independent attachment audiences', async () => {
  await isolated(async f => {
    const other = await f.attach({ public: false });
    const facts = await f.store.visibilityFacts([iri(basis.asset), iri(ownUse), iri(other.use)]);
    expect(facts.get(iri(basis.asset))!.attachments).toHaveLength(2);
    expect(facts.get(iri(ownUse))!.attachments).toEqual([{ target: ownTarget, context: DEFAULT_MEDIA_CONTEXT }]);
    expect(facts.get(iri(other.use))!.attachments).toEqual([{ target: other.target, context: DEFAULT_MEDIA_CONTEXT }]);
    expect((await f.read(iri(ownUse)))[0]).toBe('visible');
    expect((await f.read(iri(other.use)))[0]).toBe('hidden');
  });
});

for (const role of ['avatar', 'showcase'] as const) {
test(`${role} attachments still count only the selected head in their exact context`, async () => {
  await isolated(async f => {
    const target = iri(randomUUID()), context = iri(randomUUID());
    if (role === 'showcase') await f.store.moderateOriginal(`clear:${randomUUID()}`, basis.representation,
      (await f.store.readAsset(basis.asset))!.state, false);
    const select = (asset: string | null, expectedSelection: string | null) => role === 'avatar'
      ? f.store.selectAvatar(admission(), { target, context, expectedSelection, asset, crop: null })
      : f.store.showcase.select(admission(), { target, context, expectedSelection, asset, crop: null,
        role: 'background-landscape', focalArea: null }, async () => ({ width: 1280, height: 720, hasAlpha: false }));
    const selected = await select(basis.asset, null);
    const use = (await f.pool.query('SELECT use_id FROM media.selection_revision WHERE id=$1', [selected.id])).rows[0].use_id as string;
    expect((await f.store.visibilityFacts([iri(use)])).get(iri(use))!.attachments).toEqual([{ target, context }]);
    await select(null, selected.id);
    expect((await f.store.visibilityFacts([iri(use)])).get(iri(use))!.attachments).toEqual([]);
    expect((await f.store.visibilityFacts([iri(basis.asset)])).get(iri(basis.asset))!.attachments)
      .toEqual([{ target: ownTarget, context: DEFAULT_MEDIA_CONTEXT }]);
  });
});
}

for (const role of ['avatar', 'showcase'] as const) {
test(`Asset database work ignores retained ${role} selection history`, async () => {
  await isolated(async f => {
    const target = iri(randomUUID()), context = iri(randomUUID());
    if (role === 'showcase') await f.store.moderateOriginal(`clear:${randomUUID()}`, basis.representation,
      (await f.store.readAsset(basis.asset))!.state, false);
    const select = (asset: string | null, expectedSelection: string | null) => role === 'avatar'
      ? f.store.selectAvatar(admission(), { target, context, expectedSelection, asset, crop: null })
      : f.store.showcase.select(admission(), { target, context, expectedSelection, asset, crop: null,
        role: 'background-landscape', focalArea: null }, async () => ({ width: 1280, height: 720, hasAlpha: false }));
    // Keep the tiny-table planner fallback out of the growth measurement.
    // These never-selected slots have no attachment and stay fixed in both samples.
    await f.pool.query(`INSERT INTO media.selection_slot (target,context,role,policy)
      SELECT 'https://rezics.com/id/'||gen_random_uuid(),$1,'avatar','avatar-selection-v1'
      FROM generate_series(1,1024)`, [DEFAULT_MEDIA_CONTEXT]);
    let count = 0, head: string | null = null;
    const samples: number[] = [];
    for (const size of [256, 1024]) {
      while (count < size) {
        const selected = await select(basis.asset, head);
        const cleared = await select(null, selected.id);
        head = cleared.id;
        count++;
      }
      await f.pool.query('ANALYZE media.use; ANALYZE media.selection_slot; ANALYZE media.selection_revision');
      const plan = await f.visibilityPlan(iri(basis.asset));
      const nodes = planNodes(plan);
      expect(nodes.some(node => node['Index Name'] === 'use_inventory_attachment_idx'
        && node['Index Cond']?.includes('asset_id ='))).toBe(true);
      expect(nodes.some(node => node['Index Name'] === 'selection_attachment_asset_idx'
        && node['Index Cond']?.includes('attachment_asset_id ='))).toBe(true);
      expect(nodes.some(node => node['Relation Name'] === 'selection_revision'
        && node['Actual Loops'] > 0)).toBe(false);
      samples.push(examinedRows(plan));
      expect((await f.store.visibilityFacts([iri(basis.asset)])).get(iri(basis.asset))!.attachments)
        .toEqual([{ target: ownTarget, context: DEFAULT_MEDIA_CONTEXT }]);
    }
    expect(samples).toEqual([1, 1]);
    await select(basis.asset, head);
    expect((await f.store.visibilityFacts([iri(basis.asset)])).get(iri(basis.asset))!.attachments)
      .toEqual([{ target: ownTarget, context: DEFAULT_MEDIA_CONTEXT }, { target, context }]);
    // A caller cannot forge the derived seek key while retaining the same head.
    await f.pool.query('UPDATE media.selection_slot SET attachment_asset_id=NULL WHERE target=$1', [target]);
    expect((await f.pool.query('SELECT attachment_asset_id FROM media.selection_slot WHERE target=$1', [target])).rows)
      .toEqual([{ attachment_asset_id: basis.asset }]);
  });
}, 120_000);
}

test('current attachment lookup backfills existing selected and cleared heads', async () => {
  await isolated(async f => {
    // Recreate the additive migration against a fixture with pre-existing heads.
    await f.pool.query(`DROP TRIGGER selection_slot_attachment_asset ON media.selection_slot;
      DROP FUNCTION media.derive_attachment_asset();
      ALTER TABLE media.selection_slot DROP COLUMN attachment_asset_id;
      DROP INDEX media.use_inventory_attachment_idx`);
    const selectedTarget = iri(randomUUID()), clearedTarget = iri(randomUUID());
    await f.store.selectAvatar(admission(), { target: selectedTarget, context: DEFAULT_MEDIA_CONTEXT,
      expectedSelection: null, asset: basis.asset, crop: null });
    const selected = await f.store.selectAvatar(admission(), { target: clearedTarget, context: DEFAULT_MEDIA_CONTEXT,
      expectedSelection: null, asset: basis.asset, crop: null });
    await f.store.selectAvatar(admission(), { target: clearedTarget, context: DEFAULT_MEDIA_CONTEXT,
      expectedSelection: selected.id, asset: null, crop: null });
    await f.pool.query(readFileSync(join(root, 'services/content/migrations/2160_media_current_attachment_lookup.sql'), 'utf8'));
    expect((await f.pool.query('SELECT attachment_asset_id FROM media.selection_slot WHERE target=$1', [selectedTarget])).rows)
      .toEqual([{ attachment_asset_id: basis.asset }]);
    expect((await f.pool.query('SELECT attachment_asset_id FROM media.selection_slot WHERE target=$1', [clearedTarget])).rows)
      .toEqual([{ attachment_asset_id: null }]);
    expect((await f.store.visibilityFacts([iri(basis.asset)])).get(iri(basis.asset))!.attachments)
      .toEqual([{ target: ownTarget, context: DEFAULT_MEDIA_CONTEXT },
        { target: selectedTarget, context: DEFAULT_MEDIA_CONTEXT }]);
  });
});

for (const state of ['private', 'deleted', 'moderated', 'queued', 'leased', 'failed'] as const) {
  test(`asset ${state} still hides an otherwise readable Use`, async () => {
    await isolated(async f => {
      const current = (await f.store.readAsset(basis.asset))!;
      if (state === 'private' || state === 'deleted') {
        await f.store.changeState(admission(), { asset: basis.asset, expectedState: current.state,
          disclosure: state === 'private' ? 'private' : 'public', lifecycle: state === 'deleted' ? 'deleted' : 'active' });
      } else if (state === 'moderated') {
        await f.store.moderateOriginal(`restrict:${randomUUID()}`, basis.representation, current.state, true);
      } else {
        // Reuse the fixture's succeeded receipt; the job retains the real owner schema constraints.
        const op = (await f.pool.query('SELECT operation_id FROM media.use WHERE id=$1', [ownUse])).rows[0].operation_id as string;
        await f.pool.query(`INSERT INTO media.transform_job(id,asset_id,source_id,input_digest,profile,
          authority_epoch,erasure_epoch,operation_id)
          VALUES ($1,$2,$3,$4,$5,'1',0,$6)`,
          [randomUUID(), basis.asset, basis.representation, basis.sha256, REQUIRED_MATCH_PROFILE, op]);
        if (state !== 'queued') {
          const lease = await f.store.matching.leaseNext(30_000, basis.representation);
          expect(lease).not.toBeNull();
          if (state === 'failed') expect(await f.store.matching.settle(lease!, 'blocked')).toBe(true);
        }
      }
      expect(await f.read(iri(ownUse))).toEqual(['hidden']);
      const ownerViewer = disclosureViewer(principal, owner);
      expect(await f.read(iri(ownUse), ownerViewer)).toEqual(
        [state === 'private' || state === 'queued' || state === 'leased' ? 'visible' : 'hidden']);
      expect(await f.read(iri(ownUse), disclosureViewer(principal, iri(randomUUID())))).toEqual(['hidden']);
      if (state === 'private' || state === 'queued' || state === 'leased') {
        for (const decisions of [
          { manage: false, baseline: false },
          { manage: false, baseline: true },
          { manage: true, baseline: false },
        ]) {
          Object.assign(f.authority, decisions);
          for (const reference of [iri(ownUse), iri(basis.asset)]) {
            expect(await f.read(reference, ownerViewer)).toEqual(
              [decisions.manage || decisions.baseline ? 'visible' : 'hidden']);
            expect(await f.read(reference, disclosureViewer(principal, iri(randomUUID())))).toEqual(['hidden']);
          }
        }
      }
    });
  });
}
