import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { grantFixtureAuthority, rethrowFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { loadVndbSlice, metadataTag, recordedTag, seededReleasePlan, ODBL, DBCL,
  type PlannedRelease, type VndbSlice } from '../../../tests/fixtures/vndb/load.ts';
import { SeedApiError } from './api.ts';
import { acceptClassifiedStatement, discloseClassificationConcept, expectedScopeDecisionHead, shareClassificationContext,
  type ClassificationResolution, type SharedClassificationContext } from './classified-statement.ts';
import { grantImportedContributionSeedAuthority, type LocalOperatorInput } from './operator.ts';
import { seedKey } from './plan.ts';
import { refreshSeedTokens, stableId, type SeedState, type WorkReceipt } from './state.ts';

export interface HttpResult { status: number; body: unknown }
export interface SeedPort {
  actingSubject: string;
  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, key?: string): Promise<HttpResult>;
  grant(scope: string, action: string): Promise<void>;
  officialRequest?: SeedPort['request'];
  refresh?: () => Promise<void>;
}
export interface VnWorkRecord { vndb: string; iri: string; mainVersion: string;
  workRevision: string; mainRevision: string; metadataRevision: string | null }
export interface VnCatalogueManifest {
  concept: string;
  sense: string;
  offering: { id: string; revision: string; instrument: string };
  assessment: { id: string; obligations: { kind: string; instrument: string }[] };
  works: VnWorkRecord[];
  releases: { vndb: string; iri: string; revision: string }[];
}
const VIDEO_GAME = 'https://schema.org/VideoGame';
const CATALOGUE_RECORD = 'Catalogue record.';

const short = (iri: string) => iri.slice(-36);
const resource = (kind: string, id: string) => `https://rezics.com/id/${stableId(`vndb-${kind}:${id}`)}`;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function vndbReleaseIri(id: string): string {
  return resource('release', id);
}

/** Loopback fixture grants for the visual-novel seed. The Works themselves are created through Main. */
export async function grantVnSeedAuthority(pool: Pool, input: LocalOperatorInput, scope: string, action: string) {
  const url = new URL(input.accessDatabaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Visual novel seed grants require a loopback database');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new Error('Access recovery fence is closed');
    const owner = await principal(client, `${input.endpoints.account}/api/auth`, input.ownerAccountSubject);
    await client.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')
      ON CONFLICT (id) DO NOTHING`, [input.actingSubject]);
    try {
      await grantFixtureAuthority(client, {
        scope, requireDispatch: false,
        representations: [{ principalId: owner, actor: input.actingSubject, action, lifetime: '8 hours' }],
        grant: { actor: input.actingSubject, action, lifetime: '8 hours' },
      });
    } catch (error) {
      rethrowFixtureAuthority(error, { gate: `Visual novel seed grant gate is closed: ${scope}` });
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the first error */ }
    throw error;
  } finally { client.release(); }
}

async function principal(client: PoolClient, issuer: string, accountSubject: string) {
  const existing = await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`, [issuer, accountSubject]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = randomUUID();
  await client.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [id, issuer, accountSubject]);
  return id;
}

export async function seedVnCatalogue(state: SeedState): Promise<void> {
  const session = state.sessions[0];
  if (!session || !state.operatorInput) {
    throw new Error('Visual novel catalogue seed needs the operator database and a seed session');
  }
  const input: LocalOperatorInput = { ...state.operatorInput, ownerAccountSubject: session.accountId,
    actingSubject: session.actingSubject };
  const pool = new Pool({ connectionString: input.accessDatabaseUrl });
  try {
    const manifest = await applyVnCatalogue({
      actingSubject: session.actingSubject,
      request: (method, path, body, key) => seedHttp(state, () => session.token, method, path, body, key),
      grant: (scope, action) => grantVnSeedAuthority(pool, input, scope, action),
      refresh: () => refreshSeedTokens(state),
    });
    for (const work of manifest.works) {
      state.created.set(`vndb:${work.vndb}`, { work: work.iri, mainVersion: work.mainVersion,
        workRevision: work.workRevision, mainRevision: work.mainRevision, replayed: false });
    }
    console.log(`Visual novels: ${manifest.works.length} works, ${manifest.releases.length} releases`);
  } finally { await pool.end(); }
}

export async function seedHttp(state: SeedState, token: () => string, method: string, path: string,
  body?: unknown, key?: string): Promise<HttpResult> {
  try {
    if (method === 'GET') return { status: 200, body: await state.api.get(path, token()) };
    const written = method === 'PUT'
      ? await state.api.put(path, body, token(), key ?? seedKey('vndb-write', 'request'))
      : await state.api.post(path, body, token(), key ?? seedKey('vndb-write', 'request'));
    return { status: 200, body: written };
  } catch (error) {
    if (!(error instanceof SeedApiError)) throw error;
    let parsed: unknown = error.detail;
    try { parsed = JSON.parse(error.detail) as unknown; } catch { /* text body */ }
    return { status: error.status, body: parsed };
  }
}

export async function applyVnCatalogue(port: SeedPort): Promise<VnCatalogueManifest> {
  const slice = loadVndbSlice();
  const plan = seededReleasePlan(slice);
  const actor = port.actingSubject;
  await port.grant('work:create:root', 'work.create');
  await port.grant('classification:define:global', 'classification.proposition.define');
  await port.grant('classification:decide:global', 'statement.decide');
  await port.grant('context:create:root', 'context.create');
  await port.grant(`statement:speak:${actor}`, 'statement.record');
  const concept = await call<{ concept: string; sense: string; definitionRevision: string }>(port, 'POST',
    '/v1/classification-propositions', { profile: 'classification-proposition-v1', label: 'visual novel',
      actingSubject: actor }, seedKey('vndb-concept', 'visual-novel'));
  const post = <T>(path: string, body: unknown, _token: string, key: string) => call<T>(port, 'POST', path, body, key);
  const interpretation = await shareClassificationContext(post, '', actor,
    [{ concept: concept.concept, definitionRevision: concept.definitionRevision }],
    seedKey('vndb-classification-context', 'visual-novel'));
  await discloseClassificationConcept(post, '', actor, concept.concept, seedKey('vndb-concept-hint', 'visual-novel'));
  const producers = await provisionProducers(port, slice, plan.releases);
  const names = producerNames(slice);
  const made: VnWorkRecord[] = [];
  for (const [index, vn] of slice.tables.vn.entries()) {
    if (index % 10 === 0) await port.refresh?.();
    made.push(await seedVisualNovel(port, slice, vn, plan.releases.filter(release => release.vn === vn.id),
      producers, names, concept, interpretation));
  }
  const releases: VnCatalogueManifest['releases'] = plan.releases.map(release => ({
    vndb: release.id, iri: vndbReleaseIri(release.id), revision: '',
  }));
  for (const release of releases) {
    const work = made.find(item => plan.releases.find(row => row.id === release.vndb)?.vn === item.vndb);
    if (!work) throw new Error(`VNDB release ${release.vndb} has no Work`);
    const view = await read<{ revision: string }>(port,
      `/v1/works/${short(work.iri)}/releases/${short(release.iri)}`);
    release.revision = view.revision;
  }
  const showcase = made.find(work => work.vndb === slice.provenance.showcase.vn);
  if (!showcase) throw new Error('VNDB showcase visual novel was not seeded');
  const rights = await recordRights(port, showcase.iri);
  const finished = [];
  for (const work of made) {
    const header = await read<{ revision: string; metadataRevision: string | null }>(port,
      `/v1/works/${short(work.iri)}`);
    finished.push({ ...work, workRevision: header.revision,
      metadataRevision: header.metadataRevision ?? work.metadataRevision });
  }
  finished.sort((left, right) => left.vndb.localeCompare(right.vndb));
  releases.sort((left, right) => left.vndb.localeCompare(right.vndb));
  return { concept: concept.concept, sense: concept.sense, ...rights, works: finished, releases };
}

async function seedVisualNovel(port: SeedPort, slice: VndbSlice, vn: VndbSlice['tables']['vn'][number],
  releases: PlannedRelease[], producers: Map<string, string>, names: Map<string, string>,
  concept: { concept: string; sense: string }, interpretation: SharedClassificationContext): Promise<VnWorkRecord> {
  if (vn.olang !== 'en' && vn.olang !== 'ja') throw new Error(`VNDB ${vn.id} language ${vn.olang} is not en or ja`);
  const title = workTitle(slice, vn);
  const created = await createOwnWork(port, { key: seedKey('vndb-work', vn.id), title: title.value,
    language: vn.olang, semanticType: VIDEO_GAME });
  await port.grant(`work:edit:${created.work}`, 'work.edit');
  await port.grant(`work:read:${created.work}`, 'work.read');
  await port.grant(`contribution:create:${created.work}`, 'contribution.create');
  await port.grant(`publication:select:${created.mainVersion}`, 'publication.select');
  const metadataRevision = await ensureHeader(port, created.work, seedKey('vndb-metadata', vn.id), {
    originalTitle: { value: title.value, language: metadataTag(title.language) },
    completionStatus: null, localized: localizedTitles(slice, vn),
  });
  await publishCatalogueText(port, created, seedKey('vndb-text', vn.id), metadataTag(vn.olang), CATALOGUE_RECORD);
  const groups = realizationGroups(vn.id, recordedTag(vn.olang), releases);
  const revisions = new Map<string, { iri: string; revision: string }>();
  for (const group of groups.values()) {
    const saved = await putRealization(port, created.work, vn.id, group, producers);
    revisions.set(group.key, saved);
  }
  for (const release of releases) {
    await putRelease(port, created.work, vn.id, recordedTag(vn.olang), release, names, revisions);
  }
  await creditProducers(port, created.work, vn.id, recordedTag(vn.olang), releases, producers);
  await classifyVnWork(port, created, concept, interpretation, vn.id);
  return { vndb: vn.id, iri: created.work, mainVersion: created.mainVersion,
    workRevision: created.workRevision, mainRevision: created.mainRevision, metadataRevision };
}

function workTitle(slice: VndbSlice, vn: VndbSlice['tables']['vn'][number]): { value: string; language: string } {
  const titles = slice.tables.vn_titles.filter(row => row.id === vn.id && row.title);
  const chosen = titles.find(row => row.official && row.lang === vn.olang)
    ?? titles.find(row => row.lang === vn.olang) ?? titles.find(row => row.lang === 'en') ?? titles[0];
  if (!chosen?.title || chosen.title.length > 200) throw new Error(`VNDB ${vn.id} has no usable title`);
  return { value: chosen.title, language: chosen.lang };
}

function localizedTitles(slice: VndbSlice, vn: VndbSlice['tables']['vn'][number]) {
  const titles = slice.tables.vn_titles.filter(row => row.id === vn.id && row.title);
  const rank = (row: typeof titles[number]) => {
    const language = metadataTag(row.lang);
    if (row.official && language === metadataTag(vn.olang)) return 0;
    if (row.official) return 1;
    if (language === metadataTag(vn.olang)) return 2;
    if (language === 'en') return 3;
    return 4;
  };
  const seen = new Set<string>();
  const localized = [];
  for (const row of [...titles].sort((left, right) => rank(left) - rank(right) || left.lang.localeCompare(right.lang))) {
    const language = metadataTag(row.lang);
    if (seen.has(language)) continue;
    seen.add(language);
    localized.push({ language, title: row.title, description: null, mainVersionLabel: null });
    if (localized.length === 20) break;
  }
  if (!localized.length) throw new Error(`VNDB ${vn.id} has no localized title`);
  return localized;
}

interface RealizationGroup { key: string; language: string; official: boolean;
  translatorPids: string[]; developerPids: Set<string>; publisherPids: Set<string> }

function groupKey(release: PlannedRelease, language: string, olang: string): string {
  const pids = [...new Set([...release.developers, ...release.publishers])].sort();
  const translators = language === olang ? [] : pids.length ? pids : ['unlisted'];
  return `${release.vn}|${language}|${release.official ? 'official' : 'unofficial'}|${translators.join(',')}`;
}

function realizationGroups(vn: string, olang: string, releases: readonly PlannedRelease[]) {
  const groups = new Map<string, RealizationGroup>();
  for (const release of releases) {
    if (release.vn !== vn) continue;
    for (const entry of release.coverage) {
      const key = groupKey(release, entry.language, olang);
      const existing = groups.get(key);
      const group = existing ?? { key, language: entry.language, official: release.official,
        translatorPids: key.split('|')[3] ? key.split('|')[3]!.split(',') : [],
        developerPids: new Set<string>(), publisherPids: new Set<string>() };
      for (const pid of release.developers) group.developerPids.add(pid);
      for (const pid of release.publishers) group.publisherPids.add(pid);
      groups.set(key, group);
    }
  }
  return groups;
}

async function provisionProducers(port: SeedPort, slice: VndbSlice, releases: readonly PlannedRelease[]) {
  const needed = new Set<string>();
  for (const release of releases) {
    for (const pid of [...release.developers, ...release.publishers]) needed.add(pid);
  }
  const olang = new Map(slice.tables.vn.map(row => [row.id, recordedTag(row.olang)]));
  for (const release of releases) {
    for (const entry of release.coverage) {
      if (entry.language !== olang.get(release.vn) && !release.developers.length && !release.publishers.length) {
        needed.add('unlisted');
      }
    }
  }
  const agents = new Map<string, string>();
  const producers = new Map(slice.tables.producers.map(row => [row.id, row]));
  for (const pid of [...needed].sort()) {
    const producer = producers.get(pid);
    const displayName = (producer?.name || producer?.latin || (pid === 'unlisted' ? 'Unlisted translator' : pid)).trim();
    if (!displayName || displayName.length > 200) throw new Error(`VNDB producer ${pid} name cannot be an Agent`);
    const kind = producer?.type === 'in' ? 'person' : 'organization';
    const agent = await call<{ agent: string; state: string }>(port, 'POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind, displayName }, seedKey('vndb-agent', pid));
    if (agent.state !== 'active') throw new Error(`VNDB producer ${pid} did not become an active Agent`);
    agents.set(pid, agent.agent);
  }
  return agents;
}

function producerNames(slice: VndbSlice): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of slice.tables.producers) {
    const name = (row.name || row.latin || row.id).trim();
    if (!name || name.length > 300) throw new Error(`VNDB producer ${row.id} name cannot be a release publisher`);
    names.set(row.id, name);
  }
  names.set('unlisted', 'Unlisted translator');
  return names;
}

async function putRealization(port: SeedPort, work: string, vn: string, group: RealizationGroup,
  producers: Map<string, string>) {
  const original = group.translatorPids.length === 0;
  const publisherPids = original ? [...group.developerPids]
    : group.publisherPids.size ? [...group.publisherPids]
      : group.developerPids.size ? [...group.developerPids] : ['unlisted'];
  const translatorPids = original ? [] : group.translatorPids;
  const iri = resource('realization', group.key);
  const saved = await call<{ revision: string }>(port, 'PUT',
    `/v1/works/${short(work)}/realizations/${short(iri)}`, {
      profile: 'realization-v1', expectedHead: null, actingSubject: port.actingSubject, id: iri,
      language: group.language, kind: original ? 'original' : 'translation',
      translators: translatorPids.map(pid => agentOf(producers, pid)).sort(),
      publishers: publisherPids.map(pid => agentOf(producers, pid)).sort(),
      source: { kind: 'unresolved', work }, status: group.official ? 'official' : 'unofficial',
      verification: 'verified', evidence: `https://vndb.org/${vn}`,
    }, seedKey('vndb-realization', stableId(group.key)));
  return { iri, revision: saved.revision };
}

async function putRelease(port: SeedPort, work: string, vn: string, olang: string, release: PlannedRelease,
  names: Map<string, string>, realizations: Map<string, { iri: string; revision: string }>) {
  const coverage = release.coverage.map(entry => {
    const realized = realizations.get(groupKey(release, entry.language, olang));
    if (!realized) throw new Error(`VNDB release ${release.id} is missing a realization for ${entry.language}`);
    return { realization: realized.iri, revision: realized.revision, completeness: entry.completeness };
  });
  const publisherPid = release.publishers[0] ?? release.developers[0];
  const publisherName = publisherPid ? names.get(publisherPid) ?? null : null;
  if (publisherPid && !publisherName) throw new Error(`VNDB producer ${publisherPid} has no name`);
  const iri = vndbReleaseIri(release.id);
  await call(port, 'PUT', `/v1/works/${short(work)}/releases/${short(iri)}`, {
    profile: 'release-v2', expectedHead: null, actingSubject: port.actingSubject, id: iri,
    kind: 'formal', status: release.official ? 'official' : 'unofficial',
    title: release.title, titleLanguage: release.title.language, tracklistLanguage: null,
    editionStatement: null, publisher: publisherName, publicationYear: release.publicationYear,
    isbn13: null, originalUrl: null, fixedRelease: null, evidence: null,
    identifiers: [
      { provider: 'https://vndb.org/vn', value: vn },
      { provider: 'https://vndb.org/release', value: release.id },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    platform: release.platform, territory: null, coverage,
  }, seedKey('vndb-release', release.id));
}

function agentOf(producers: Map<string, string>, pid: string): string {
  const agent = producers.get(pid);
  if (!agent) throw new Error(`VNDB producer ${pid} has no Agent`);
  return agent;
}

async function creditProducers(port: SeedPort, work: string, vn: string, olang: string,
  releases: readonly PlannedRelease[], producers: Map<string, string>) {
  const authors = new Set<string>();
  const translators = new Set<string>();
  for (const release of releases) {
    for (const pid of release.developers) authors.add(pid);
    const translates = !release.official || release.coverage.some(entry => entry.language !== olang);
    if (translates) for (const pid of [...release.publishers, ...release.developers]) translators.add(pid);
  }
  const wanted: { pid: string; role: 'author' | 'translator' }[] = [
    ...[...authors].sort().map(pid => ({ pid, role: 'author' as const })),
    ...[...translators].sort().filter(pid => producers.has(pid)).map(pid => ({ pid, role: 'translator' as const })),
  ];
  const listed = await listedCredits(port, work);
  let head = (await read<{ revision: string }>(port, `/v1/works/${short(work)}`)).revision;
  for (const credit of wanted) {
    const agent = agentOf(producers, credit.pid);
    if (agent === port.actingSubject) continue;
    if (listed.some(item => item.agent === agent && item.role === credit.role)) continue;
    await call(port, 'POST', `/v1/works/${short(work)}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: resource('credit', `${vn}:${credit.role}:${credit.pid}`),
      agent, role: credit.role, expectedWorkHead: head, actingSubject: port.actingSubject,
    }, seedKey('vndb-credit', `${vn}:${credit.role}:${credit.pid}:${head.slice(-12)}`));
    head = (await read<{ revision: string }>(port, `/v1/works/${short(work)}`)).revision;
    listed.push({ agent, role: credit.role });
  }
}

async function listedCredits(port: SeedPort, work: string) {
  const items: { agent: string; role: string }[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: { agent: string; role: string }[]; nextCursor: string | null } = await read(port,
      `/v1/works/${short(work)}/agent-credits?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export async function classifyVnWork(port: SeedPort, work: { work: string; mainVersion: string },
  concept: { concept: string; sense: string }, interpretation: SharedClassificationContext, vn: string) {
  const scope = { kind: 'global' as const };
  const current = await call<ClassificationResolution>(port, 'POST', '/v1/classification-resolutions', {
    profile: 'classification-resolution-v1', context: scope, work: work.work,
    mainVersion: work.mainVersion, sense: concept.sense }, seedKey('vndb-class-resolution', vn));
  const decisionHead = expectedScopeDecisionHead(current, scope);
  const head = decisionHead ? decisionHead.slice(-12) : 'first';
  await acceptClassifiedStatement(
    (path, body, _token, key) => call(port, 'POST', path, body, key), '', port.actingSubject, work, concept.concept,
    interpretation, scope, current, { statement: seedKey('vndb-class-statement', vn),
      decision: seedKey('vndb-class-decision', `${vn}:${head}`) });
}

async function recordRights(port: SeedPort, work: string) {
  await port.grant(`rights:offer:${work}`, 'rights.offer-create');
  await port.grant('rights:assess', 'rights.assess');
  const offeringKey = seedKey('vndb-offering', 'odbl');
  const offering = await call<{ offering: string; revision: string }>(port, 'POST', '/v1/rights/offerings', {
    profile: 'rights-offering-create-v1', target: work, instrument: ODBL,
    actingSubject: port.actingSubject, idempotencyKey: offeringKey,
  }, offeringKey);
  const assessmentKey = seedKey('vndb-assessment', 'odbl');
  const notice = 'Visual novel records from the VNDB dump. Attribute VNDB contributors.';
  const obligations = [
    { kind: 'attribution', instrument: ODBL, appliesTo: 'redistribution', notice },
    { kind: 'share_alike', instrument: ODBL, appliesTo: 'redistribution',
      notice: 'Share an adaptation of this database under the ODbL.' },
    { kind: 'attribution', instrument: DBCL, appliesTo: 'redistribution',
      notice: 'Attribute the database contents under the DbCL.' },
  ];
  const assessment = await call<{ assessmentId: string; obligations: { kind: string; instrument: string }[] }>(port,
    'POST', '/v1/rights/use-assessments', {
      profile: 'rights-use-assessment-v1', actingSubject: port.actingSubject,
      material: { scopeKind: 'work', workId: work, provider: null, namespace: null, sourceRecordId: null,
        contentVariantId: null, mediaAsset: null, component: 'record' },
      expressionKind: 'compilation', family: 'data_rights', useKind: 'redistribution',
      useScope: 'rezics:vndb-dump', basis: 'license', outcome: 'conditional', licenseInstrument: ODBL,
      exceptionKind: null, rationale: null, extent: {}, evidence: { archive: 'vndb-db-2026-09-30' },
      obligations, expectedAssessment: null, idempotencyKey: assessmentKey,
    }, assessmentKey);
  return {
    offering: { id: offering.offering, revision: offering.revision, instrument: ODBL },
    assessment: { id: assessment.assessmentId, obligations: assessment.obligations.map(item => ({
      kind: item.kind, instrument: item.instrument })) },
  };
}

export async function createOwnWork(port: SeedPort, input: { key: string; title: string; language: string;
  semanticType: string }): Promise<WorkReceipt> {
  return call<WorkReceipt>(port, 'POST', '/v1/works', {
    profile: 'metadata-only-v1', title: input.title, language: input.language,
    semanticTypes: [input.semanticType], actingSubject: port.actingSubject, authoring: 'own-work',
  }, input.key);
}

export async function ensureHeader(port: SeedPort, work: string, key: string, desired: {
  originalTitle: { value: string; language: string } | null;
  completionStatus: 'ongoing' | 'completed' | 'hiatus' | null;
  localized: { language: string; title: string | null; description: null; mainVersionLabel: null }[];
}): Promise<string | null> {
  const path = `/v1/works/${short(work)}/metadata`;
  const loaded = await port.request('GET', `${path}?actingSubject=${encodeURIComponent(port.actingSubject)}`);
  const current = loaded.status === 404
    ? { revision: null, originalTitle: null, completionStatus: null, localized: [] as {
      language: string; title: string | null; description: string | null }[] }
    : loaded.status === 200 ? loaded.body as { revision: string | null;
      originalTitle: { value: string; language: string } | null;
      completionStatus: 'ongoing' | 'completed' | 'hiatus' | null;
      localized: { language: string; title: string | null; description: string | null }[] }
      : unexpected(loaded, `GET ${path}`);
  if (sameHeader(current, desired)) return current.revision;
  const written = await call<{ revision: string }>(port, 'PUT', path, {
    profile: 'work-metadata-details-v1', expectedHead: current.revision,
    state: { kind: 'header', originalTitle: desired.originalTitle, completionStatus: desired.completionStatus,
      localized: desired.localized },
    actingSubject: port.actingSubject,
  }, `${key}:${current.revision?.slice(-12) ?? 'first'}`);
  return written.revision;
}

function sameHeader(current: { originalTitle: { value: string; language: string } | null;
  completionStatus: string | null; localized: { language: string; title: string | null; description: string | null }[] },
  desired: { originalTitle: { value: string; language: string } | null; completionStatus: string | null;
    localized: { language: string; title: string | null; description: null }[] }) {
  const listed = (rows: { language: string; title: string | null; description: string | null }[]) =>
    rows.map(row => ({ language: row.language.toLowerCase(), title: row.title, description: row.description ?? null }))
      .sort((left, right) => left.language.localeCompare(right.language));
  return JSON.stringify(listed(current.localized)) === JSON.stringify(listed(desired.localized))
    && (current.completionStatus ?? null) === desired.completionStatus
    && current.originalTitle?.value === desired.originalTitle?.value
    && current.originalTitle?.language === desired.originalTitle?.language;
}

export async function publishCatalogueText(port: SeedPort, work: { work: string; mainVersion: string },
  key: string, language: string, body: string) {
  const actor = port.actingSubject;
  const contribution = await call<{ contribution: string; draftRevision: string }>(port, 'POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language, body, actingSubject: actor,
  }, seedKey('vndb-contribution', key));
  await port.grant(`contribution:read:${contribution.contribution}`, 'contribution.read');
  await port.grant(`contribution:publish:${contribution.contribution}`, 'contribution.publish');
  const published = await call<{ publicationDecision: string }>(port, 'POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: contribution.contribution,
    expectedDraftHead: contribution.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
  }, seedKey('vndb-publication', key));
  await call(port, 'POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: contribution.contribution, publicationDecision: published.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor,
  }, seedKey('vndb-selection', key));
  return { contribution: contribution.contribution, decision: published.publicationDecision };
}

/** The dev seed's operator database can grant a contribution the imported-work helper already knows. */
export async function grantPublishedContribution(input: LocalOperatorInput, contribution: string) {
  await grantImportedContributionSeedAuthority(input, contribution);
}

export async function call<T>(port: SeedPort, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, key?: string): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await port.request(method, path, body, key);
    if (result.status === 202 && attempt < 7) { await delay(500); continue; }
    if (result.status >= 400) unexpected(result, `${method} ${path}`);
    return result.body as T;
  }
  throw new Error(`${method} ${path} stayed pending`);
}

export async function read<T>(port: SeedPort, path: string): Promise<T> {
  const actor = port.actingSubject;
  const joined = `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(actor)}`;
  for (let attempt = 0; ; attempt++) {
    const result = await port.request('GET', joined);
    if (result.status === 200) return result.body as T;
    if ((result.status === 404 || result.status === 503) && attempt < 6) {
      await delay(Math.min(8000, 500 * 2 ** attempt));
      continue;
    }
    unexpected(result, `GET ${path}`);
  }
}

function unexpected(result: HttpResult, operation: string): never {
  throw new Error(`${operation} HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 500)}`);
}
