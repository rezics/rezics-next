import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ContentCore, migrateContent } from '../../content/src/index.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { boundedPool } from '../src/infrastructure/pg-pool.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { MediaStore, type MediaAdmission } from '../src/modules/media/store.ts';
import { configureMediaVisibility } from '../src/modules/media/visibility.ts';
import { readZoneCampaignArt } from '../src/modules/zone/campaign-art.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { ensureFixtureAuthoritySubject, ensureFixturePrincipal } from './support/access-fixture-identity.ts';

const root = resolve(import.meta.dir, '../../..');
const iri = (value: string) => `https://rezics.com/id/${value}`;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const owner = iri(randomUUID()), ownTarget = iri(randomUUID()), ownUse = randomUUID();
let cluster: PostgresCluster | undefined;
let admin: Pool;
let principalId: string;
let basis: { asset: string; revision: string; representation: string; sha256: string;
  mediaType: string; width: number; height: number };
const admission = (): MediaAdmission => ({ admissionId: randomUUID(), principalId,
  actingSubject: owner, authorityEpoch: '1', requestDigest: sha(randomUUID()) });

beforeAll(async () => {
  cluster = await startPostgresCluster();
  admin = boundedPool(cluster.connection);
  await admin.query('CREATE DATABASE campaign_art_template');
  const pool = boundedPool({ ...cluster.connection, database: 'campaign_art_template', max: 8 });
  try {
    await migrateContent(pool);
    for (const file of schemaFiles(root, 'access'))
      await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    principalId = await ensureFixturePrincipal(pool,
      { issuer: 'https://account.campaign-art.test', subject: randomUUID() });
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

afterAll(async () => { await admin?.end(); cluster?.remove(); });

type Entry = { public: boolean; hidden?: boolean };
async function isolated(run: (f: { store: MediaStore; environment: MainWorkDependencies['environment'];
  entries: Map<string, Entry>; probes: string[]; attach(entry?: Entry): Promise<void> }) => Promise<void>) {
  const name = `campaign_art_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE campaign_art_template`);
  const pool = boundedPool({ ...cluster!.connection, database: name, max: 8 });
  try {
    const entries = new Map<string, Entry>([[ownTarget, { public: true }]]), probes: string[] = [];
    const fuseki = new FusekiClient('http://campaign-art.invalid');
    const literal = (value: string) => ({ type: 'literal', value });
    const uri = (value: string) => ({ type: 'uri', value });
    fuseki.query = async query => {
      const refs = (variable: string) => [...(new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`)
        .exec(query)?.[1] ?? '').matchAll(/<([^>]+)>/g)].map(match => match[1]!);
      if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
        const control = { epoch: literal('epoch'), sequence: literal('7') }, resources = refs('r');
        probes.push(...resources);
        return { results: { bindings: [control, ...resources.flatMap(reference => {
          const entry = entries.get(reference);
          return !entry || entry.hidden ? [] : [{ ...control, r: uri(reference), type: literal('work'),
            work: uri(reference), head: uri(reference), public: literal(String(entry.public)),
            label: { ...literal('Campaign attachment'), 'xml:lang': 'en' } }];
        })] } };
      }
      if (query.includes('SELECT ?work ?head')) return { results: { bindings: refs('work').map(reference =>
        ({ work: uri(reference), ...(entries.has(reference) ? { head: uri(reference),
          owningWork: uri(reference), owningHead: uri(reference) } : {}) })) } };
      if (query.includes('SELECT ?epoch ?hold ?context')) return { results: { bindings: [] } };
      throw new Error(`Unexpected summary query: ${query.slice(0, 160)}`);
    };
    const store = new MediaStore(pool, new ContentCore(pool));
    const environment = { fuseki, objectDirectory: '.temp/campaign-art',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
    configureDisclosure(environment, new DisclosureStore(pool));
    configureMediaVisibility({ environment, media: { store }, access: {
      canReadWork: async () => false,
    } } as unknown as MainWorkDependencies);
    const attach = async (entry: Entry = { public: true }) => {
      const target = iri(randomUUID());
      entries.set(target, entry);
      await store.createPublicationUses(randomUUID(), owner, target, [{ ...basis, use: randomUUID() }]);
    };
    await run({ store, environment, entries, probes, attach });
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); }
}

for (const entry of [{ public: false }, { public: true, hidden: true }]) {
  const audience = entry.public ? 'restricted' : 'private';
  test(`campaign art renders its public Use despite an unrelated ${audience} attachment of the same Asset`, async () => {
    await isolated(async f => {
      await f.attach(entry);
      const image = { use: iri(ownUse) };
      const slides = [{ id: 'campaign', href: '/launch', art: { landscape: image, portrait: image,
        cutout: image, logos: [{ ...image, language: 'en', tone: 'light' as const, anchor: 'center-middle' as const }] } }];
      const [result] = await readZoneCampaignArt(f.store, ownTarget, slides,
        { environment: f.environment, zone: iri(randomUUID()) });
      const images = [result!.art.landscape, result!.art.portrait, result!.art.cutout, ...result!.art.logos];
      expect(images).toHaveLength(4);
      for (const rendered of images) expect(rendered?.url)
        .toBe(`/v1/media/representations/${basis.representation}/bytes?use=${ownUse}`);
      expect(f.probes).toEqual([ownTarget]);
    });
  });

  test(`campaign art cannot disclose its ${audience} Use through a public attachment of the same Asset`, async () => {
    await isolated(async f => {
      await f.attach();
      f.entries.set(ownTarget, entry);
      const slides = [{ id: 'campaign', href: '/launch', art: { landscape: { use: iri(ownUse) } } }];
      expect(await readZoneCampaignArt(f.store, ownTarget, slides,
        { environment: f.environment, zone: iri(randomUUID()) })).toEqual([
        { id: 'campaign', art: { landscape: null, portrait: null, cutout: null, logos: [] } },
      ]);
      expect(f.probes).toEqual([ownTarget]);
    });
  });
}
