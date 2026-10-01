import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCatalogueYaml, type CatalogueYaml } from './parse.ts';
import { catalogueWorkBody } from './intake.ts';
import { assertSeedRequest } from '../../../scripts/dev/seed/request-schema.ts';

/** Derivation and relation evidence is one https URL. The SAO rewrite stores the
 * Asahi article; the Kadokawa PDF is the bunko realization's evidence. */
const ASAHI = 'https://book.asahi.com/article/14487968';
const KADOKAWA = 'https://group.kadokawa.co.jp/documents/topics/20140106_soos.pdf';
const PROGRESSIVE = 'https://dengekibunko.jp/product/sao/321508000327.html';
const AGGO = 'https://dengekibunko.jp/novecomi/novel/16817330662085987651/';
const INDEX = 'https://dengekibunko.jp/product/index/312005300000.html';
const RAILGUN = 'https://sevenseasentertainment.com/series/a-certain-scientific-railgun/';
const DIVERGENT: Record<string, string> = {
  D01: 'https://www.animatetimes.com/news/details.php?id=1768438282&p=3',
  D02: 'https://mypage.syosetu.com/mypageblog/view/userid/172188/blogkey/1785642/',
  D03: 'https://mypage.syosetu.com/mypageblog/view/userid/595431/blogkey/2933037/',
  D04: 'https://mypage.syosetu.com/mypageblog/view/userid/170524/blogkey/513110/',
  D05: 'https://mypage.syosetu.com/mypageblog/view/userid/388068/blogkey/2670146/',
  D06: 'https://ncode.syosetu.com/n0611em/204/',
  D07: 'https://dengekionline.com/elem/000/000/902/902669/',
  D08: 'https://ncode.syosetu.com/n5824ct/',
  D09: 'https://ncode.syosetu.com/n9375ea/48/',
  D10: 'https://ncode.syosetu.com/n0447ca/',
};
const BOOK = 'https://schema.org/Book';
const SERIES = 'https://schema.org/TVSeries';
const REQUIRED_LEXICON = ['rewrite', 'reboot', 'sequel', 'spin-off', 'adaptation'];
const CREDIT_LEXICON = { illustrator: 'credit-illustrator', 'concept-supervision': 'credit-concept-supervision' } as const;

export interface PlannedWork { id: string; title: string; semanticType: string }
export interface PlannedPart { series: string; volume: string; label: string; inclusion: 'required' | 'extra' }
export interface PlannedRelation {
  derivative: string; source: string; kind: 'Rewrite' | 'Reboot' | 'SpinOff' | 'Sequel' | 'Adaptation';
  evidence: string; unresolved: boolean;
}
export interface PlannedCredit { work: string; name: string; role: 'author' | 'illustrator' | 'concept-supervision'; evidence: string | null }
export interface PlannedAgent { name: string; kind: 'person' | 'organization' }
export interface PlannedRealization {
  id: string; work: string; language: string; kind: 'original' | 'translation';
  status: 'official' | 'unofficial'; verification: 'verified' | 'unverified';
  evidence: string | null; source: 'main-version' | 'unresolved';
  translators: string[]; publishers: string[];
}
export interface PlannedRelease {
  id: string; work: string; title: string; language: string; publisher: string | null; platform: string | null;
  coverage: string[]; identifiers: { provider: string; value: string }[];
}
export interface PlannedCollection { id: string; name: string; members: string[] }
export interface PlannedStatement { work: string; text: string; continuity: string }
export interface CataloguePlan {
  works: PlannedWork[]; parts: PlannedPart[]; relations: PlannedRelation[];
  credits: PlannedCredit[]; agents: PlannedAgent[]; realizations: PlannedRealization[];
  releases: PlannedRelease[]; collections: PlannedCollection[]; statements: PlannedStatement[];
  concluded: string[];
}
export interface CatalogueResponse { status: number; body: unknown }
export interface CataloguePort {
  actingSubject: string;
  request(method: string, path: string, body?: unknown, key?: string): Promise<CatalogueResponse>;
  grant(scope: string, action: string): Promise<void>;
  /** Creates one Work where the public create route is not the way (it now needs an own-work claim or a reviewed candidate). */
  createWork?(item: PlannedWork): Promise<{ work: string; mainVersion: string; mainRevision: string }>;
}
export interface CatalogueWork { work: string; mainVersion: string; mainRevision: string; title: string }
export interface CatalogueManifest {
  works: Record<string, CatalogueWork>;
  collections: Record<string, { collection: string; structure: string }>;
  compositions: Record<string, { structure: string; labels: string[] }>;
  relations: PlannedRelation[];
  realizations: Record<string, { realization: string; revision: string; work: string }>;
  releases: Record<string, { release: string; revision: string; work: string }>;
  credits: { work: string; name: string; role: string; agent: string }[];
  agents: Record<string, string>;
  pendingCredits: { work: string; name: string; role: string }[];
  pendingStatements: PlannedStatement[];
  createdWrites: number;
}

/** Stable native IRI. The same fixture name always addresses the same resource. */
export function catalogueResourceId(name: string): string {
  const hex = createHash('sha256').update(`catalogue-fixture-v1:${name}`).digest('hex').slice(0, 32);
  return `https://rezics.com/id/${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function cataloguePlan(): CataloguePlan {
  const facts = readYaml('franchises.yaml');
  const synthetic = readYaml('synthetic.yaml');
  const sao = block(facts.SAO, 'SAO');
  const index = block(facts.Index, 'Index');
  const works: PlannedWork[] = [];
  const parts: PlannedPart[] = [];
  const relations: PlannedRelation[] = [];
  const credits: PlannedCredit[] = [];
  const agents: PlannedAgent[] = [];
  const realizations: PlannedRealization[] = [];
  const releases: PlannedRelease[] = [];
  const collections: PlannedCollection[] = [];
  const titles = new Map<string, string>();
  const remember = (work: PlannedWork) => { works.push(work); titles.set(work.id, work.title); };
  const person = (name: string) => addAgent(agents, name, 'person');
  const organization = (name: string) => addAgent(agents, name, 'organization');

  for (const [id, title] of workRows(sao.works, 'SAO.works')) remember({ id, title, semanticType: BOOK });
  for (const [id, title] of workRows(index.works, 'Index.works')) remember({ id, title, semanticType: BOOK });
  const volume = (id: string, title: string) => remember({ id, title, semanticType: BOOK });
  volume('sao.bunko.volume1', `${titles.get('sao.bunko')} 1`);
  parts.push({ series: 'sao.bunko', volume: 'sao.bunko.volume1', label: '1', inclusion: 'required' });

  const originalLabels = [...range(number(index.facts, 'originalPrincipalVolumes', 'Index.originalPrincipalVolumes')),
    ...strings(block(index.facts, 'Index.facts').originalAdditionalBooks, 'originalAdditionalBooks')];
  for (const label of originalLabels) {
    const id = `index.original.${label.replaceAll(' ', '-')}`;
    volume(id, `${titles.get('index.original')} ${label}`);
    parts.push({ series: 'index.original', volume: id, label, inclusion: label.startsWith('SS') ? 'extra' : 'required' });
  }
  const ntLabels = strings(block(index.facts, 'Index.facts').ntLabels, 'ntLabels').flatMap(expandToken);
  for (const label of ntLabels) {
    const id = `index.nt.${label.replaceAll(' ', '-')}`;
    volume(id, `${titles.get('index.nt')} ${label}`);
    parts.push({ series: 'index.nt', volume: id, label, inclusion: 'required' });
  }
  volume('index.gt.1', `${titles.get('index.gt')} 1`);
  parts.push({ series: 'index.gt', volume: 'index.gt.1', label: '1', inclusion: 'required' });

  const anime = strings(index.expand_anime_works, 'expand_anime_works');
  if (anime.includes('Railgun')) {
    remember({ id: 'index.railgun.anime', title: 'Railgun', semanticType: SERIES });
    relations.push({ derivative: 'index.railgun.anime', source: 'index.railgun', kind: 'Adaptation',
      evidence: RAILGUN, unresolved: true });
  }

  for (const row of rows(facts.divergentPairs, 'divergentPairs')) {
    const [id, title, source, derivative] = row;
    if (!id || !title || !source || !derivative || !DIVERGENT[id]) throw new Error(`divergent pair ${id ?? ''} is incomplete`);
    remember({ id: `${id}.${source}`, title, semanticType: BOOK });
    remember({ id: `${id}.${derivative}`, title, semanticType: BOOK });
    relations.push({ derivative: `${id}.${derivative}`, source: `${id}.${source}`, kind: 'Rewrite',
      evidence: DIVERGENT[id], unresolved: false });
  }

  addCredits(credits, person, block(block(sao.facts, 'SAO.facts').creators, 'SAO.creators'), creditEvidence);
  const indexFacts = block(index.facts, 'Index.facts');
  for (const series of ['index.original', 'index.nt', 'index.gt']) {
    for (const credit of namedRoles(indexFacts.novelCreators, 'novelCreators')) {
      person(credit.name);
      credits.push({ work: series, ...credit, evidence: credit.role === 'author' ? null : INDEX });
    }
  }
  const artists = block(indexFacts.mangaArtists, 'mangaArtists');
  for (const [series, name] of Object.entries(artists)) {
    const artist = text(name, `mangaArtists.${series}`);
    person(artist);
    const work = series === 'railgun' ? 'index.railgun' : series === 'accelerator' ? 'index.accelerator' : 'index.astral';
    credits.push({ work, name: artist, role: 'illustrator', evidence: work === 'index.railgun' ? RAILGUN : INDEX });
  }
  for (const row of rows(sao.relations, 'SAO.relations')) relations.push(yamlRelation(row));
  for (const row of rows(index.relations, 'Index.relations')) relations.push(yamlRelation(row));

  const families = rows(sao.release_families, 'release_families');
  const digital = block(synthetic.digitalEntry, 'digitalEntry');
  const digitalFamily = strings(digital.releaseFamily, 'digitalEntry.releaseFamily');
  for (const [work, language, publisher] of families) {
    if (!work || !language || !publisher) throw new Error('release family is incomplete');
    organization(publisher);
    const id = `${work}:${language}`;
    realizations.push({ id, work, language, kind: 'translation', status: 'official', verification: 'verified',
      evidence: KADOKAWA, source: 'main-version', translators: [publisher], publishers: [publisher] });
    const identified = digitalFamily[0] === work && digitalFamily[1] === language && digitalFamily[2] === publisher;
    releases.push({ id, work, title: titles.get(work) ?? '', language, publisher, platform: identified ? text(digital.platform, 'platform') : null,
      coverage: [id], identifiers: identified ? [{ provider: text(digital.provider, 'provider'), value: text(digital.value, 'value') }] : [] });
  }
  for (const part of parts.filter(item => item.series === 'index.original')) {
    const id = `${part.volume}:ja`;
    realizations.push({ id, work: part.volume, language: 'ja', kind: 'original', status: 'official', verification: 'verified',
      evidence: INDEX, source: 'main-version', translators: [], publishers: [] });
  }
  const omnibusWork = parts.find(item => item.series === 'index.original' && item.label === '1')?.volume;
  if (!omnibusWork) throw new Error('Index omnibus has no first volume');
  releases.push({ id: 'index.original:omnibus', work: omnibusWork, title: titles.get('index.original') ?? '',
    language: 'ja', publisher: null, platform: null,
    coverage: parts.filter(item => item.series === 'index.original').map(item => `${item.volume}:ja`), identifiers: [] });

  const books = block(facts.D08_books, 'D08_books');
  const booksWork = text(books.sourceWork, 'D08_books.sourceWork');
  realizations.push({ id: 'D08.books', work: booksWork, language: 'ja', kind: 'original', status: 'official',
    verification: 'verified', evidence: DIVERGENT.D08 ?? null, source: 'main-version', translators: [], publishers: [] });
  releases.push({ id: 'D08.books', work: booksWork, title: titles.get(booksWork) ?? '', language: 'ja',
    publisher: null, platform: null, coverage: ['D08.books'], identifiers: [] });

  const fan = block(synthetic.fanTranslation, 'fanTranslation');
  const translator = text(fan.translator, 'fanTranslation.translator');
  person(translator);
  realizations.push({ id: 'fan', work: text(fan.work, 'fanTranslation.work'), language: text(fan.language, 'fanTranslation.language'),
    kind: 'translation', status: 'unofficial', verification: 'unverified', evidence: null, source: 'unresolved',
    translators: [translator], publishers: [] });

  collections.push({ id: text(sao.collection, 'SAO.collection'), name: 'Sword Art Online',
    members: workRows(sao.works, 'SAO.works').map(([id]) => id) });
  collections.push({ id: text(index.collection, 'Index.collection'), name: 'A Certain Magical Index',
    members: workRows(index.works, 'Index.works').map(([id]) => id) });
  const reading = block(synthetic.readingOrder, 'readingOrder');
  collections.push({ id: text(reading.id, 'readingOrder.id'), name: text(reading.name, 'readingOrder.name'),
    members: strings(reading.labels, 'readingOrder.labels').flatMap(expandToken)
      .map(label => `${text(reading.series, 'readingOrder.series')}.${label.replaceAll(' ', '-')}`) });

  const statements = rows(synthetic.statements, 'statements').map(row => {
    const [work, statement, continuity] = row;
    if (!work || !statement || !continuity) throw new Error('synthetic statement is incomplete');
    return { work, text: statement, continuity };
  });
  return { works, parts, relations, credits, agents, realizations, releases, collections, statements,
    concluded: ['index.original', 'index.nt'] };
}

/** Create the catalogue through Main's public API. A second call with the same port writes nothing new. */
function failCatalogue(response: CatalogueResponse, path: string): never {
  throw new Error(`${path} HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 500)}`);
}

export async function loadCatalogue(port: CataloguePort): Promise<CatalogueManifest> {
  const plan = cataloguePlan();
  const actor = encodeURIComponent(port.actingSubject);
  const manifest: CatalogueManifest = { works: {}, collections: {}, compositions: {}, relations: plan.relations,
    realizations: {}, releases: {}, credits: [], agents: {}, pendingCredits: [], pendingStatements: plan.statements,
    createdWrites: 0 };
  const send = async (method: string, path: string, body?: unknown, idempotency?: string) => {
    if (method !== 'GET') assertSeedRequest(method, path, body);
    let response = await port.request(method, path, body, idempotency);
    for (let attempt = 0; attempt < 8 && (response.status === 202 || response.status === 503); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      response = await port.request(method, path, body, idempotency);
    }
    if (method !== 'GET' && path !== '/v1/catalogue/candidates' && response.status < 300 && !replayed(response.body)) {
      manifest.createdWrites += 1;
    }
    return response;
  };
  const written = async <T>(method: 'POST' | 'PUT', path: string, body: unknown, idempotency: string): Promise<T> => {
    const response = await send(method, path, body, idempotency);
    if (response.status >= 400) failCatalogue(response, path);
    return response.body as T;
  };
  const read = async (path: string) => {
    const response = await send('GET', path);
    if (response.status !== 404 && response.status >= 400) failCatalogue(response, path);
    return response;
  };

  await port.grant('work:create:root', 'work.create');
  // A fixture editor loads more than the contributor's three pending records.
  // This grant exempts throughput; it does not verify the fixture's facts.
  await port.grant('catalogue:verify:root', 'catalogue.verify');
  const definitions = new Map<string, string>();
  const missingCredit = new Set<string>();
  for (const key of [...REQUIRED_LEXICON, ...Object.values(CREDIT_LEXICON)]) {
    const response = await read(`/v1/lexicon/definitions/${key}?actingSubject=${actor}`);
    if (response.status === 404) {
      if (REQUIRED_LEXICON.includes(key)) throw new Error(`catalogue lexicon key ${key} is unavailable`);
      missingCredit.add(key);
      continue;
    }
    const body = response.body as { definition?: string; revision?: string };
    const definition = body.definition;
    const revision = body.revision;
    if (!definition || !revision) failCatalogue(response, `lexicon ${key}`);
    definitions.set(key, revision);
    await port.grant(`semantic:read:${definition}`, 'semantic.read');
  }
  for (const credit of plan.credits) {
    if (credit.role === 'author') continue;
    if (missingCredit.has(CREDIT_LEXICON[credit.role])) {
      manifest.pendingCredits.push({ work: credit.work, name: credit.name, role: credit.role });
    }
  }

  for (const item of plan.works) {
    const key = idempotency(`work:${item.id}`);
    const receipt = port.createWork ? await port.createWork(item)
      : await written<{ work: string; mainVersion: string; mainRevision: string }>('POST', '/v1/works',
        await catalogueWorkBody({ ...port, request: send }, {
          title: item.title, language: 'ja', semanticTypes: [item.semanticType] }, key), key);
    manifest.works[item.id] = { ...receipt, title: item.title };
    await port.grant(`work:read:${receipt.work}`, 'work.read');
    await port.grant(`work:edit:${receipt.work}`, 'work.edit');
  }
  const work = (id: string) => {
    const found = manifest.works[id];
    if (!found) throw new Error(`catalogue work ${id} was not created`);
    return found;
  };

  for (const item of plan.agents) {
    const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let receipt = await written<{ agent?: string; state?: string }>('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: item.kind, displayName: item.name }, idempotency(`agent:${item.kind}:${slug}`));
    if (receipt.state === 'pending') failCatalogue({ status: 202, body: receipt }, `agent ${item.name}`);
    const agentId = receipt.agent;
    if (!agentId) failCatalogue({ status: 500, body: receipt }, `agent ${item.name}`);
    manifest.agents[`${item.kind}:${item.name}`] = agentId;
    await port.grant(`semantic:read:${agentId}`, 'semantic.read');
  }
  const agent = (name: string, kind: PlannedAgent['kind']) => {
    const found = manifest.agents[`${kind}:${name}`];
    if (!found) throw new Error(`catalogue agent ${name} was not created`);
    return found;
  };

  for (const credit of plan.credits.filter(item => item.role === 'author')) {
    const target = work(credit.work);
    const credited = agent(credit.name, 'person');
    const page = await read(`/v1/works/${short(target.work)}/agent-credits?actingSubject=${actor}&limit=20`);
    const items = (page.body as { items?: { role?: string; agent?: string }[] }).items ?? [];
    if (items.some(item => item.role === 'author' && item.agent === credited)) continue;
    const header = await read(`/v1/works/${short(target.work)}?actingSubject=${actor}`);
    const revision = (header.body as { revision?: string }).revision;
    if (!revision) failCatalogue(header, `work ${credit.work}`);
    await written('POST', `/v1/works/${short(target.work)}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: catalogueResourceId(`credit:${credit.work}:author:${credit.name}`),
      agent: credited, role: 'author', expectedWorkHead: revision, actingSubject: port.actingSubject,
    }, idempotency(`credit:${credit.work}:author:${credit.name}`));
    manifest.credits.push({ work: credit.work, name: credit.name, role: 'author', agent: credited });
  }
  for (const credit of plan.credits) {
    if (credit.role === 'author' || missingCredit.has(CREDIT_LEXICON[credit.role])) continue;
    const definition = definitions.get(CREDIT_LEXICON[credit.role]);
    if (!definition || !credit.evidence) throw new Error(`catalogue credit ${credit.role} on ${credit.work} has no definition`);
    const credited = agent(credit.name, 'person');
    // Resource summaries have no Agent type, so a native Agent participant makes
    // GET /v1/resources/{id}/relations answer 409. The key is still that Agent IRI.
    await written('POST', '/v1/relations/changes', {
      profile: 'relation-change-v1', expectedHead: null, definition, evidence: credit.evidence, actingSubject: port.actingSubject,
      participations: [
        { role: 'work', participant: { kind: 'resource', ref: work(credit.work).work } },
        { role: 'contributor', participant: { kind: 'external', provider: 'rezics', namespace: 'agent', key: credited } },
      ] }, idempotency(`credit:${credit.work}:${credit.role}:${credit.name}`));
    manifest.credits.push({ work: credit.work, name: credit.name, role: credit.role, agent: credited });
  }

  for (const collection of plan.collections) {
    const id = catalogueResourceId(collection.id);
    await port.grant(`collection:edit:${id}`, 'collection.edit');
    await port.grant(`semantic:read:${id}`, 'semantic.read');
    let page = await read(`/v1/collections/${short(id)}?actingSubject=${actor}&limit=100`);
    if (page.status === 404) {
      await written('POST', '/v1/collections', { collection: id, name: collection.name, disclosure: 'public',
        actingSubject: port.actingSubject }, idempotency(`collection:${collection.id}`));
      page = await read(`/v1/collections/${short(id)}?actingSubject=${actor}&limit=100`);
      if (page.status === 404) failCatalogue(page, `collection ${collection.id}`);
    }
    const body = page.body as { structure?: string; revision?: string; occurrences?: { target?: string }[] };
    const structure = body.structure;
    const revision = body.revision;
    if (!structure || !revision) failCatalogue(page, `collection ${collection.id}`);
    const present = new Set((body.occurrences ?? []).flatMap(item => item.target ? [item.target] : []));
    let head = revision;
    const missing = collection.members.map(member => work(member).work).filter(member => !present.has(member));
    for (let offset = 0; offset < missing.length; offset += 16) {
      const changed = await written<{ revision: string }>('POST', `/v1/collections/${short(id)}/changes`, {
        expectedHead: head, actingSubject: port.actingSubject,
        operations: missing.slice(offset, offset + 16).map(target => ({ op: 'insert', role: 'member',
          parent: structure, position: 'last', target, selection: { mode: 'follow-context' } })) },
      idempotency(`collection:${collection.id}:members:${offset}`));
      head = changed.revision;
    }
    manifest.collections[collection.id] = { collection: id, structure };
  }

  for (const series of [...new Set(plan.parts.map(item => item.series))]) {
    const owner = work(series);
    const seriesParts = plan.parts.filter(item => item.series === series);
    let page = await read(`/v1/resources/${short(owner.work)}/parts?actingSubject=${actor}&limit=100`);
    if (page.status === 404) {
      const created = await written<{ structure: string; revision: string }>('POST', '/v1/compositions', {
        profile: 'work-composition', work: owner.work, mainVersion: owner.mainVersion, actingSubject: port.actingSubject,
      }, idempotency(`composition:${series}`));
      page = await read(`/v1/resources/${short(owner.work)}/parts?actingSubject=${actor}&limit=100`);
      if (page.status === 404) {
        page = { status: 200, body: { structure: created.structure, revision: created.revision, parts: [], completion: { status: 'unknown' } } };
      }
    }
    const body = page.body as { structure?: string; revision?: string; parts?: { displayLabel?: string }[];
      completion?: { status?: string } };
    const structure = body.structure;
    const revision = body.revision;
    if (!structure || !revision) failCatalogue(page, `composition ${series}`);
    const labels = new Set((body.parts ?? []).flatMap(item => item.displayLabel ? [item.displayLabel] : []));
    let head = revision;
    const missing = seriesParts.filter(item => !labels.has(item.label));
    for (let offset = 0; offset < missing.length; offset += 16) {
      const changed = await written<{ revision: string }>('POST', `/v1/compositions/${short(structure)}/changes`, {
        profile: 'work-composition', actingSubject: port.actingSubject, expectedHead: head,
        operations: missing.slice(offset, offset + 16).map(item => ({ op: 'insert', role: 'part', parent: structure,
          position: 'last', target: work(item.volume).work, displayLabel: item.label, inclusion: item.inclusion })) },
      idempotency(`composition:${series}:parts:${offset}`));
      head = changed.revision;
    }
    if (plan.concluded.includes(series) && body.completion?.status !== 'concluded') {
      await written('POST', `/v1/compositions/${short(structure)}/changes`, {
        profile: 'work-composition', actingSubject: port.actingSubject, expectedHead: head,
        operations: [{ op: 'completion', completion: { status: 'concluded', evidence: [INDEX] } }] },
      idempotency(`composition:${series}:concluded`));
    }
    manifest.compositions[series] = { structure, labels: seriesParts.map(item => item.label) };
  }

  for (const relation of plan.relations) {
    const derivative = work(relation.derivative);
    const source = work(relation.source);
    if (relation.kind === 'Rewrite' || relation.kind === 'Reboot' || relation.kind === 'Adaptation') {
      const kind = relation.kind === 'Rewrite' ? 'rewrite' : relation.kind === 'Reboot' ? 'reboot' : 'adaptation';
      await written('POST', `/v1/resources/${short(derivative.work)}/derivations`, {
        profile: 'work-derivation-v2', targetMainVersion: derivative.mainVersion, expectedTargetHead: derivative.mainRevision,
        sourceWork: source.work, sourceMainVersion: relation.unresolved ? null : source.mainVersion,
        sourceMainRevision: relation.unresolved ? null : source.mainRevision, kind, evidence: relation.evidence,
        actingSubject: port.actingSubject }, idempotency(`relation:${relation.derivative}:${kind}:${relation.source}`));
    } else {
      const binding = relation.kind === 'Sequel'
        ? { key: 'sequel', sourceRole: 'predecessor', subjectRole: 'sequel' }
        : { key: 'spin-off', sourceRole: 'source', subjectRole: 'spin-off' };
      const definition = definitions.get(binding.key);
      if (!definition) throw new Error(`catalogue lexicon key ${binding.key} is unavailable`);
      await written('POST', '/v1/relations/changes', {
        profile: 'relation-change-v1', expectedHead: null, definition, evidence: relation.evidence, actingSubject: port.actingSubject,
        participations: [
          { role: binding.sourceRole, participant: { kind: 'resource', ref: source.work } },
          { role: binding.subjectRole, participant: { kind: 'resource', ref: derivative.work } },
        ] }, idempotency(`relation:${relation.derivative}:${binding.key}:${relation.source}`));
    }
  }

  for (const item of plan.realizations) {
    const target = work(item.work);
    const id = catalogueResourceId(`realization:${item.id}`);
    const source = item.source === 'unresolved' ? { kind: 'unresolved' as const, work: target.work }
      : { kind: 'main-version' as const, work: target.work, mainVersion: target.mainVersion, revision: target.mainRevision };
    const receipt = await written<{ realization: string; revision: string }>('PUT',
      `/v1/works/${short(target.work)}/realizations/${short(id)}`, {
        profile: 'realization-v1', id, expectedHead: null, actingSubject: port.actingSubject, language: item.language,
        kind: item.kind, translators: item.translators.map(name => agent(name, name === 'Catalogue Fixture Fan Translator' ? 'person' : publisherKind(plan, name))),
        publishers: item.publishers.map(name => agent(name, 'organization')), source, status: item.status,
        verification: item.verification, evidence: item.evidence }, idempotency(`realization:${item.id}`));
    manifest.realizations[item.id] = { realization: receipt.realization, revision: receipt.revision, work: target.work };
  }
  for (const item of plan.releases) {
    const target = work(item.work);
    const id = catalogueResourceId(`release:${item.id}`);
    const coverage = item.coverage.map(key => {
      const realization = manifest.realizations[key];
      if (!realization) throw new Error(`release ${item.id} covers missing realization ${key}`);
      return { realization: realization.realization, revision: realization.revision, completeness: 'complete' as const };
    });
    const receipt = await written<{ release: string; revision: string }>('PUT',
      `/v1/works/${short(target.work)}/releases/${short(id)}`, {
        profile: 'release-v2', id, expectedHead: null, actingSubject: port.actingSubject, kind: 'formal', status: 'official',
        titleLanguage: item.language, tracklistLanguage: null, title: { value: item.title, language: item.language },
        editionStatement: null, publisher: item.publisher, publicationYear: null, isbn13: null, originalUrl: null,
        fixedRelease: null, identifiers: item.identifiers, platform: item.platform, territory: null, coverage, evidence: null,
      }, idempotency(`release:${item.id}`));
    manifest.releases[item.id] = { release: receipt.release, revision: receipt.revision, work: target.work };
  }
  return manifest;
}

function publisherKind(plan: CataloguePlan, name: string): PlannedAgent['kind'] {
  return plan.agents.find(item => item.name === name)?.kind ?? 'organization';
}

function readYaml(name: string): { [key: string]: CatalogueYaml } {
  return parseCatalogueYaml(readFileSync(join(import.meta.dir, name), 'utf8'));
}

function block(value: CatalogueYaml | undefined, label: string): { [key: string]: CatalogueYaml } {
  if (!value || typeof value === 'string' || Array.isArray(value)) throw new Error(`${label} must be a map`);
  return value;
}

function text(value: CatalogueYaml | undefined, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be text`);
  return value;
}

function strings(value: CatalogueYaml | undefined, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function rows(value: CatalogueYaml | undefined, label: string): string[][] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item, index) => strings(item, `${label}[${index}]`));
}

function workRows(value: CatalogueYaml | undefined, label: string): [string, string][] {
  return rows(value, label).map(row => {
    const [id, title] = row;
    if (!id || !title) throw new Error(`${label} work is incomplete`);
    return [id, title];
  });
}

function number(facts: CatalogueYaml | undefined, key: string, label: string): number {
  const value = Number(text(block(facts, label)[key], label));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} is not a count`);
  return value;
}

function range(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(index + 1));
}

function expandToken(token: string): string[] {
  const matched = /^(?:.*\.)?(\d+)\.\.(\d+)$/.exec(token);
  if (!matched) return [token];
  const start = Number(matched[1]);
  const end = Number(matched[2]);
  return Array.from({ length: end - start + 1 }, (_, index) => String(start + index));
}

function namedRoles(value: CatalogueYaml | undefined, label: string): { name: string; role: PlannedCredit['role'] }[] {
  return strings(value, label).map(item => {
    const split = item.lastIndexOf(':');
    const name = item.slice(0, split).trim();
    const role = item.slice(split + 1).trim();
    if (!name || (role !== 'author' && role !== 'illustrator' && role !== 'concept-supervision')) {
      throw new Error(`${label} credit ${item} is not an admitted role`);
    }
    return { name, role };
  });
}

function addCredits(credits: PlannedCredit[], person: (name: string) => void,
  creators: { [key: string]: CatalogueYaml }, evidence: (work: string, role: PlannedCredit['role']) => string | null) {
  for (const [work, value] of Object.entries(creators)) {
    for (const credit of namedRoles(value, work)) {
      person(credit.name);
      credits.push({ work, ...credit, evidence: evidence(work, credit.role) });
    }
  }
}

function creditEvidence(work: string, role: PlannedCredit['role']): string | null {
  if (role === 'author') return null;
  if (work === 'sao.bunko') return KADOKAWA;
  if (work === 'sao.aggo') return AGGO;
  return null;
}

function yamlRelation(row: string[]): PlannedRelation {
  const [derivative, kind, source, token] = row;
  if (!derivative || !source || !token) throw new Error('catalogue relation is incomplete');
  if (kind !== 'Rewrite' && kind !== 'Reboot' && kind !== 'SpinOff' && kind !== 'Sequel') {
    throw new Error(`catalogue relation ${kind ?? ''} is not admitted`);
  }
  const evidence = derivative === 'sao.bunko' ? ASAHI
    : derivative === 'sao.progressive' ? PROGRESSIVE
      : derivative === 'sao.aggo' ? AGGO
        : derivative === 'index.railgun' || derivative === 'index.astral' ? RAILGUN
          : INDEX;
  return { derivative, source, kind, evidence, unresolved: false };
}

function addAgent(agents: PlannedAgent[], name: string, kind: PlannedAgent['kind']) {
  if (!agents.some(item => item.name === name && item.kind === kind)) agents.push({ name, kind });
}

function idempotency(suffix: string): string {
  const value = `catalogue:v1:${suffix.toLowerCase().replace(/[^a-z0-9:_./-]+/g, '-').replace(/^-|-$/g, '')}`;
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(value)) throw new Error(`catalogue idempotency key is invalid: ${value}`);
  return value;
}

function short(resource: string): string { return resource.slice(-36); }

function replayed(body: unknown): boolean {
  return !!body && typeof body === 'object' && 'replayed' in body && (body as { replayed?: boolean }).replayed === true;
}
