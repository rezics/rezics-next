import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';
import { ADMITTED as LOADED_COLUMNS, DBCL, ODBL, SHOWCASE, VNDB_ATTRIBUTION, VNDB_LOCKED_SEED, loadVndbSlice,
  seededReleasePlan } from '../../fixtures/vndb/load.ts';
import { applyLnVnZones } from '../../../scripts/dev/seed/ln-vn-zones-step.ts';
import { applyVnCatalogue, vndbReleaseIri, type SeedPort } from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import { startMediaStack } from './media-support.ts';

/** The slice may contain only these columns. releases_vn was required to name each release's visual novel. */
const ADMITTED = {
  vn: ['id', 'olang'],
  vn_titles: ['id', 'lang', 'official', 'title', 'latin'],
  releases: ['id', 'olang', 'released', 'official'],
  releases_titles: ['id', 'lang', 'title', 'latin'],
  releases_platforms: ['id', 'platform'],
  releases_vn: ['id', 'vid', 'rtype'],
  releases_producers: ['id', 'pid', 'developer', 'publisher'],
  producers: ['id', 'type', 'lang', 'name', 'latin'],
} as const;
const FORBIDDEN = new Set(['description', 'image', 'alias', 'notes', 'catalog', 'gtin', 'votes', 'staff',
  'tags', 'traits', 'anime', 'c_image', 'engine', 'mtl', 'votecount', 'devstatus', 'quote', 'aliases']);
const root = join(import.meta.dir, '../../..');

test('G852: the committed VNDB slice stays inside the admitted columns', () => {
  expect(LOADED_COLUMNS).toEqual(ADMITTED);
  const raw = JSON.parse(readFileSync(join(root, VNDB_LOCKED_SEED), 'utf8')) as {
    provenance?: unknown; tables?: Record<string, unknown> };
  expect(Object.keys(raw).sort()).toEqual(['provenance', 'tables']);
  const tables = raw.tables ?? {};
  expect(Object.keys(tables).sort()).toEqual(Object.keys(ADMITTED).sort());
  for (const [name, rows] of Object.entries(tables)) {
    expect(Array.isArray(rows)).toBe(true);
    const columns = ADMITTED[name as keyof typeof ADMITTED];
    for (const row of rows as unknown[]) {
      expect(row && typeof row === 'object' && !Array.isArray(row)).toBe(true);
      const record = row as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual([...columns].sort());
      for (const [key, value] of Object.entries(record)) {
        expect(FORBIDDEN.has(key)).toBe(false);
        expect(value === null || typeof value === 'string' || typeof value === 'boolean').toBe(true);
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(300);
          expect(/[\u0000-\u001f\u007f]/.test(value)).toBe(false);
        }
      }
    }
  }
  const slice = loadVndbSlice();
  expect(slice.tables.vn.length).toBeGreaterThanOrEqual(40);
  expect(slice.tables.vn.length).toBeLessThanOrEqual(60);
  expect(slice.tables.releases_titles.some(row => row.title === null)).toBe(true);
  const plan = seededReleasePlan(slice);
  const release = (id: string) => plan.releases.find(item => item.id === id);
  const windows = release(SHOWCASE.japaneseWindowsComplete);
  const translated = release(SHOWCASE.englishSwitchComplete);
  const trial = release(SHOWCASE.englishWindowsTrial);
  const unofficial = release(SHOWCASE.unofficial);
  expect(windows).toMatchObject({ platform: 'Windows', completeness: 'complete', official: true });
  expect(windows?.coverage.some(entry => entry.language === 'ja')).toBe(true);
  expect(translated).toMatchObject({ platform: 'Switch', completeness: 'complete', official: true });
  expect(translated?.coverage.some(entry => entry.language === 'en')).toBe(true);
  expect(trial).toMatchObject({ platform: 'Windows', completeness: 'trial' });
  expect(trial?.coverage.some(entry => entry.language === 'en')).toBe(true);
  expect(unofficial?.official).toBe(false);
  expect(plan.englishWindowsComplete.some(item => item.release === SHOWCASE.japaneseWindowsComplete)).toBe(true);
  const announcement = JSON.parse(readFileSync(join(root, 'config/zones/visual-novels.json'), 'utf8')) as {
    announcement: string };
  expect(announcement.announcement).toBe(VNDB_ATTRIBUTION);
  expect(VNDB_ATTRIBUTION.length).toBeLessThanOrEqual(120);
  expect(VNDB_ATTRIBUTION).toContain('ODbL');
  expect(VNDB_ATTRIBUTION).toContain('DbCL');
});

test('G852: two Zones share one catalogue Work and one usable visual-novel release', async () => {
  const stack = await startMediaStack('g-852-zones', { agents: true, rights: true, library: true });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL! });
  try {
    const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/structure/' });
    await objects.initialize();
    (stack.env as typeof stack.env & { structureObjects: typeof objects }).structureObjects = objects;
    const member = await stack.member('vndb-editor');
    const provision = await json<{ agent: string; state: string }>(await member.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'VNDB seed editor' }, 'g-852-editor'));
    expect(provision.state).toBe('active');
    const actor = provision.agent;
    const grant = async (scope: string, action: string) => {
      const client = await stack.accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
        const represented = await client.query(`SELECT id FROM access.representation
          WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active AND valid_until > now()`,
        [member.principalId, actor, action]);
        if (!represented.rowCount) await client.query(`INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), member.principalId, actor, action]);
        const allowed = await client.query(`SELECT id FROM access.permission_grant
          WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active AND valid_until > now()`,
        [actor, scope, action]);
        if (!allowed.rowCount) await client.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    const request: SeedPort['request'] = async (method, path, body, key) => {
      const response = await stack.call(method, path, { token: member.token, body, key });
      const text = await response.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) as unknown : null; } catch { /* text body */ }
      return { status: response.status, body: parsed };
    };
    const port: SeedPort = { actingSubject: actor, request, grant };
    const first = await applyVnCatalogue(port);
    const second = await applyVnCatalogue(port);
    expect(second).toEqual(first);
    const showcase = first.works.find(work => work.vndb === SHOWCASE.vn);
    expect(showcase).toBeTruthy();
    const zones = await applyLnVnZones({ port, vnWorks: first.works.map(work => ({ vndb: work.vndb, iri: work.iri })),
      showcaseIri: showcase!.iri, extraBooks: [] });
    const again = await applyLnVnZones({ port, vnWorks: first.works.map(work => ({ vndb: work.vndb, iri: work.iri })),
      showcaseIri: showcase!.iri, extraBooks: [] });
    expect(again).toEqual(zones);
    expect(new Set(zones.zones.map(zone => zone.id))).toEqual(new Set(['light-novels', 'visual-novels']));
    expect(zones.zones.every(zone => zone.members.includes(showcase!.iri))).toBe(true);

    const plan = seededReleasePlan(loadVndbSlice());
    const byVn = new Map<string, string[]>();
    for (const row of plan.englishWindowsComplete) {
      const releases = byVn.get(row.vn) ?? [];
      releases.push(vndbReleaseIri(row.release));
      byVn.set(row.vn, releases);
    }
    const found = await releaseWorks(stack, [
      { facet: 'releaseLanguage', any: ['en'] },
      { facet: 'releasePlatform', any: ['Windows'] },
      { facet: 'releaseCompleteness', any: ['complete'] },
      { facet: 'releaseStatus', any: ['official', 'unofficial'] },
    ]);
    const works = new Map(first.works.map(work => [work.vndb, work.iri]));
    for (const [vn, releases] of byVn) {
      expect(releases.length).toBeLessThanOrEqual(8);
      const item = found.get(works.get(vn)!);
      expect(item, vn).toBeTruthy();
      for (const release of releases) expect(item?.matchedReleases).toContain(release);
    }
    const trials = await releaseWorks(stack, [
      { facet: 'releaseLanguage', any: ['en'] },
      { facet: 'releasePlatform', any: ['Windows'] },
      { facet: 'releaseCompleteness', any: ['trial'] },
      { facet: 'releaseStatus', any: ['official', 'unofficial'] },
    ]);
    expect(trials.get(showcase!.iri)?.matchedReleases).toContain(vndbReleaseIri(SHOWCASE.englishWindowsTrial));

    for (const zone of zones.zones) {
      const home = await readJson<{ kind: string }>(port, `/v1/zones/${zone.zone.slice(-36)}/routes?path=${encodeURIComponent('/')}`);
      const index = await readJson<{ kind: string }>(port, `/v1/zones/${zone.zone.slice(-36)}/routes?path=${encodeURIComponent('/catalogue')}`);
      const detail = await readJson<{ kind: string; resource: { id: string } }>(port,
        `/v1/zones/${zone.zone.slice(-36)}/routes?path=${encodeURIComponent(`/catalogue/${showcase!.iri.slice(-36)}`)}`);
      expect(home.kind).toBe('home');
      expect(index.kind).toBe('index');
      expect(detail.kind).toBe('detail');
      expect(detail.resource.id).toBe(showcase!.iri);
    }
    const visual = zones.zones.find(zone => zone.id === 'visual-novels')!;
    const configured = await readJson<{ configuration: { presentation: { modules: { title: string }[] } } }>(port,
      `/v1/zones/${visual.zone.slice(-36)}/configuration`);
    expect(configured.configuration.presentation.modules.some(module =>
      module.title.includes('ODbL') && module.title.includes('DbCL'))).toBe(true);
    const offering = await readJson<{ instrument: string }>(port,
      `/v1/rights/offerings/${first.offering.id.slice(-36)}`);
    expect(offering.instrument).toBe(ODBL);
    const evaluation = await port.request('POST', '/v1/rights/use-evaluations', {
      profile: 'rights-use-evaluation-v1', actingSubject: actor,
      material: { scopeKind: 'work', workId: showcase!.iri, provider: null, namespace: null, sourceRecordId: null,
        contentVariantId: null, mediaAsset: null, component: 'record' },
      family: 'data_rights', useKind: 'redistribution', useScope: 'rezics:vndb-dump',
    });
    expect(evaluation.status).toBe(200);
    const assessed = evaluation.body as { status: string; assessment?: { obligations: { kind: string }[] } };
    expect(assessed.status).toBe('assessed');
    const kinds = new Set(assessed.assessment?.obligations.map(item => item.kind));
    expect(kinds.has('attribution')).toBe(true);
    expect(kinds.has('share_alike')).toBe(true);
    expect(DBCL).toContain('dbcl');
    const metadata = await readJson<{ localized: { description: string | null }[] }>(port,
      `/v1/works/${showcase!.iri.slice(-36)}/metadata`);
    expect(metadata.localized.every(row => row.description === null)).toBe(true);
    const reader = await readJson<{ status: { status: string } }>(port,
      `/v1/works/${showcase!.iri.slice(-36)}/reader-state`);
    expect(reader.status.status).toBe('reading');

    const novels = zones.zones.find(zone => zone.id === 'light-novels')!;
    // The production browse API consumes its owner projection. The media
    // harness deliberately omits it; backfill the real owner after fixture writes.
    const zoneBrowse = new ZoneBrowseProjection(stack.accessPool, relay, stack.env);
    await zoneBrowse.backfill();
    const queryApp = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      media: stack.media, mediaAccess: stack.mediaAccess, zoneBrowse,
      account: { verify: async () => member.principal } });
    const browseStack = { ...stack, call: async (method: string, path: string, options: { body?: unknown } = {}) =>
      queryApp.handle(new Request(`http://main.local${path}`, { method,
        headers: { 'content-type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })) };
    for (const status of ['completed', 'ongoing', 'hiatus']) {
      const page = await query(browseStack, { context: { realm: novels.realm }, scope: { kind: 'realm', realm: novels.realm },
        sort: 'newest', page: { size: 20 }, filter: { all: [{ facet: 'status', any: [status] }] } });
      expect(page.template).toBe('zone-browse-v1');
      const sample = zones.samples.find(item => item.id === status)!;
      expect((page.result as { items: { id: string }[] }).items.map(item => item.id)).toContain(sample.iri);
    }
    const lengths = await query(browseStack, { context: { realm: novels.realm }, scope: { kind: 'realm', realm: novels.realm },
      sort: 'newest', page: { size: 20 }, filter: { all: [{ facet: 'length', range: { min: '0', max: '99999' } }] } });
    expect(lengths.template).toBe('zone-browse-v1');
    const phrase = await query(stack, { context: 'global', scope: { kind: 'all' }, text: { phrase: 'Light novel shelf' },
      filter: { all: [{ facet: 'language', any: ['en'] }] }, sort: 'relevance', page: { size: 20 } });
    expect(phrase.template).toBe('public-main-phrase-page-v1');
    const english = zones.samples.find(item => item.id === 'ongoing')!;
    const japanese = zones.samples.filter(item => item.id !== 'ongoing').map(item => item.iri);
    const hits = (phrase.result as { results: { work: string }[] }).results.map(item => item.work);
    expect(hits).toContain(english.iri);
    for (const work of japanese) expect(hits).not.toContain(work);
  } finally { await relay.end(); await stack.stop(); }
}, 420_000);

async function json<T>(response: Response, status = 201): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function readJson<T>(port: SeedPort, path: string): Promise<T> {
  const joined = `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(port.actingSubject)}`;
  const result = await port.request('GET', joined);
  if (result.status !== 200) {
    throw new Error(`GET ${path} HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 500)}`);
  }
  return result.body as T;
}

async function query(stack: Awaited<ReturnType<typeof startMediaStack>>, body: unknown) {
  const response = await stack.call('POST', '/v1/query', { body });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`query HTTP ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text) as { template: string; result: unknown };
}

async function releaseWorks(stack: Awaited<ReturnType<typeof startMediaStack>>, conditions: unknown[]) {
  const found = new Map<string, { matchedReleases: string[] }>();
  let continuation: string | undefined;
  for (let page = 0; page < 10; page++) {
    const body = await query(stack, { context: 'global', scope: { kind: 'all' }, sort: 'newest',
      page: { size: 20, ...(continuation ? { continuation } : {}) },
      filter: { all: [{ facet: 'release', where: { all: conditions } }] } });
    expect(body.template).toBe('release-works-v1');
    const result = body.result as { items: { id: string; matchedReleases: string[] }[]; nextCursor: string | null };
    for (const item of result.items) found.set(item.id, item);
    if (!result.nextCursor) return found;
    continuation = result.nextCursor;
  }
  throw new Error('release query did not finish paging');
}
