// Writes the anime and manga Zones into the isolated QA stack the browser harness already
// started, through the same public writes as the dev seed. A dated Work's year is an accepted
// Statement on the seeded first-publication property. The fact panel needs the package
// approval; a failure there is left as the error, not replaced with a stub digest.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { animeMangaSamplePlan, applyAnimeMangaZones, type CatalogueZoneRecord, type CatalogueWorkRecord }
  from '../../../scripts/dev/seed/anime-manga-zones-step.ts';
import { seedKey } from '../../../scripts/dev/seed/plan.ts';
import { officialTheme } from '../../../scripts/dev/seed/official-plan.ts';
import { approveOfficialPackage } from '../../../scripts/dev/seed/official-theme-step.ts';
import { stableId } from '../../../scripts/dev/seed/state.ts';
import type { SeedPort } from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { catalogueCountProperty } from '../features/zones/catalogue-count.ts';
import { openActorPlatformGroup } from './g-838-catalogue.ts';
import { DATE_PUBLISHED_PREDICATE } from '../../../services/main/src/modules/statement/qualification.ts';

const QUERY = 'https://rezics.com/query/work-publication-years';

if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(process.env.REZICS_QA_RUN_ID ?? '')) {
  throw new Error('The anime and manga Zone seed writes only into an isolated QA run');
}
const workHubOnly = process.argv.includes('--work-hub');
if (process.argv.slice(2).some(argument => argument !== '--work-hub')) {
  throw new Error('Unknown anime and manga seed option');
}
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
if (!objectDirectory || !process.env.REZICS_WEB_AUTH_PRIVATE_PATH || !process.env.ACCOUNT_RELAY_DATABASE_URL) {
  throw new Error('MAIN_OBJECT_DIRECTORY, REZICS_WEB_AUTH_PRIVATE_PATH and ACCOUNT_RELAY_DATABASE_URL must name the running stack');
}

interface SeededZone {
  handle: 'anime' | 'manga';
  space: string;
  realm: string;
  zone: string;
  longWork: string;
  title: string;
  concept: string;
  publicationDate: string;
  releases: SeededRelease[];
  undatedWork: string;
  undatedTitle: string;
  undatedConcept: string;
}
interface SeededRelease { id: string; title: string }
interface Seeded {
  anime: SeededZone;
  manga: SeededZone;
}

// Package review names this member's Agent.
const stack = await startMediaStack('anime-manga-zones', { profileCredits: true });
for (const prefix of ['semantic/work/', 'semantic/structure/'] as const) {
  const objects = stack.objects(prefix);
  await objects.initialize();
  Object.assign(stack.env, {
    objectDirectory,
    [prefix === 'semantic/work/' ? 'workObjects' : 'structureObjects']: objects,
  });
}
const relay = new Pool({ connectionString: process.env.ACCOUNT_RELAY_DATABASE_URL });
const directory = resolve('.temp/anime-manga-zones', process.env.REZICS_QA_RUN_ID!);
mkdirSync(directory, { recursive: true });

function parsed(text: string): unknown {
  try { return text ? JSON.parse(text) as unknown : null; } catch { return text; }
}

async function addEditionChoices(request: SeedPort['request'], actor: string, work: CatalogueWorkRecord,
  choices: readonly [{ key: string; title: string; platform: string; year: number },
    { key: string; title: string; platform: string; year: number }]): Promise<SeededRelease[]> {
  const realization = `https://rezics.com/id/${stableId(`anime-manga-hub:${work.work}:realization`)}`;
  const realizationResult = await seedJson<{ revision: string }>(request, 'PUT',
    `/v1/works/${work.work.slice(-36)}/realizations/${realization.slice(-36)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
      language: 'ja', kind: 'original', translators: [], publishers: [],
      source: { kind: 'unresolved', work: work.work }, status: 'official', verification: 'verified',
      evidence: 'https://example.com/anime-manga-hub-original',
    }, seedKey('anime-manga-hub-realization', work.work));

  const releases: SeededRelease[] = [];
  for (const choice of choices) {
    const release = `https://rezics.com/id/${stableId(`anime-manga-hub:${work.work}:${choice.key}`)}`;
    await seedJson(request, 'PUT', `/v1/works/${work.work.slice(-36)}/releases/${release.slice(-36)}`, {
      profile: 'release-v2', id: release, expectedHead: null, actingSubject: actor,
      kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null,
      title: { value: choice.title, language: 'en' }, editionStatement: null,
      publisher: 'REZICS Catalogue', publicationYear: choice.year, isbn13: null,
      originalUrl: null, fixedRelease: null, evidence: null, identifiers: [],
      platform: choice.platform, territory: null,
      coverage: [{ realization, revision: realizationResult.revision, completeness: 'complete' }],
    }, seedKey('anime-manga-hub-release', `${work.work}:${choice.key}`));
    releases.push({ id: release, title: choice.title });
  }
  return releases;
}

async function seedJson<T = unknown>(request: SeedPort['request'], method: 'GET' | 'POST' | 'PUT', path: string,
  body: unknown, key: string): Promise<T> {
  const result = await request(method, path, body, key);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result.body as T;
}

try {
  const editor = await stack.member('catalogue-editor');
  const reviewer = workHubOnly ? null : await stack.member('theme-reviewer');
  // Theme activation answers 202 until the command settles. Poll the same key the way the
  // official-package journey does, and return the finished response.
  const send = async (token: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, key?: string) => {
    const idempotency = key ?? randomUUID();
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await stack.call(method, path, { token, body, key: idempotency });
      if (response.status !== 202) {
        const text = await response.text();
        return { status: response.status, body: parsed(text) };
      }
      await response.text();
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error(`${method} ${path} stayed pending`);
  };
  const request: SeedPort['request'] = (method, path, body, key) => send(editor.token, method, path, body, key);
  const review: SeedPort['request'] = (method, path, body, key) => send(reviewer!.token, method, path, body, key);
  const port: SeedPort = {
    actingSubject: editor.actor,
    request,
    grant: async (scope, action) => { await editor.grant(scope, action); },
  };
  const hubSamples = workHubOnly
    ? animeMangaSamplePlan().filter(sample => ['long-tv', 'long-manga', 'tv-3', 'manga-3'].includes(sample.key))
    : undefined;
  const created = await applyAnimeMangaZones(port, hubSamples);
  if (!workHubOnly) {
    await openActorPlatformGroup(editor.principalId, 'executable-themes');
    await openActorPlatformGroup(reviewer!.principalId, 'executable-themes');
    for (const zone of created.zones) {
      const theme = officialTheme(zone.id).slice(-36);
      for (const [scope, action] of [
        ['theme:create:root', 'theme.create'],
        [`theme:revise:${theme}`, 'theme.revise'],
        [`theme:activate:${theme}`, 'theme.activate'],
      ] as const) await editor.grant(scope, action);
      await reviewer!.grant(`theme:review:${theme}`, 'theme.review');
      await approveOfficialPackage({
        slug: zone.id, zone: zone.zone, owner: editor.actor, reviewer: reviewer!.actor, request, review,
      });
    }
  }
  const longTv = workOf(created.works, 'long-tv');
  const longManga = workOf(created.works, 'long-manga');
  const undatedTv = workOf(created.works, 'tv-3');
  const undatedManga = workOf(created.works, 'manga-3');
  const animeReleases = await addEditionChoices(request, editor.actor, longTv, [
    { key: 'broadcast', title: 'Long TV broadcast edition', platform: 'television', year: 1980 },
    { key: 'disc', title: 'Long TV collector edition', platform: 'blu-ray', year: 1980 },
  ]);
  const mangaReleases = await addEditionChoices(request, editor.actor, longManga, [
    { key: 'tankobon', title: 'Long Manga tankōbon', platform: 'paperback', year: 1995 },
    { key: 'omnibus', title: 'Long Manga omnibus', platform: 'ebook', year: 1995 },
  ]);
  if (workHubOnly) {
    await waitForPublicationRead(request, editor.actor, longTv.work, '1980-01-01');
    await waitForPublicationRead(request, editor.actor, longManga.work, '1995-01-01');
  } else {
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch, true);
    const projection = new ZoneBrowseProjection(stack.accessPool, relay, stack.env);
    await projection.backfill();
    const admin = await platformAdministratorSession(process.env, 'openid access:grant work:read');
    // Discovery routes admit the platform administrator. A realm generation also
    // requires the recommendation-management grant on that same Agent.
    await grantRecommendationManagement(admin.principalId, admin.actingSubject);
    for (const zone of created.zones) await buildRealmDiscovery(admin.mainOrigin, await admin.session.current(), admin.actingSubject, zone.realm);
    await expectYear(admin.mainOrigin, 1980, longTv.work);
    await expectYear(admin.mainOrigin, 1995, longManga.work);
    // Cards read accepted statements. That read stays unavailable until the statement index
    // has caught the graph head, so wait for the long series before the browser opens.
    await waitForCatalogueRead(admin.mainOrigin, longTv.work, '1155', 'episode-count');
    await waitForCatalogueRead(admin.mainOrigin, longManga.work, '21', 'volume-count');
  }
  const seeded = record(created.zones, longTv, longManga, undatedTv, undatedManga, animeReleases, mangaReleases);
  writeFileSync(resolve(directory, 'seed.json'), JSON.stringify(seeded));
  console.log(JSON.stringify(seeded));
} finally {
  await relay.end();
  await stack.stop();
}

function workOf(works: CatalogueWorkRecord[], key: string): CatalogueWorkRecord {
  const found = works.find(item => item.key === key);
  if (!found) throw new Error(`Sample ${key} was not created`);
  return found;
}

function record(zones: CatalogueZoneRecord[], longTv: CatalogueWorkRecord, longManga: CatalogueWorkRecord,
  undatedTv: CatalogueWorkRecord, undatedManga: CatalogueWorkRecord,
  animeReleases: SeededRelease[], mangaReleases: SeededRelease[]): Seeded {
  const zone = (id: 'anime' | 'manga', work: CatalogueWorkRecord, undated: CatalogueWorkRecord,
    releases: SeededRelease[]): SeededZone => {
    const found = zones.find(item => item.id === id);
    if (!found) throw new Error(`${id} Zone was not created`);
    if (!work.concept || !undated.concept || work.year === null) {
      throw new Error(`${id} hub fixtures must be classified, with a recorded date on the dated Work`);
    }
    return { handle: id, space: found.space, realm: found.realm, zone: found.zone,
      longWork: work.work, title: work.title, concept: work.concept, publicationDate: `${work.year}-01-01`, releases,
      undatedWork: undated.work, undatedTitle: undated.title, undatedConcept: undated.concept };
  };
  return { anime: zone('anime', longTv, undatedTv, animeReleases),
    manga: zone('manga', longManga, undatedManga, mangaReleases) };
}

interface DiscoveryView {
  generation: string;
  checkpoint: string;
  complete: boolean;
  activeHeadRevision: string | null;
}

async function grantRecommendationManagement(principalId: string, actor: string): Promise<void> {
  const client = await stack.accessPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [MANAGE_SCOPE]);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')
      ON CONFLICT (id) DO NOTHING`, [actor]);
    const represented = await client.query(`SELECT 1 FROM access.representation
      WHERE principal_id = $1 AND subject_id = $2 AND action = $3 AND active AND valid_until > now()`,
    [principalId, actor, MANAGE_ACTION]);
    if (!represented.rowCount) await client.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '2 hours')`,
    [randomUUID(), principalId, actor, MANAGE_ACTION]);
    const granted = await client.query(`SELECT 1 FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active AND valid_until > now()`,
    [actor, MANAGE_SCOPE, MANAGE_ACTION]);
    if (!granted.rowCount) await client.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '2 hours')`,
    [randomUUID(), actor, MANAGE_SCOPE, MANAGE_ACTION]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function discoverySend(origin: string, token: string, method: string, path: string, body?: unknown): Promise<DiscoveryView> {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status === 409 && text.includes('read_basis_changed')) {
    throw new Error('discovery-restart');
  }
  if (response.status >= 400) throw new Error(`Discovery ${method} ${path} ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as DiscoveryView;
}

async function buildRealmDiscovery(origin: string, token: string, actor: string, realm: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let row = await discoverySend(origin, token, 'POST', '/v1/discovery/generation-builds', {
        profile: 'discovery-generation-build-v1', actingSubject: actor,
        basis: { scope: 'realm', realm, context: null },
      });
      for (let step = 0; !row.complete && step < 40; step++) {
        row = await discoverySend(origin, token, 'POST', `/v1/discovery/generations/${row.generation}/advance`, {
          actingSubject: actor, expectedCheckpoint: row.checkpoint,
        });
      }
      if (!row.complete) throw new Error(`Realm discovery did not finish for ${realm}`);
      const head = await discoverySend(origin, token, 'GET',
        `/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(actor)}`);
      await discoverySend(origin, token, 'POST', '/v1/discovery/generation-activations', {
        profile: 'discovery-generation-activation-v1', actingSubject: actor, generation: row.generation,
        expectedHeadRevision: head.activeHeadRevision,
      });
      return;
    } catch (error) {
      if (error instanceof Error && error.message === 'discovery-restart' && attempt < 2) continue;
      throw error;
    }
  }
}

async function waitForCatalogueRead(origin: string, work: string, lexical: string,
  notation: 'episode-count' | 'volume-count'): Promise<void> {
  const id = work.slice(-36);
  let detail = '';
  for (let attempt = 0; attempt < 45; attempt++) {
    while (await stack.statementSeek.projectOnce()) { /* index statements the card reads */ }
    const statements = await fetch(new URL(`/v1/resources/${id}/statements`, origin));
    const statementText = await statements.text();
    const classes = await fetch(new URL(`/v1/works/${id}/classifications`, origin));
    await classes.text();
    const definition = await fetch(new URL(`/v1/lexicon/definitions/${notation}`, origin));
    const definitionText = await definition.text();
    detail = `statements ${statements.status} ${statementText.slice(0, 180)}; classifications ${classes.status}; ${notation} ${definition.status} ${definitionText.slice(0, 120)}`;
    if (statements.status === 200 && statementText.includes(`"${lexical}"`) && classes.status === 200) {
      // A count is a public property. The key returns kind and the subject → value rendering.
      // A missing or closed property stays 404; waiting does not make it public.
      const body = definition.status === 200 ? parsed(definitionText) : null;
      const property = catalogueCountProperty(body && typeof body === 'object' ? body : null, 'en');
      if (property) return;
      throw new Error(`Catalogue count ${notation} is not a public property: ${detail}`);
    }
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error(`Catalogue facts for ${work} stayed unreadable: ${detail}`);
}

async function waitForPublicationRead(request: SeedPort['request'], actor: string, work: string,
  lexical: string): Promise<void> {
  const path = `/v1/resources/${work.slice(-36)}/statements?actingSubject=${encodeURIComponent(actor)}`;
  let detail = '';
  for (let attempt = 0; attempt < 45; attempt++) {
    while (await stack.statementSeek.projectOnce()) { /* index accepted publication dates for the Work page */ }
    const result = await request('GET', path);
    const page = result.body as { groups?: Array<{ predicate?: string; items?: Array<{
      kind?: string; value?: { kind?: string; lexical?: string };
    }> }> };
    const dates = page.groups?.flatMap(group => group.predicate === DATE_PUBLISHED_PREDICATE
      ? group.items?.filter(item => item.kind === 'statement' && item.value?.kind === 'literal')
        .map(item => item.value?.lexical) ?? []
      : []) ?? [];
    detail = `statements ${result.status}; dates ${dates.join(', ')}`;
    if (result.status === 200 && dates.includes(lexical)) return;
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error(`Publication date ${lexical} for ${work} stayed unreadable: ${detail}`);
}

async function expectYear(origin: string, year: number, work: string): Promise<void> {
  let cursor: string | undefined;
  const found: string[] = [];
  for (let page = 0; page < 8; page++) {
    let response: Response | null = null;
    let text = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      response = await fetch(new URL('/v1/query', origin), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'template-query-v1', query: QUERY, revision: 1,
          parameters: { fromYear: year, toYear: year }, limit: 20, ...(cursor ? { cursor } : {}) }),
      });
      text = await response.text();
      if (response.status === 503 && attempt < 7) {
        await new Promise(done => setTimeout(done, 500));
        continue;
      }
      break;
    }
    if (!response || response.status !== 200) throw new Error(`Year ${year}: ${response?.status} ${text.slice(0, 400)}`);
    const body = JSON.parse(text) as { result?: { items: { id: string }[]; nextCursor: string | null } };
    found.push(...(body.result?.items.map(item => item.id) ?? []));
    if (!body.result?.nextCursor) break;
    cursor = body.result.nextCursor;
  }
  if (!found.includes(work)) throw new Error(`Year ${year} does not list ${work}`);
}
