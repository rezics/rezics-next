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
import { disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaStore, type MediaAdmission } from '../src/modules/media/store.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import { REQUIRED_MATCH_PROFILE } from '../src/modules/media-screen/required-match-store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const root = resolve(import.meta.dir, '../../..');
const iri = (value: string) => `https://rezics.com/id/${value}`;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const owner = iri(randomUUID()), ownTarget = iri(randomUUID()), ownUse = randomUUID();
const principal = { issuer: 'https://account.media-disclosure.test', subject: randomUUID() };
const principalId = randomUUID();
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
    await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
      [principalId, principal.issuer, principal.subject]);
    await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [owner]);
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
function fixture(pool: Pool) {
  const entries = new Map<string, Entry>([[ownTarget, { public: true }]]);
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
    if (query.includes('SELECT ?epoch ?hold ?context')) return { results: { bindings: [] } };
    throw new Error(`Unexpected summary query: ${query.slice(0, 160)}`);
  };
  const fuseki = meterFuseki(graph), contentPool = meterPool(pool);
  const store = new MediaStore(contentPool, new ContentCore(contentPool));
  const environment = { fuseki, objectDirectory: '.temp/media-disclosure',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, new DisclosureStore(pool));
  configureMediaVisibility({ environment, media: { store }, access: {
    canManageMedia: async () => true, canReadWork: async () => false,
  } } as unknown as MainWorkDependencies);
  const read = (reference: string, viewer = ANONYMOUS_VIEWER) => discloseInventory(environment,
    [{ owner: 'media', resource: reference, component: 'media_use' }], viewer, 'media');
  const attach = async (entry: Entry = { public: true }) => {
    const target = iri(randomUUID()), use = randomUUID();
    entries.set(target, entry);
    await store.createPublicationUses(randomUUID(), owner, target, [{ ...basis, use }]);
    return { target, use };
  };
  const reset = () => { fuseki.reset(); contentPool.reset(); probes.length = 0; };
  const cost = () => ({ graphQueries: fuseki.queries, graphBytes: fuseki.bytes,
    ownerQueries: contentPool.queries, ownerBytes: contentPool.bytes, probes: [...probes] });
  return { pool, entries, store, attach, read, reset, cost, probes };
}

async function isolated(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const name = `media_disclosure_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE media_disclosure_template`);
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  try { await run(fixture(pool)); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); }
}

test('exact Use disclosure has identical summary probes and bytes at 1, 16, 64 and 256 asset attachments', async () => {
  await isolated(async f => {
    let count = 1, baseline: ReturnType<typeof f.cost> | undefined;
    for (const size of [1, 16, 64, 256]) {
      while (count < size) { await f.attach(); count++; }
      f.reset();
      expect(await f.read(iri(ownUse))).toEqual(['visible']);
      const cost = f.cost();
      expect(cost.probes).toEqual([ownTarget]);
      expect(cost.graphQueries).toBeGreaterThan(0);
      expect(cost.ownerQueries).toBe(1);
      if (baseline) expect(cost).toEqual(baseline);
      else baseline = cost;
    }
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
    });
  });
}
