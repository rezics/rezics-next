import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { Pool } from 'pg';
import { cataloguePlan } from '../../../tests/fixtures/catalogue/load.ts';
import { catalogueWorkBody, CatalogueIntakeUnavailable } from '../../../tests/fixtures/catalogue/intake.ts';
import { SHOWCASE } from '../../../tests/fixtures/vndb/load.ts';
import { ZONE_PRESETS, type ZonePresentation } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { grantOfficialZoneSeed, type LocalOperatorInput } from './operator.ts';
import { seedKey, works } from './plan.ts';
import { refreshSeedTokens, stableId, type SeedState } from './state.ts';
import { call, createOwnWork, ensureHeader, grantVnSeedAuthority, publishCatalogueText, read, seedHttp,
  type HttpResult, type SeedPort } from './vn-catalogue-step.ts';

const BOOK = 'https://schema.org/Book';
const BROWSE = ['language', 'status', 'length'];
const SAMPLES = [
  { id: 'completed', title: 'Light novel shelf: completed', language: 'ja', status: 'completed' },
  { id: 'ongoing', title: 'Light novel shelf: ongoing', language: 'en', status: 'ongoing' },
  { id: 'hiatus', title: 'Light novel shelf: hiatus', language: 'ja', status: 'hiatus' },
] as const;

export interface ZoneRecord {
  id: string;
  space: string;
  realm: string;
  zone: string;
  navigationRevision: string;
  configurationRevision: string;
  collection: string;
  collectionRevision: string;
  members: string[];
  routeSegment: string;
}
export interface LnVnZonesManifest {
  zones: ZoneRecord[];
  samples: { id: string; iri: string; mainVersion: string }[];
  catalogueWorks: string[];
  showcase: string;
  libraryVersion: number;
}
interface ZoneSpec {
  id: string; name: string; language: string; routeSegment: string; preset: 'editorial';
  mountSegment: string; navigation: { label: string; href: string }[];
  browse: string[]; announcement: string; sharedMember: string;
}
interface ApplyInput {
  port: SeedPort;
  vnWorks: { vndb: string; iri: string }[];
  showcaseIri: string;
  extraBooks: string[];
}

const short = (iri: string) => iri.slice(-36);
const iri = (name: string) => `https://rezics.com/id/${stableId(name)}`;

export async function seedLnVnZones(state: SeedState): Promise<void> {
  const session = state.sessions[0];
  if (!session || !state.operatorInput || !state.operatorSession) {
    throw new Error('Light novel and visual novel Zones need the operator session');
  }
  const input: LocalOperatorInput = { ...state.operatorInput, ownerAccountSubject: session.accountId,
    actingSubject: session.actingSubject };
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  try {
    const vnWorks = [...state.created.entries()].flatMap(([key, receipt]) =>
      key.startsWith('vndb:') ? [{ vndb: key.slice('vndb:'.length), iri: receipt.work }] : []);
    const showcase = vnWorks.find(work => work.vndb === SHOWCASE.vn);
    if (!showcase) throw new Error('Visual novel Zone needs the seeded showcase Work');
    const extraBooks = works.filter(work => work.type === 'book').flatMap(work => {
      const created = state.created.get(work.id);
      return created ? [created.work] : [];
    });
    const manifest = await applyLnVnZones({
      port: {
        actingSubject: session.actingSubject,
        request: (method, path, body, key) => seedHttp(state, () => session.token, method, path, body, key),
        officialRequest: (method, path, body, key) => seedHttp(state,
          () => state.operatorSession!.token, method, path, body, key),
        grant: async (scope, action) => {
          if (action === 'zone.official') {
            await grantOfficialZoneSeed(input, scope.slice('zone:official:'.length));
            return;
          }
          await grantVnSeedAuthority(pool, input, scope, action);
        },
        refresh: () => refreshSeedTokens(state),
      },
      vnWorks, showcaseIri: showcase.iri, extraBooks,
    });
    console.log(`Light novels and visual novels: ${manifest.catalogueWorks.length} catalogue works, `
      + `${manifest.samples.length} shelf samples`);
  } finally { await pool.end(); }
}

export async function applyLnVnZones(input: ApplyInput): Promise<LnVnZonesManifest> {
  const port = input.port;
  const specs = [loadZone('light-novels.json'), loadZone('visual-novels.json')];
  if (specs.some(spec => spec.sharedMember !== SHOWCASE.vn)) {
    throw new Error('Both Zones share the showcase visual novel');
  }
  await port.grant('work:create:root', 'work.create');
  await port.grant('space:create:root', 'space.create');
  const catalogueWorks = await replayCatalogue(port);
  const published = [];
  for (const sample of SAMPLES) {
    const created = await createOwnWork(port, { key: seedKey('vndb-sample', sample.id), title: sample.title,
      language: sample.language, semanticType: BOOK });
    await port.grant(`work:edit:${created.work}`, 'work.edit');
    await port.grant(`work:read:${created.work}`, 'work.read');
    await port.grant(`contribution:create:${created.work}`, 'contribution.create');
    await port.grant(`publication:select:${created.mainVersion}`, 'publication.select');
    await ensureHeader(port, created.work, seedKey('vndb-sample-metadata', sample.id), {
      originalTitle: { value: sample.title, language: sample.language },
      completionStatus: sample.status,
      localized: [{ language: sample.language, title: sample.title, description: null, mainVersionLabel: null }],
    });
    const text = await publishCatalogueText(port, created, seedKey('vndb-sample-text', sample.id),
      sample.language, sample.title);
    published.push({ id: sample.id, iri: created.work, mainVersion: created.mainVersion,
      contribution: text.contribution, decision: text.decision });
  }
  const zones: ZoneRecord[] = [];
  for (const spec of specs) {
    const space = await call<{ space: string; realm: string }>(port, 'POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: spec.name,handle: spec.routeSegment,capabilities: ['realm'], actingSubject: port.actingSubject,
    }, seedKey('vndb-space', spec.id));
    const zone = iri(`vndb-zone:${spec.id}`);
    const collection = iri(`vndb-collection:${spec.id}`);
    await port.grant(`zone:edit:${zone}`, 'zone.edit');
    await port.grant(`semantic:read:${zone}`, 'semantic.read');
    await call(port, 'POST', '/v1/zones', {
      zone, space: space.space, disclosure: 'public', name: spec.name, language: spec.language,
      actingSubject: port.actingSubject,
    }, seedKey('vndb-zone', spec.id));
    await port.grant(`collection:edit:${collection}`, 'collection.edit');
    await port.grant(`semantic:read:${collection}`, 'semantic.read');
    await call<{ structure: string; revision: string }>(port, 'POST', '/v1/collections', {
      collection, name: spec.name, language: spec.language, disclosure: 'public',
      actingSubject: port.actingSubject,
    }, seedKey('vndb-collection', spec.id));
    await port.grant(`zone:official:${zone}`, 'zone.official');
    const configurationRevision = await configureZone(port, spec, zone, space.realm, collection);
    if (spec.id === 'light-novels') {
      await port.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
      for (const sample of published) {
        await call(port, 'POST', '/v1/publication-selections', {
          profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: space.realm },
          work: sample.iri, mainVersion: sample.mainVersion, contribution: sample.contribution,
          publicationDecision: sample.decision, expectedSelectionHead: null,
          selectionBasis: 'realm-manager-review', actingSubject: port.actingSubject,
        }, seedKey('vndb-sample-adoption', sample.id));
      }
    }
    const members = spec.id === 'visual-novels'
      ? input.vnWorks.map(work => work.iri)
      : [...catalogueWorks, ...input.extraBooks, ...published.map(sample => sample.iri), input.showcaseIri];
    const collectionRevision = await insertMembers(port, spec.id, collection, unique(members));
    const navigationRevision = await mountCatalogue(port, spec.id, zone, collection);
    zones.push({ id: spec.id, space: space.space, realm: space.realm, zone, navigationRevision,
      configurationRevision, collection, collectionRevision, members: unique(members).sort(),
      routeSegment: spec.routeSegment });
  }
  const libraryVersion = await markReading(port, input.showcaseIri);
  zones.sort((left, right) => left.id.localeCompare(right.id));
  return { zones, samples: published.map(({ id, iri: work, mainVersion }) => ({ id, iri: work, mainVersion })),
    catalogueWorks: [...catalogueWorks].sort(), showcase: input.showcaseIri, libraryVersion };
}

function loadZone(file: string): ZoneSpec {
  const spec = JSON.parse(readFileSync(join(import.meta.dir, '../../../config/zones', file), 'utf8')) as ZoneSpec;
  if (!isDeepStrictEqual(spec.browse, BROWSE)) {
    throw new Error(`${spec.id} browse facets are not language, status and length`);
  }
  if (spec.preset !== 'editorial' || spec.mountSegment !== 'catalogue' || spec.announcement.length > 120) {
    throw new Error(`${spec.id} Zone configuration is outside the seed`);
  }
  return spec;
}

function catalogueKey(suffix: string): string {
  const value = `catalogue:v1:${suffix.toLowerCase().replace(/[^a-z0-9:_./-]+/g, '-').replace(/^-|-$/g, '')}`;
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(value)) throw new Error(`catalogue idempotency key is invalid: ${value}`);
  return value;
}

/** Replay the franchise loader's exact intents, including its retained search evidence. */
async function replayCatalogue(port: SeedPort): Promise<string[]> {
  const found: string[] = [];
  for (const item of cataloguePlan().works) {
    const key = catalogueKey(`work:${item.id}`);
    let body: Awaited<ReturnType<typeof catalogueWorkBody>>;
    try {
      body = await catalogueWorkBody(port, { title: item.title, language: 'ja', semanticTypes: [item.semanticType] }, key);
    } catch (error) {
      if (error instanceof CatalogueIntakeUnavailable && found.length === 0) return [];
      throw error;
    }
    const result = await port.request('POST', '/v1/works', body, key);
    if (result.status >= 400) fail(result, `catalogue work ${item.id}`);
    const work = (result.body as { work?: string }).work;
    if (!work) throw new Error(`Catalogue work ${item.id} has no IRI`);
    found.push(work);
    await port.grant(`work:read:${work}`, 'work.read');
  }
  return found;
}

function presentation(spec: ZoneSpec, collection: string): ZonePresentation {
  return {
    profile: 'zone-presentation-v1', preset: spec.preset, tokens: ZONE_PRESETS[spec.preset],
    navigation: spec.navigation, banners: [],
    modules: [
      { id: 'announcement', type: 'announcement', title: spec.announcement,
        source: { kind: 'query-block', block: 'new-adoptions' } },
      { id: 'shelf', type: 'shelf', title: spec.name, source: { kind: 'collection', collection },
        options: { layout: 'covers', limit: 12 } },
    ],
  };
}

async function configureZone(port: SeedPort, spec: ZoneSpec, zone: string, realm: string, collection: string) {
  const current = await read<{ revision: string; name: string; language: string; configuration: {
    defaultRealm: string | null; official: Record<string,never> | null; presentation: unknown } }>(port,
    `/v1/zones/${short(zone)}/configuration`);
  const desired = { name: spec.name, language: spec.language, defaultRealm: realm,
    official: {}, presentation: presentation(spec, collection) };
  const actual = { name: current.name, language: current.language, defaultRealm: current.configuration.defaultRealm,
    official: current.configuration.official, presentation: current.configuration.presentation };
  if (!isDeepStrictEqual(actual, desired)) {
    const writer: SeedPort = port.officialRequest ? { ...port, request: port.officialRequest } : port;
    await call(writer, 'PUT', `/v1/zones/${short(zone)}/configuration`, {
      expectedHead: current.revision, actingSubject: port.actingSubject, ...desired,
    }, seedKey('vndb-zone-config', `${spec.id}:${current.revision.slice(-12)}`));
  }
  const saved = await read<{ revision: string }>(port, `/v1/zones/${short(zone)}/configuration`);
  return saved.revision;
}

async function insertMembers(port: SeedPort, zoneId: string, collection: string, wanted: string[]) {
  let page = await collectionPage(port, collection);
  let head = page.revision;
  const missing = wanted.filter(target => !page.targets.has(target));
  for (let offset = 0; offset < missing.length; offset += 16) {
    const batch = missing.slice(offset, offset + 16);
    const written = await call<{ revision: string }>(port, 'POST', `/v1/collections/${short(collection)}/changes`, {
      expectedHead: head, actingSubject: port.actingSubject,
      operations: batch.map(target => ({ op: 'insert', role: 'member', parent: page.structure,
        position: 'last', target, selection: { mode: 'follow-context' } })),
    }, seedKey('vndb-members', `${zoneId}:${head.slice(-12)}:${offset}`));
    head = written.revision;
  }
  page = await collectionPage(port, collection);
  return page.revision;
}

export async function collectionPage(port: SeedPort, collection: string) {
  const targets = new Set<string>();
  let after: string | null = null;
  let structure = '';
  let revision = '';
  do {
    const page: { structure: string; revision: string; next: string | null;
      occurrences: { state?: string; role?: string; target?: string }[] } = await read(port,
      `/v1/collections/${short(collection)}?limit=20${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    structure = page.structure;
    revision = page.revision;
    for (const item of page.occurrences) {
      if (item.state !== 'removed' && item.role === 'member' && item.target) targets.add(item.target);
    }
    after = page.next;
  } while (after);
  return { structure, revision, targets };
}

async function mountCatalogue(port: SeedPort, zoneId: string, zone: string, collection: string) {
  const page = await read<{ revision: string; mounts: { target?: string; state?: string }[] }>(port,
    `/v1/zones/${short(zone)}?limit=100`);
  if (!page.mounts.some(item => item.target === collection && item.state !== 'removed')) {
    await call(port, 'POST', `/v1/zones/${short(zone)}/mounts`, {
      expectedHead: page.revision, target: collection, routeSegment: 'catalogue', disclosure: 'public',
      position: 'last', actingSubject: port.actingSubject,
    }, seedKey('vndb-mount', zoneId));
  }
  const saved = await read<{ revision: string }>(port, `/v1/zones/${short(zone)}?limit=1`);
  return saved.revision;
}

async function markReading(port: SeedPort, work: string) {
  const current = await read<{ status: { status: string | null; version: number } }>(port,
    `/v1/works/${short(work)}/reader-state`);
  if (current.status.status !== 'reading') {
    await call(port, 'PUT', `/v1/works/${short(work)}/reader-status`, {
      actingSubject: port.actingSubject, expectedVersion: current.status.version, status: 'reading',
    }, seedKey('vndb-library', `${short(work)}:${current.status.version}`));
  }
  const saved = await read<{ status: { version: number } }>(port, `/v1/works/${short(work)}/reader-state`);
  return saved.status.version;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function fail(result: HttpResult, operation: string): never {
  throw new Error(`${operation} HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 500)}`);
}
