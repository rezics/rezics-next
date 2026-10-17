import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { importBangumiWorkFacts, type BangumiFactSource, type BangumiFactsClient }
  from '../../datasets/bangumi.ts';
import { ZONE_PRESETS, type ZonePresentation } from '../../../services/main/src/modules/zone/presentation-format.ts';
import type { SerialStatus } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { statementDecisionBody, classifiedStatementBody, discloseClassificationConcept,
  shareClassificationContext } from './classified-statement.ts';
import { collectionPage, createSpace } from './ln-vn-zones-step.ts';
import { adoptZoneSpace } from './realms-step.ts';
import { officialTheme } from './official-plan.ts';
import { grantOfficialZoneSeed, type LocalOperatorInput } from './operator.ts';
import { seedKey } from './plan.ts';
import { DATE_PUBLISHED_DEFINITION_NOTATION } from '../../../services/main/src/modules/statement/qualification.ts';
import type { DefinitionState } from '../../../services/main/src/modules/semantic/change.ts';
import { declaredCountProperties, workFormatConcepts, type WorkFormatKey } from './relation-lexicon-data.ts';
import { seedWorkFormat, type SeedLexiconReceipt } from './relation-lexicon.ts';
import { refreshSeedTokens, stableId, type SeedState } from './state.ts';
import { call, createCatalogueWork, grantVnSeedAuthority, publishCatalogueText, read, seedHttp,
  type SeedPort } from './vn-catalogue-step.ts';

const BOOK = 'https://schema.org/Book';
const INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const DATE = 'http://www.w3.org/2001/XMLSchema#date';
const short = (iri: string) => iri.slice(-36);
const zoneIri = (id: string) => `https://rezics.com/id/${stableId(`zone:${id}`)}`;

export type CatalogueZoneId = 'anime' | 'manga';
export interface CatalogueSample {
  key: string;
  zone: CatalogueZoneId;
  title: string;
  language: 'ja' | 'en';
  /** A calendar year the publication-year read can list. Null means no year is recorded. */
  year: number | null;
  subject: { kind: 'bangumi'; source: BangumiFactSource }
    | { kind: 'one-shot'; subjectId: string; volumes: number | null; status: SerialStatus | null };
}

const bangumi = (id: number, type: number, platform: number, extra: Record<string, unknown> = {}): CatalogueSample['subject'] =>
  ({ kind: 'bangumi', source: { id, type, platform, ...extra } });

/** Enough mixed anime and manga that a format filter passes the first browse page. */
export function animeMangaSamplePlan(): CatalogueSample[] {
  const samples: CatalogueSample[] = [];
  for (let index = 0; index < 22; index++) {
    const tags = index === 1 ? ['未放送'] : index === 2 ? ['取消'] : index % 2 === 0 ? ['已完结'] : ['连载中'];
    samples.push({
      key: index === 0 ? 'long-tv' : `tv-${index}`, zone: 'anime',
      title: index % 2 === 0 ? `長編シリーズ ${index}` : `Long running ${index}`,
      language: index % 2 === 0 ? 'ja' : 'en', year: index === 3 ? null : 1980 + index,
      subject: bangumi(910000 + index, 2, 1, { eps: index === 0 ? 1155 : 12, meta_tags: tags }),
    });
  }
  const animeFormats = [
    ['movie', 3, 12], ['movie-2', 3, 1], ['ova', 2, 6], ['ona', 5, 8], ['special', 4, 1],
  ] as const;
  for (const [key, platform, eps] of animeFormats) {
    samples.push({ key, zone: 'anime', title: `Anime ${key}`, language: 'ja', year: 2001,
      subject: bangumi(911000 + platform + samples.length, 2, platform, { eps, meta_tags: ['已完结'] }) });
  }
  samples.push({ key: 'anime-unclassified', zone: 'anime', title: 'Unclassified picture', language: 'en', year: null,
    subject: bangumi(912000, 2, 99) });
  for (let index = 0; index < 22; index++) {
    const tags = index === 1 ? ['未发售'] : index === 2 ? ['腰斩'] : index % 2 === 0 ? ['已完结'] : ['连载中'];
    samples.push({
      key: index === 0 ? 'long-manga' : `manga-${index}`, zone: 'manga',
      title: index % 2 === 0 ? `長編漫画 ${index}` : `Long comic ${index}`,
      language: index % 2 === 0 ? 'ja' : 'en', year: index === 3 ? null : 1995 + index,
      subject: bangumi(920000 + index, 1, 1001, { ...(index === 3 ? {} : { volumes: index === 0 ? 21 : 3 }),
        meta_tags: tags }),
    });
  }
  samples.push({ key: 'one-shot', zone: 'manga', title: '読切', language: 'ja', year: 2012,
    subject: { kind: 'one-shot', subjectId: '930001', volumes: 1, status: 'completed' } });
  samples.push({ key: 'one-shot-en', zone: 'manga', title: 'A single chapter', language: 'en', year: null,
    subject: { kind: 'one-shot', subjectId: '930002', volumes: null, status: 'upcoming' } });
  samples.push({ key: 'manga-unclassified', zone: 'manga', title: 'Unclassified book', language: 'en', year: null,
    subject: bangumi(922000, 1, 999) });
  return samples;
}

/** One-shot has no Bangumi field. The same statement and metadata writes still record it. */
export async function importOneShotFacts(client: BangumiFactsClient, actingSubject: string,
  work: { work: string; mainVersion: string }, sample: Extract<CatalogueSample['subject'], { kind: 'one-shot' }>):
  Promise<{ concept: string; countPredicate: string | null }> {
  const seeded = await seedWorkFormat(client, actingSubject);
  const post = <T>(path: string, body: unknown, _token: string, key: string) => client.post<T>(path, body as object, key);
  const context = await shareClassificationContext(post, '', actingSubject,
    workFormatConcepts.map(item => seeded.concepts[item.key]), 'work-format:v1:context');
  for (const item of workFormatConcepts) {
    await discloseClassificationConcept(post, '', actingSubject, seeded.concepts[item.key].concept,
      `work-format:v1:hint:${item.key}`);
  }
  const format: WorkFormatKey = 'one-shot';
  const prefix = `work-format:v1:${work.work.slice(-36)}:${sample.subjectId}`;
  const concept = seeded.concepts[format].concept;
  const statement = await client.post<{ statement: string; meaningKey: string }>('/v1/statements',
    classifiedStatementBody(actingSubject, work.mainVersion, concept, context), `${prefix}:format`);
  await client.post('/v1/statement-decisions', statementDecisionBody(actingSubject, statement, { kind: 'global' },
    'accepted', null), `${prefix}:format-decision`);
  let countPredicate: string | null = null;
  if (sample.volumes) {
    const notation = declaredCountProperties.find(item => item.notation === 'volume-count')!.notation;
    const definition = seeded.counts[notation];
    countPredicate = definition.component;
    const count = await client.post<{ statement: string; meaningKey: string }>('/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.work, predicate: definition.component,
      relationDefinition: definition.revision,
      value: { kind: 'literal', lexical: String(sample.volumes), datatype: INTEGER, language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject,
    }, `${prefix}:volume-count`);
    await client.post('/v1/statement-decisions', statementDecisionBody(actingSubject, count, { kind: 'global' },
      'accepted', null), `${prefix}:volume-count:decision`);
  }
  if (sample.status) {
    await client.put(`/v1/works/${work.work.slice(-36)}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: null, actingSubject,
      state: { kind: 'header', originalTitle: null, completionStatus: sample.status, localized: [] },
    }, `${prefix}:status`);
  }
  return { concept, countPredicate };
}

export interface CatalogueWorkRecord {
  key: string; zone: CatalogueZoneId; work: string; mainVersion: string;
  contribution: string; decision: string; concept: string | null; year: number | null; title: string;
}
export interface CatalogueZoneRecord { id: CatalogueZoneId; space: string; realm: string; zone: string; theme: string }

function factsClient(port: SeedPort): BangumiFactsClient & {
  currentDefinition(notation: string): Promise<(SeedLexiconReceipt & { state: DefinitionState }) | null>;
} {
  return {
    post: (path, body, key) => call(port, 'POST', path, body, key),
    put: (path, body, key) => call(port, 'PUT', path, body, key),
    authorizeDefinition: receipt => port.grant(`semantic:read:${receipt.component}`, 'semantic.read'),
    currentDefinition: notation => currentPublicationProperty(port, notation),
  };
}

/** The lexicon key of an active property, when this stack already seeded it. */
async function currentPublicationProperty(port: SeedPort, notation: string):
  Promise<(SeedLexiconReceipt & { state: DefinitionState }) | null> {
  const result = await port.request('GET',
    `/v1/lexicon/definitions/${notation}?actingSubject=${encodeURIComponent(port.actingSubject)}`);
  if (result.status === 404) return null;
  if (result.status !== 200) {
    throw new Error(`GET /v1/lexicon/definitions/${notation} HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 400)}`);
  }
  const body = result.body as { kind?: unknown; definition?: unknown; revision?: unknown; lifecycle?: unknown; roles?: unknown };
  if (body.kind !== 'property' || body.lifecycle !== 'active' || typeof body.definition !== 'string'
    || typeof body.revision !== 'string' || !Array.isArray(body.roles) || body.roles.length !== 0) return null;
  return {
    component: body.definition, revision: body.revision,
    state: { component: 'definition', kind: 'property', lifecycle: 'active', successor: null, roles: [], notation },
  };
}

/** Component and revision of the seeded first-publication property. */
export function cataloguePublicationDate(body: { kind?: unknown; definition?: unknown; revision?: unknown }):
  { component: string; revision: string } {
  if (body.kind !== 'property' || typeof body.definition !== 'string' || typeof body.revision !== 'string') {
    throw new Error('First-publication date is not a seeded property');
  }
  return { component: body.definition, revision: body.revision };
}

/** An accepted date Statement on the seeded first-publication property. The year read lists that Statement. */
export async function recordCataloguePublicationYear(post: BangumiFactsClient['post'], actor: string, work: string,
  year: number, definition: { component: string; revision: string }, key: string): Promise<void> {
  const statement = await post<{ statement: string }>('/v1/statements', {
    profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work, predicate: definition.component,
    relationDefinition: definition.revision,
    value: { kind: 'literal', lexical: `${year}-01-01`, datatype: DATE, language: null },
    applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: actor,
  }, `catalogue-year:v1:${key}`);
  await post('/v1/statement-decisions', {
    profile: 'statement-decision-v1', target: { kind: 'statement', statement: statement.statement },
    acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted', actingSubject: actor,
  }, `catalogue-year:v1:${key}:decision`);
}

async function importSample(client: BangumiFactsClient, actor: string, work: { work: string; mainVersion: string },
  sample: CatalogueSample): Promise<string | null> {
  if (sample.subject.kind === 'bangumi') {
    const imported = await importBangumiWorkFacts(client, actor, work, sample.subject.source);
    return imported.concept;
  }
  const imported = await importOneShotFacts(client, actor, work, sample.subject);
  return imported.concept;
}

function presentation(name: string, collection: string, theme: string): ZonePresentation {
  return {
    profile: 'zone-presentation-v2', preset: 'editorial', tokens: ZONE_PRESETS.editorial,
    navigation: [{ label: 'Browse', href: '/browse' }], slides: [],
    official: { theme },
    modules: [
      { id: 'announcement', type: 'announcement', title: `${name} in the catalogue`,
        source: { kind: 'query-block', block: 'new-adoptions' } },
      { id: 'shelf', type: 'shelf', title: name, source: { kind: 'collection', collection },
        options: { layout: 'covers', limit: 12 } },
    ],
  };
}

async function configure(port: SeedPort, id: CatalogueZoneId, zone: string, realm: string, collection: string,
  name: string) {
  const current = await read<{ revision: string; name: string; language: string; configuration: {
    defaultRealm: string | null; official: Record<string, never> | null; presentation: unknown } }>(port,
    `/v1/zones/${short(zone)}/configuration`);
  const desired = { name, language: 'en', defaultRealm: realm, official: {},
    presentation: presentation(name, collection, officialTheme(id)) };
  const actual = { name: current.name, language: current.language, defaultRealm: current.configuration.defaultRealm,
    official: current.configuration.official, presentation: current.configuration.presentation };
  if (!isDeepStrictEqual(actual, desired)) {
    const writer: SeedPort = port.officialRequest ? { ...port, request: port.officialRequest } : port;
    await call(writer, 'PUT', `/v1/zones/${short(zone)}/configuration`, {
      expectedHead: current.revision, actingSubject: port.actingSubject, ...desired,
    }, seedKey('catalogue-zone-config', `${id}:${current.revision.slice(-12)}`));
  }
}

async function insertMembers(port: SeedPort, id: string, collection: string, wanted: string[]) {
  let page = await collectionPage(port, collection);
  const missing = wanted.filter(target => !page.targets.has(target));
  let head = page.revision;
  for (let offset = 0; offset < missing.length; offset += 16) {
    const batch = missing.slice(offset, offset + 16);
    const written = await call<{ revision: string }>(port, 'POST', `/v1/collections/${short(collection)}/changes`, {
      expectedHead: head, actingSubject: port.actingSubject,
      operations: batch.map(target => ({ op: 'insert', role: 'member', parent: page.structure,
        position: 'last', target, selection: { mode: 'follow-context' } })),
    }, seedKey('catalogue-members', `${id}:${head.slice(-12)}:${offset}`));
    head = written.revision;
  }
}

async function mount(port: SeedPort, id: string, zone: string, collection: string) {
  const page = await read<{ revision: string; mounts: { target?: string; state?: string }[] }>(port,
    `/v1/zones/${short(zone)}?limit=100`);
  if (!page.mounts.some(item => item.target === collection && item.state !== 'removed')) {
    await call(port, 'POST', `/v1/zones/${short(zone)}/mounts`, {
      expectedHead: page.revision, target: collection, routeSegment: 'catalogue', disclosure: 'public',
      position: 'last', actingSubject: port.actingSubject,
    }, seedKey('catalogue-mount', id));
  }
}

export async function applyAnimeMangaZones(port: SeedPort, samples = animeMangaSamplePlan()):
  Promise<{ works: CatalogueWorkRecord[]; zones: CatalogueZoneRecord[] }> {
  const actor = port.actingSubject;
  await port.grant('work:create:root', 'work.create');
  await port.grant('space:create:root', 'space.create');
  // Catalogue Works. The grant exempts the pending slot limit; it does not record the acting account as an author.
  await port.grant('catalogue:verify:root', 'catalogue.verify');
  await port.grant('classification:define:global', 'classification.proposition.define');
  await port.grant('semantic:create:root', 'semantic.change');
  await port.grant('context:create:root', 'context.create');
  await port.grant(`statement:speak:${actor}`, 'statement.record');
  await port.grant('classification:decide:global', 'statement.decide');
  const client = factsClient(port);
  const works: CatalogueWorkRecord[] = [];
  let publication: { component: string; revision: string } | undefined;
  for (const sample of samples) {
    const created = await createCatalogueWork(port, { key: seedKey('catalogue-work', sample.key), title: sample.title,
      language: sample.language, semanticType: BOOK });
    await port.grant(`work:edit:${created.work}`, 'work.edit');
    await port.grant(`work:read:${created.work}`, 'work.read');
    await port.grant(`contribution:create:${created.work}`, 'contribution.create');
    await port.grant(`publication:select:${created.mainVersion}`, 'publication.select');
    const text = await publishCatalogueText(port, created, sample.key, sample.language, sample.title);
    const concept = await importSample(client, actor, created, sample);
    if (sample.year !== null) {
      publication ??= cataloguePublicationDate(await read(port,
        `/v1/lexicon/definitions/${DATE_PUBLISHED_DEFINITION_NOTATION}`));
      await recordCataloguePublicationYear(client.post, actor, created.work, sample.year, publication, sample.key);
    }
    works.push({ key: sample.key, zone: sample.zone, work: created.work, mainVersion: created.mainVersion,
      contribution: text.contribution, decision: text.decision, concept, year: sample.year, title: sample.title });
  }
  const zones: CatalogueZoneRecord[] = [];
  for (const spec of [
    { id: 'anime' as const, name: 'Anime' },
    { id: 'manga' as const, name: 'Manga' },
  ]) {
    const zone = zoneIri(spec.id);
    await port.grant(`zone:edit:${zone}`, 'zone.edit');
    await port.grant(`semantic:read:${zone}`, 'semantic.read');
    const space = await createCatalogueSpace(port, { id: spec.id, name: spec.name, language: 'en', routeSegment: spec.id,
      preset: 'editorial', mountSegment: 'catalogue', navigation: [{ label: 'Browse', href: '/browse' }],
      browse: [], announcement: `${spec.name} in the catalogue`, sharedMember: '' }, zone);
    const collection = `https://rezics.com/id/${stableId(`catalogue-collection:${spec.id}`)}`;
    await call(port, 'POST', '/v1/zones', { zone, space: space.space, disclosure: 'public', name: spec.name,
      language: 'en', actingSubject: actor }, seedKey('catalogue-zone', spec.id));
    await port.grant(`collection:edit:${collection}`, 'collection.edit');
    await port.grant(`semantic:read:${collection}`, 'semantic.read');
    await call(port, 'POST', '/v1/collections', { collection, name: spec.name, language: 'en', disclosure: 'public',
      actingSubject: actor }, seedKey('catalogue-collection', spec.id));
    await port.grant(`zone:official:${zone}`, 'zone.official');
    await configure(port, spec.id, zone, space.realm, collection, spec.name);
    await port.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
    for (const work of works.filter(item => item.zone === spec.id)) {
      await call(port, 'POST', '/v1/publication-selections', {
        profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: space.realm },
        work: work.work, mainVersion: work.mainVersion, contribution: work.contribution,
        publicationDecision: work.decision, expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
        actingSubject: actor,
      }, seedKey('catalogue-adoption', `${spec.id}:${work.key}`));
    }
    await insertMembers(port, spec.id, collection, works.filter(item => item.zone === spec.id).map(item => item.work));
    await mount(port, spec.id, zone, collection);
    zones.push({ id: spec.id, space: space.space, realm: space.realm, zone, theme: officialTheme(spec.id) });
  }
  return { works, zones };
}

/** Official catalogue setup exceeds one member's monthly Space allowance.
 * Keep ordinary member quota intact and use explicit operator delegation.
 * Adopt earlier member-created Zones before changing the issuing principal. */
export async function createCatalogueSpace(port: SeedPort, spec: Parameters<typeof createSpace>[1], zone: string) {
  if (!port.spaceRequest) return createSpace(port, spec, zone);
  const retained = await adoptZoneSpace(async path => {
    const result = await port.request('GET', path);
    if (result.status === 404) return null;
    if (result.status !== 200) throw new Error(`Catalogue Space read HTTP ${result.status}`);
    return result.body as Record<string, unknown>;
  }, zone, port.actingSubject);
  return retained ?? createSpace({ ...port, request: port.spaceRequest }, spec, zone);
}

export async function seedAnimeMangaZones(state: SeedState): Promise<void> {
  const session = state.sessions[0];
  if (!session || !state.operatorInput || !state.operatorSession) {
    throw new Error('Anime and manga Zones need the operator session');
  }
  const input: LocalOperatorInput = { ...state.operatorInput, ownerAccountSubject: session.accountId,
    actingSubject: session.actingSubject };
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  try {
    const port: SeedPort = {
      actingSubject: session.actingSubject,
      request: (method, path, body, key) => seedHttp(state, () => session.token, method, path, body, key),
      officialRequest: (method, path, body, key) => seedHttp(state, () => state.operatorSession!.token, method, path, body, key),
      spaceRequest: async (method, path, body, key) => {
        const token = await state.api.token(state.operatorSession!.cookie);
        return seedHttp(state, () => token, method, path, body, key);
      },
      grant: async (scope, action) => {
        if (action === 'space.create') await grantVnSeedAuthority(pool,
          { ...input, ownerAccountSubject: input.accountSubject }, scope, action);
        if (action === 'zone.official') {
          await grantOfficialZoneSeed(input, scope.slice('zone:official:'.length));
          return;
        }
        await grantVnSeedAuthority(pool, input, scope, action);
      },
      refresh: () => refreshSeedTokens(state),
    };
    const created = await applyAnimeMangaZones(port);
    state.catalogueZones = created.zones.map(zone => zone.id);
    console.log(`Anime and manga: ${created.works.length} works in ${created.zones.map(zone => zone.id).join(', ')}`);
  } finally { await pool.end(); }
}
