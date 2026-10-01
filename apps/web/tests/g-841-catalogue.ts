// The franchise fixtures of G-840 (`tests/fixtures/catalogue/load.ts`), written through Main's public
// routes into the isolated QA stack, plus the answers Main gives for the acceptance queries. The browser
// signs in as the stack's web member, so every read grant the fixtures need is given to that member too.
// `answers` is what the API said for the same fixture; the e2e compares each page against it.
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { type AcceptanceAnswers, answerAcceptance, seedAcceptance } from './g-914-acceptance.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { relationLexiconSeedMapPath, seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { cataloguePlan, catalogueResourceId, loadCatalogue, type CatalogueManifest, type CatalogueResponse }
  from '../../../tests/fixtures/catalogue/load.ts';
import type { MediaStack } from '../../../tests/qa/integration/media-support.ts';

const short = (resource: string) => resource.slice(-36);
const LEXICON = ['rewrite', 'reboot', 'sequel', 'spin-off', 'adaptation', 'credit-illustrator',
  'credit-concept-supervision', 'correspondence-equivalent'];
/** What the web member may read: a grant to them is only ever one of these. */
const READ_ACTIONS = new Set(['work.read', 'semantic.read']);
export const ISBN = '9780316371247';

export interface SeedReader { principalId: string; actor: string }

interface Related { kind: string; viewingRole: string | null; counterparts: string[]; unresolved: boolean }
/** Main's answers for the queries, all as IRIs and labels the pages are compared with. */
export interface Answers {
  /** Query 1: franchise members, and the parts of the series Work that the volume grain lists. */
  franchises: Record<'sao.franchise' | 'index.franchise', string[]>;
  seriesParts: Record<'sao.bunko' | 'index.original' | 'index.nt' | 'index.gt', { work: string; label: string }[]>;
  /** Query 2: the ISBN's release and what it covers, the digital entry's release likewise. */
  isbn: { release: string; realization: string; work: string; mainVersion: string };
  digital: { release: string; realization: string; work: string; mainVersion: string; provider: string; value: string };
  /** Queries 3, 4 and 11: the relations each Work has, by fixture key. */
  relations: Record<string, Related[]>;
  credits: Record<string, { role: string; displayName: string }[]>;
  /** Query 8: the reading order's members, and the publication order's Works. */
  readingOrder: string[];
  /** Query 9: the omnibus's covered Works. */
  omnibusCoverage: string[];
  /** Query 10: each realization's language, status, verification and source continuity. */
  realizations: Record<string, { language: string; status: string; verification: string; source: { kind: string; work: string } }>;
  /** Query 3: releases of the web Work (none: its text is unavailable, its identity is known). */
  webReleases: number;
}

export interface Seeded {
  manifest: CatalogueManifest;
  answers: Answers;
  spider: { web: string; book: string };
  isbn: string;
  /** Queries 5 and 12 (G-914): the Zones, the reviews per grain and the contributor, as Main answers them. */
  acceptance: AcceptanceAnswers;
}

interface Item { kind: string; evidence: string | null; sourceVersionStatus?: string;
  rendering: { viewingRole: string } | null; counterparts: { reference: string }[] }

export async function seedCatalogue(stack: MediaStack, reader: SeedReader, scratch: string): Promise<Seeded> {
  const editor = await stack.member('catalogue');
  stack.access.configureBaseline(stack.fuseki);
  const library = new ReaderLibraryStatusStore(stack.contentPool);
  const structureObjects = stack.objects('semantic/structure/');
  await structureObjects.initialize();
  Object.assign(stack.env, { structureObjects });
  const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
    libraryStatus: library, libraryRatings: new ReaderLibraryRatings(stack.accessPool),
    reviews: new ReaderReviews(stack.accessPool), targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool),
    sessions: new ConsumptionSessionStore(stack.contentPool, library),
    editionPreferences: new EditionPreferenceStore(stack.contentPool),
    seriesSessions: new SeriesSessionReader(stack.contentPool), structureObjects,
    media: stack.media, mediaAccess: stack.mediaAccess,
    agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
    profiles: new ProfilesAccess(stack.accessPool),
    personPreferences: new PersonPreferencesStore(stack.accessPool),
    account: { verify: async request => {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
      if (token !== editor.token) throw new AccountAssertionDenied('Unknown bearer');
      const verified = { ...editor.principal, emailVerified: true as const };
      return { ...verified, currentAssertion: async () => verified };
    } } });
  const call = (method: string, path: string, body?: unknown, key: string = randomUUID()) =>
    app.handle(new Request(`http://main.local${path}`, { method, headers: {
      authorization: `Bearer ${editor.token}`, 'idempotency-key': key,
      ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const bodyOf = async (response: Response): Promise<CatalogueResponse> => {
    const text = await response.text();
    if (!text) return { status: response.status, body: null };
    try { return { status: response.status, body: JSON.parse(text) as unknown }; }
    catch { return { status: response.status, body: text }; }
  };
  const ok = async <T>(response: Response, status = 200): Promise<T> => {
    const parsed = await bodyOf(response);
    if (parsed.status !== status) throw new Error(`${parsed.status}: ${JSON.stringify(parsed.body).slice(0, 500)}`);
    return parsed.body as T;
  };
  const person = (await ok<{ agent: string }>(await call('POST', '/v1/agents',
    { profile: 'agent-provision-v1', kind: 'person', displayName: 'Catalogue curator' }), 201)).agent;
  const actor = encodeURIComponent(person);

  const grantTo = async (principalId: string, subject: string, scope: string, action: string) => {
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), principalId, subject, action]);
    await stack.accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), subject, scope, action]);
  };
  const grant = async (scope: string, action: string) => {
    await grantTo(editor.principalId, person, scope, action);
    if (READ_ACTIONS.has(action)) await grantTo(reader.principalId, reader.actor, scope, action);
  };

  // The relation lexicon: the kinds the fixtures use, in every interface language, readable by the web member.
  const specs = LEXICON.map(key => {
    const definition = relationLexiconSeed.find(item => item.key === key);
    if (!definition) throw new Error(`missing lexicon seed ${key}`);
    return definition;
  });
  const found = await Promise.all(specs.map(item => readDefinitionByKey(stack.env, item.key)));
  for (const definition of found) if (definition) await grant(`semantic:read:${definition.definition}`, 'semantic.read');
  const missing = specs.filter((_, index) => found[index] === null);
  if (missing.length) {
    await grant('semantic:create:root', 'semantic.change');
    mkdirSync(scratch, { recursive: true });
    const namespace = `g841-${randomUUID()}`;
    try {
      await seedRelationLexicon({ post: async <T>(path: string, body: object, key: string) =>
        ok<T>(await call('POST', path, body, key), 201),
      authorizeDefinition: async receipt => {
        await grant(`semantic:read:${receipt.component}`, 'semantic.read');
        await grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
      } }, person, namespace, missing, resolve(scratch, 'lexicon.json'));
    } finally {
      try { unlinkSync(relationLexiconSeedMapPath(namespace)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  // Works are created the way G-837's and G-838's seeds create them: the public create route now asks for an
  // own-work claim (which would credit the curator as every Work's author) or a reviewed candidate.
  const createWork = async (item: { title: string; semanticType: string }) => {
    const types = [item.semanticType];
    const created = await activateMetadataWork(stack.env, { title: item.title, language: 'ja', semanticTypes: types,
      admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest(item.title, types, 'ja')) });
    return { work: created.work, mainVersion: created.mainVersion, mainRevision: created.mainRevision };
  };
  const port = { actingSubject: person, grant, createWork,
    request: async (method: string, path: string, body?: unknown, key?: string) =>
      bodyOf(await call(method, path, body as object | undefined, key)) };
  const manifest = await loadCatalogue(port);
  const workId = (id: string) => manifest.works[id]?.work ?? missingWork(id);

  const retried = async (path: string) => {
    for (let attempt = 1; ; attempt++) {
      const response = await bodyOf(await call('GET', path));
      const problem = response.body as { code?: string };
      // A page read samples the graph sequence at both ends and rejects movement.
      if (response.status === 409 && problem.code === 'stale_head' && attempt < 12) {
        await new Promise(done => setTimeout(done, 100 * attempt));
        continue;
      }
      if (response.status !== 200) throw new Error(`${path} ${response.status}: ${JSON.stringify(response.body).slice(0, 400)}`);
      return response.body;
    }
  };
  const relations = async (resource: string): Promise<Related[]> => {
    const items: Item[] = [];
    let after = '';
    do {
      const page = await retried(`/v1/resources/${short(resource)}/relations?actingSubject=${actor}&languages=en&limit=32${after}`) as
        { items: Item[]; next: string | null };
      items.push(...page.items);
      after = page.next ? `&after=${encodeURIComponent(page.next)}` : '';
    } while (after);
    return items.map(item => ({ kind: item.kind, viewingRole: item.rendering?.viewingRole ?? null,
      counterparts: item.counterparts.map(entry => entry.reference), unresolved: item.sourceVersionStatus === 'unresolved' }));
  };
  const members = async (id: string) => ((await retried(`/v1/collections/${short(manifest.collections[id]!.collection)}?actingSubject=${actor}&limit=100`)) as
    { occurrences: { role?: string; target?: string }[] }).occurrences.flatMap(item => item.role === 'member' && item.target ? [item.target] : []);
  const parts = async (id: string) => ((await retried(`/v1/resources/${short(workId(id))}/parts?actingSubject=${actor}&limit=100`)) as
    { parts: { work?: string; displayLabel?: string }[] }).parts.flatMap(item => item.work && item.displayLabel
    ? [{ work: item.work, label: item.displayLabel }] : []);
  const credits = async (id: string) => ((await retried(`/v1/works/${short(workId(id))}/agent-credits?actingSubject=${actor}`)) as
    { items: { role: string; displayName: string }[] }).items.map(item => ({ role: item.role, displayName: item.displayName }));

  // Query 2: an ISBN-13 on a paperback of the same English text the digital entry carries.
  const plan = cataloguePlan();
  const digitalPlan = plan.releases.find(item => item.identifiers.length);
  if (!digitalPlan) throw new Error('the digital release is missing from the plan');
  const digital = manifest.releases[digitalPlan.id]!;
  const english = manifest.realizations[digitalPlan.id]!;
  const paperback = catalogueResourceId('release:g841:paperback');
  const created = await ok<{ release: string }>(await call('PUT',
    `/v1/works/${short(english.work)}/releases/${short(paperback)}`, {
      profile: 'release-v2', id: paperback, expectedHead: null, actingSubject: person, kind: 'formal', status: 'official',
      titleLanguage: 'en', tracklistLanguage: null, title: { value: 'Sword Art Online 1: Aincrad', language: 'en' },
      editionStatement: null, publisher: 'Yen Press', publicationYear: 2014, isbn13: ISBN, originalUrl: null, fixedRelease: null,
      identifiers: [], platform: 'paperback', territory: 'US', evidence: null,
      coverage: [{ realization: english.realization, revision: english.revision, completeness: 'complete' }] },
    'g841:release:paperback'));
  const covered = async (release: string, work: string) => ok<{ coverage: { work: string; mainVersion: string; realization: string | null }[] }>(
    await call('GET', `/v1/works/${short(work)}/releases/${short(release)}?actingSubject=${actor}`));
  const paperbackCoverage = (await covered(created.release, english.work)).coverage[0]!;
  const digitalCoverage = (await covered(digital.release, english.work)).coverage[0]!;

  const realizations: Answers['realizations'] = {};
  for (const [key, entry] of Object.entries(manifest.realizations)) {
    const body = await retried(`/v1/works/${short(entry.work)}/realizations/${short(entry.realization)}?actingSubject=${actor}`) as
      { language: string; status: string; verification: string; source: { kind: string; work: string } };
    realizations[key] = { language: body.language, status: body.status, verification: body.verification,
      source: { kind: body.source.kind, work: body.source.work } };
  }
  const omnibus = manifest.releases['index.original:omnibus']!;
  const omnibusCoverage = (await covered(omnibus.release, omnibus.work)).coverage.map(item => item.work);
  const webReleases = ((await retried(`/v1/works/${short(workId('sao.web'))}/releases?actingSubject=${actor}`)) as { items: unknown[] }).items.length;

  const relationKeys = ['sao.bunko', 'sao.web', 'sao.progressive', 'sao.aggo', 'index.railgun', 'index.railgun.anime',
    'index.original', 'index.nt', 'index.gt', 'D03.web', 'D03.books'];
  const related: Answers['relations'] = {};
  for (const key of relationKeys) related[key] = await relations(workId(key));
  const creditKeys = ['sao.bunko', 'sao.aggo', 'index.original'];
  const credited: Answers['credits'] = {};
  for (const key of creditKeys) credited[key] = await credits(key);

  // Query 6: the book and the web serial are recorded as equivalent counterparts; the web page offers the book.
  const definition = await readDefinitionByKey(stack.env, 'correspondence-equivalent');
  if (!definition) throw new Error('the correspondence-equivalent definition is missing');
  const head = await retried(`/v1/lexicon/definitions/correspondence-equivalent?actingSubject=${actor}`) as { revision: string };
  await ok(await call('POST', '/v1/relations/changes', {
    profile: 'relation-change-v1', expectedHead: null, definition: head.revision, evidence: 'https://example.com/g841/spider',
    participations: [{ role: 'source', participant: { kind: 'resource', ref: workId('D03.web') } },
      { role: 'target', participant: { kind: 'resource', ref: workId('D03.books') } }],
    actingSubject: person }, 'g841:correspondence:spider'), 201);

  // Queries 5 and 12 (G-914): two Zones, the related Works, and a review on each grain in the SAO Zone's Realm.
  const acceptance = await seedAcceptance(port, manifest, { digitalRelease: digital.release, digitalRealization: english.realization });

  // Main keeps processing the writes' events for a while, moving the graph under every read (409).
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && still < 4;) {
    const response = await bodyOf(await call('GET', `/v1/works/${short(workId('index.original'))}?actingSubject=${actor}`));
    const position = response.status === 200 ? JSON.stringify((response.body as { sourcePosition: unknown }).sourcePosition) : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise(done => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 90 seconds after the seed');

  const answers: Answers = {
    franchises: { 'sao.franchise': await members('sao.franchise'), 'index.franchise': await members('index.franchise') },
    seriesParts: { 'sao.bunko': await parts('sao.bunko'), 'index.original': await parts('index.original'),
      'index.nt': await parts('index.nt'), 'index.gt': await parts('index.gt') },
    isbn: { release: created.release, realization: paperbackCoverage.realization ?? '', work: paperbackCoverage.work,
      mainVersion: paperbackCoverage.mainVersion },
    digital: { release: digital.release, realization: digitalCoverage.realization ?? '', work: digitalCoverage.work,
      mainVersion: digitalCoverage.mainVersion, provider: digitalPlan.identifiers[0]!.provider, value: digitalPlan.identifiers[0]!.value },
    relations: related, credits: credited, readingOrder: await members('index.original.reading'),
    omnibusCoverage, realizations, webReleases };
  return { manifest, answers, spider: { web: workId('D03.web'), book: workId('D03.books') }, isbn: ISBN,
    acceptance: await answerAcceptance(acceptance, retried, actor, manifest) };
}

function missingWork(id: string): never { throw new Error(`catalogue work ${id} is missing`); }
