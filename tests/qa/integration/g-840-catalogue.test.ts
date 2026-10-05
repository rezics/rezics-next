import { expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { systemDisclosure } from '../../../services/main/src/modules/target/disclosed-references.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { RightsStore } from '../../../services/main/src/modules/rights/store.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { WikiEvidenceStore } from '../../../services/main/src/modules/wiki/evidence.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { relationLexiconSeedMapPath, seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { cataloguePlan, loadCatalogue, type CatalogueResponse } from '../../fixtures/catalogue/load.ts';
import { cataloguePositions, catalogueCollection, catalogueZone, publishCatalogueFact } from '../../fixtures/catalogue/acceptance.ts';
import { startMediaStack } from './media-support.ts';

const short = (resource: string) => resource.slice(-36);
const LEXICON = ['rewrite', 'reboot', 'sequel', 'spin-off', 'adaptation', 'credit-illustrator',
  'credit-concept-supervision', 'correspondence-equivalent'];
const PENDING: { query: number; owner: string; clause: string; reason: string }[] = [];

test('G-840 G-913: all twelve catalogue fixture queries through the public API', async () => {
  const plan = cataloguePlan();
  expect(plan.works).toHaveLength(84);
  expect(plan.parts.filter(part => part.series === 'index.nt').map(part => part.label)).toContain('22 Reverse');
  expect(plan.parts.filter(part => part.series === 'index.gt').map(part => part.label)).toEqual(['1']);
  expect(plan.works.some(work => work.id === 'D08.books')).toBe(false);
  expect(plan.statements).toHaveLength(2);
  const preparation = Date.now();
  const stack = await startMediaStack('g-840-catalogue');
  try {
    const reader = await stack.member('catalogue');
    const reviewer = await stack.member('catalogue-steward');
    stack.access.configureBaseline(stack.fuseki);
    const library = new ReaderLibraryStatusStore(stack.contentPool);
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      libraryStatus: library, libraryRatings: new ReaderLibraryRatings(stack.accessPool),
      sessions: new ConsumptionSessionStore(stack.contentPool, library),
      editionPreferences: new EditionPreferenceStore(stack.contentPool),
      seriesSessions: new SeriesSessionReader(stack.contentPool), structureObjects: objects,
      media: stack.media, mediaAccess: stack.mediaAccess,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      catalogueIntake: new CatalogueIntakeStore(stack.accessPool, stack.env),
      profiles: new ProfilesAccess(stack.accessPool),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      reviews: new ReaderReviews(stack.accessPool), targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool),
      editorialReview: new EditorialReviewStore(stack.accessPool),
      readingPositions: new ReadingPositionStore(stack.contentPool), wikiEvidence: new WikiEvidenceStore(stack.contentPool),
      wikiQuotations: new WikiQuotationStore(stack.contentPool), rights: { store: new RightsStore(stack.contentPool, stack.accessPool) },
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [reader, reviewer].find(member => member.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        const verified = { ...member.principal, emailVerified: true as const };
        return { ...verified, currentAssertion: async () => verified };
      } } });
    const requestPaths = new WeakMap<Response, string>();
    const call = async (method: string, path: string, body?: object, key: string = randomUUID(), token = reader.token) => {
      const response = await app.handle(new Request(`http://main.local${path}`, { method, headers: {
        authorization: `Bearer ${token}`, 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
      requestPaths.set(response, `${method} ${path}`);
      return response;
    };
    const bodyOf = async (response: Response): Promise<CatalogueResponse> => {
      const text = await response.text();
      if (!text) return { status: response.status, body: null };
      try { return { status: response.status, body: JSON.parse(text) as unknown }; }
      catch { return { status: response.status, body: text }; }
    };
    const ok = async <T>(response: Response, status = 200): Promise<T> => {
      const parsed = await bodyOf(response);
      if (parsed.status !== status) throw new Error(`${requestPaths.get(response)} ${parsed.status}: ${JSON.stringify(parsed.body).slice(0, 500)}`);
      return parsed.body as T;
    };
    const person = (await ok<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Catalogue reader' }), 201)).agent;
    const steward = (await ok<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Catalogue steward' }, randomUUID(), reviewer.token), 201)).agent;
    const grant = async (scope: string, action: string, subject = person, principalId = reader.principalId) => {
      const client = await stack.accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
        await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), principalId, subject, action]);
        await client.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), subject, scope, action]);
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the first error */ }
        throw error;
      } finally { client.release(); }
    };
    const specs = LEXICON.map(key => {
      const definition = relationLexiconSeed.find(item => item.key === key);
      if (!definition) throw new Error(`missing lexicon seed ${key}`);
      return { ...definition, labels: definition.labels.filter(label => label[0] === 'en') };
    });
    const found = await Promise.all(specs.map(item => readDefinitionByKey(stack.env, item.key, systemDisclosure)));
    for (const definition of found) {
      if (definition) await grant(`semantic:read:${definition.definition}`, 'semantic.read');
    }
    const missing = specs.filter((_, index) => found[index] === null);
    if (missing.length) {
      await grant('semantic:create:root', 'semantic.change');
      const namespace = `g840-${randomUUID()}`;
      try {
        await seedRelationLexicon({ post: async <T>(path: string, body: object, key: string) =>
          ok<T>(await call('POST', path, body, key), 201),
        authorizeDefinition: async receipt => {
          await grant(`semantic:read:${receipt.component}`, 'semantic.read');
          await grant(`semantic:edit:${receipt.component}`, 'lexicon.presentation.change');
        } }, person, namespace, missing);
      } finally {
        await unlink(relationLexiconSeedMapPath(namespace)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
    const port = { actingSubject: person,
      request: async (method: string, path: string, body?: unknown, key?: string) =>
        bodyOf(await call(method, path, body as object | undefined, key)),
      grant };
    const first = await loadCatalogue(port);
    const second = await loadCatalogue(port);
    expect(Date.now() - preparation).toBeLessThan(600_000);
    expect(Object.keys(first.works)).toHaveLength(84);
    expect(second.createdWrites).toBe(0);
    const identity = (works: typeof first.works) => Object.fromEntries(Object.entries(works).map(([id, item]) =>
      [id, { work: item.work, mainVersion: item.mainVersion, mainRevision: item.mainRevision, title: item.title }]));
    expect(identity(second.works)).toEqual(identity(first.works));
    expect(second.pendingCredits).toEqual([]);
    const actor = encodeURIComponent(person);
    const workId = (id: string) => first.works[id]?.work ?? missingWork(id);
    const relations = async (resource: string) => {
      const items: { kind: string; evidence: string | null; sourceVersionStatus?: string;
        sourceMainRevision?: string | null;
        rendering: { viewingRole: string; meaning: { definition: string };
          bindings: { role: string; participant: { kind?: string; key?: string; ref?: string } }[] } | null;
        counterparts: { reference: string }[] }[] = [];
      let after = '';
      do {
        let page: { items: typeof items; next: string | null } | undefined;
        for (let attempt = 1; ; attempt++) {
          const response = await bodyOf(await call('GET',
            `/v1/resources/${short(resource)}/relations?actingSubject=${actor}&languages=en&limit=32${after}`));
          const problem = response.body as { code?: string };
          // A page read samples the graph sequence at both ends and rejects movement.
          if (response.status === 409 && problem.code === 'stale_head' && attempt < 6) {
            await new Promise(resolve => setTimeout(resolve, 50 * attempt));
            continue;
          }
          if (response.status !== 200) throw new Error(`${response.status}: ${JSON.stringify(response.body).slice(0, 500)}`);
          page = response.body as { items: typeof items; next: string | null };
          break;
        }
        items.push(...page.items);
        after = page.next ? `&after=${encodeURIComponent(page.next)}` : '';
      } while (after);
      return items;
    };
    const members = async (id: string) => {
      const page = await ok<{ occurrences: { role?: string; target?: string }[] }>(await call('GET',
        `/v1/collections/${short(first.collections[id]!.collection)}?actingSubject=${actor}&limit=100`));
      return page.occurrences.flatMap(item => item.role === 'member' && item.target ? [item.target] : []);
    };
    const parts = async (id: string) => ok<{ parts: { work?: string; displayLabel?: string; inclusion?: string }[] }>(
      await call('GET', `/v1/resources/${short(workId(id))}/parts?actingSubject=${actor}&limit=100`));
    // 1. Franchise, volume and anime grains select independent Work identities.
    const sao = await members('sao.franchise');
    const index = await members('index.franchise');
    expect(sao).toHaveLength(8);
    expect(index).toHaveLength(6);
    const releaseIds = new Set(Object.values(first.releases).map(item => item.release));
    const mainVersions = new Set<string>();
    for (const member of [...sao, ...index]) {
      expect(releaseIds.has(member)).toBe(false);
      const header = await ok<{ mainVersion: string }>(await call('GET', `/v1/works/${short(member)}?actingSubject=${actor}`));
      expect(header.mainVersion.startsWith('https://rezics.com/id/')).toBe(true);
      mainVersions.add(header.mainVersion);
    }
    expect(mainVersions.size).toBe(sao.length + index.length);
    const saoVolumes = await parts('sao.bunko');
    const indexVolumes = await parts('index.original');
    expect(saoVolumes.parts.map(part => part.displayLabel)).toEqual(['1']);
    expect(indexVolumes.parts).toHaveLength(24);
    const anime = workId('index.railgun.anime');
    expect(sao.includes(anime) || index.includes(anime)).toBe(false);
    expect(new Set([sao.join(), indexVolumes.parts.map(part => part.work).join(), anime]).size).toBe(3);

    // 2. Every fixture ISBN and provider-qualified digital entry resolves all grains.
    const identified = plan.releases.filter(item => item.isbn13 || item.identifiers.length);
    expect(identified).toHaveLength(2);
    for (const release of identified) {
      const lookups = [...(release.isbn13 ? [`isbn13=${release.isbn13}`] : []),
        ...release.identifiers.map(identifier => `provider=${encodeURIComponent(identifier.provider)}&identifier=${encodeURIComponent(identifier.value)}`)];
      for (const lookup of lookups) {
        const found = await ok<{ items: { id: string; coverage: { realization: string; revision: string; work: string; mainVersion: string }[] }[] }>(
          await call('GET', `/v1/releases?${lookup}&actingSubject=${actor}`));
        expect(found.items.map(item => item.id)).toEqual([first.releases[release.id]!.release]);
        expect(found.items[0]!.coverage).toEqual(release.coverage.map(id => expect.objectContaining({
          realization: first.realizations[id]!.realization, revision: first.realizations[id]!.revision,
          work: first.realizations[id]!.work, mainVersion: first.works[plan.realizations.find(item => item.id === id)!.work]!.mainVersion })));
      }
    }
    const digital = identified.find(item => item.identifiers.length)!;
    expect((await ok<{ items: unknown[] }>(await call('GET', `/v1/releases?provider=https%3A%2F%2Fexample.com%2Fother-store&identifier=${digital.identifiers[0]!.value}&actingSubject=${actor}`))).items).toEqual([]);
    expect((await ok<{ items: unknown[] }>(await call('GET', `/v1/releases?isbn13=9780000000026&actingSubject=${actor}`))).items).toEqual([]);
    expect((await call('GET', `/v1/releases?identifier=${digital.identifiers[0]!.value}&actingSubject=${actor}`)).status).toBe(400);

    // 3. A missing publication does not erase the evidenced web Work identity.
    const bunkoRelations = await relations(workId('sao.bunko'));
    const rewrite = bunkoRelations.find(item => item.kind === 'derivation' && item.rendering?.viewingRole === 'rewrite');
    expect(rewrite).toMatchObject({ evidence: 'https://book.asahi.com/article/14487968', sourceVersionStatus: 'exact' });
    expect(rewrite?.counterparts.some(item => item.reference === workId('sao.web'))).toBe(true);
    expect((await ok<{ items: { status: string }[] }>(await call('GET',
      `/v1/works/${short(workId('sao.web'))}/releases?actingSubject=${actor}`))).items).toEqual([]);
    const fan = await ok<{ status: string; verification: string; evidence: string | null; source: { kind: string; work: string } }>(
      await call('GET', `/v1/works/${short(workId('sao.web'))}/realizations/${short(first.realizations.fan!.realization)}?actingSubject=${actor}`));
    expect(fan).toMatchObject({ status: 'unofficial', verification: 'unverified', evidence: null,
      source: { kind: 'unresolved', work: workId('sao.web') } });

    // 4. Reboot and SpinOff remain distinct relations with independent authorship.
    const progressive = await relations(workId('sao.progressive'));
    expect(progressive.find(item => item.rendering?.viewingRole === 'reboot')?.counterparts
      .some(item => item.reference === workId('sao.bunko'))).toBe(true);
    const aggo = await relations(workId('sao.aggo'));
    expect(aggo.find(item => item.rendering?.viewingRole === 'spin-off')?.counterparts
      .some(item => item.reference === workId('sao.bunko'))).toBe(true);
    const aggoCredits = await ok<{ items: { role: string; agent: string; displayName: string }[] }>(await call('GET',
      `/v1/works/${short(workId('sao.aggo'))}/agent-credits?actingSubject=${actor}`));
    expect(aggoCredits.items).toContainEqual(expect.objectContaining({ role: 'author', displayName: 'Keiichi Sigsawa' }));

    // 6. Even an equivalent correspondence never transfers completion. The
    // reader must explicitly record the other Work's completion.
    await ok(await call('POST', '/v1/me/sessions',
      { actingSubject: person, expectedVersion: 0, target: workId('D03.web'), state: 'finished' }), 201);
    const webSessions = await ok<{ items: { state: string; target: { resource: string } }[] }>(await call('GET',
      `/v1/me/sessions?actingSubject=${actor}&target=${encodeURIComponent(workId('D03.web'))}`));
    expect(webSessions.items.some(item => item.state === 'finished' && item.target.resource === workId('D03.web'))).toBe(true);
    const bookSessions = await ok<{ items: { state: string; target: { resource: string } }[] }>(await call('GET',
      `/v1/me/sessions?actingSubject=${actor}&target=${encodeURIComponent(workId('D03.books'))}`));
    expect(bookSessions.items.some(item => item.state === 'finished' && item.target.resource === workId('D03.web'))).toBe(false);
    const readerState = async (id: string) => ok<{ status: { status: string | null; version: number } }>(
      await call('GET', `/v1/works/${short(workId(id))}/reader-state?actingSubject=${actor}`));
    const bookBefore = await readerState('D03.books');
    expect((await readerState('D03.web')).status.status).toBe('read');
    expect(bookBefore.status.status).toBeNull();
    const equivalence = await ok<{ revision: string }>(await call('GET',
      `/v1/lexicon/definitions/correspondence-equivalent?actingSubject=${actor}`));
    await ok(await call('POST', '/v1/relations/changes', { profile: 'relation-change-v1', expectedHead: null,
      definition: equivalence.revision, actingSubject: person, evidence: 'https://example.com/catalogue-fixture/suggested-correspondence',
      participations: [{ role: 'source', participant: { kind: 'resource', ref: workId('D03.web') } },
        { role: 'target', participant: { kind: 'resource', ref: workId('D03.books') } }] }), 201);
    expect((await relations(workId('D03.books'))).some(item => item.counterparts.some(entry => entry.reference === workId('D03.web')))).toBe(true);
    expect((await readerState('D03.books')).status).toEqual(bookBefore.status);
    expect((await ok<{ items: unknown[] }>(await call('GET',
      `/v1/me/sessions?actingSubject=${actor}&target=${encodeURIComponent(workId('D03.books'))}`))).items).toEqual([]);
    await ok(await call('POST', '/v1/me/sessions', { actingSubject: person, expectedVersion: 0,
      target: workId('D03.books'), state: 'finished' }), 201);
    expect((await readerState('D03.books')).status.status).toBe('read');

    // 8. A reading order changes order without changing any Work identifier.
    const published = indexVolumes.parts.map(part => part.work ?? missingWork('Index published part'));
    const reading = await members('index.original.reading');
    expect(new Set(reading)).toEqual(new Set(published));
    expect(reading).not.toEqual(published);
    expect(reading[0]).toBe(workId('index.original.SS1'));
    expect(indexVolumes.parts.map(part => part.displayLabel)).toEqual([
      ...Array.from({ length: 22 }, (_, index) => String(index + 1)), 'SS1', 'SS2']);

    // 9. Numbering, restarted series and omnibus completion retain exact Works.
    const nt = await parts('index.nt');
    expect(new Set(nt.parts.map(part => part.displayLabel))).toEqual(new Set([...Array.from({ length: 22 }, (_, index) => String(index + 1)), '22 Reverse']));
    expect(nt.parts.find(part => part.displayLabel === '22')!.work)
      .not.toBe(nt.parts.find(part => part.displayLabel === '22 Reverse')!.work);
    expect((await parts('index.gt')).parts.map(part => part.displayLabel)).toEqual(['1']);
    const omnibus = await ok<{ coverage: { work: string }[] }>(await call('GET',
      `/v1/works/${short(first.releases['index.original:omnibus']!.work)}/releases/${short(first.releases['index.original:omnibus']!.release)}?actingSubject=${actor}`));
    expect(new Set(omnibus.coverage.map(item => item.work)).size).toBe(24);
    await ok(await call('POST', '/v1/me/sessions', { actingSubject: person, expectedVersion: 0,
      target: first.releases['index.original:omnibus']!.release, state: 'finished' }), 201);
    expect((await ok<{ counts: { completed: number } }>(await call('GET',
      `/v1/me/progress-summaries/${short(workId('index.original'))}?actingSubject=${actor}&language=ja`))).counts.completed).toBe(24);

    // 10. Script-specific realizations pin their own language and source continuity.
    const hant = await ok<{ language: string; source: { kind: string; work: string; mainVersion?: string } }>(await call('GET',
      `/v1/works/${short(workId('sao.bunko'))}/realizations/${short(first.realizations['sao.bunko:zh-Hant']!.realization)}?actingSubject=${actor}`));
    const hans = await ok<{ language: string; source: { kind: string; work: string; mainVersion?: string } }>(await call('GET',
      `/v1/works/${short(workId('sao.bunko.volume1'))}/realizations/${short(first.realizations['sao.bunko.volume1:zh-Hans']!.realization)}?actingSubject=${actor}`));
    expect(hant).toMatchObject({ language: 'zh-Hant', source: { kind: 'main-version', work: workId('sao.bunko'), mainVersion: first.works['sao.bunko']!.mainVersion } });
    expect(hans).toMatchObject({ language: 'zh-Hans', source: { kind: 'main-version', work: workId('sao.bunko.volume1'),
      mainVersion: first.works['sao.bunko.volume1']!.mainVersion } });
    expect(hant.source.work).not.toBe(hans.source.work);

    // 11. Source chains are traversable in both directions, including unresolved pins.
    const manga = workId('index.railgun');
    const novel = workId('index.original');
    const animeRelations = await relations(anime);
    const adaptation = animeRelations.find(item => item.kind === 'derivation');
    expect(adaptation).toMatchObject({ sourceVersionStatus: 'unresolved', sourceMainRevision: null });
    expect(adaptation?.counterparts.some(item => item.reference === manga)).toBe(true);
    const mangaRelations = await relations(manga);
    expect(mangaRelations.some(item => item.counterparts.some(entry => entry.reference === anime))).toBe(true);
    expect(mangaRelations.some(item => item.counterparts.some(entry => entry.reference === novel))).toBe(true);
    expect((await relations(novel)).some(item => item.counterparts.some(entry => entry.reference === manga))).toBe(true);

    // 12. One contributor identity participates in both Zones; event and
    // franchise membership leave every Work and Main Version intact.
    expect(sao.some(item => index.includes(item))).toBe(false);
    const kawahara = (await ok<{ items: { role: string; agent: string }[] }>(await call('GET',
      `/v1/works/${short(workId('sao.bunko'))}/agent-credits?actingSubject=${actor}`))).items.find(item => item.role === 'author')?.agent;
    expect(typeof kawahara).toBe('string');
    const supervision = await ok<{ definition: string }>(await call('GET',
      `/v1/lexicon/definitions/credit-concept-supervision?actingSubject=${actor}`));
    const concept = aggo.find(item => item.rendering?.meaning.definition === supervision.definition);
    expect(concept?.rendering?.bindings.some(binding =>
      binding.role === 'contributor' && binding.participant.key === kawahara)).toBe(true);
    if (!kawahara) throw new Error('Catalogue contributor is missing');
    const chapterCollection = await catalogueCollection(port, 'Catalogue wiki chapters', []);
    const saoZone = await catalogueZone(port, 'SAO catalogue', {
      franchise: first.collections['sao.franchise']!.collection, chapters: chapterCollection });
    const crossover = await catalogueCollection(port, 'Synthetic crossover catalogue', [workId('sao.aggo'), novel]);
    const crossoverZone = await catalogueZone(port, 'Crossover catalogue', { franchise: crossover });
    for (const [zone, work] of [[saoZone.zone, workId('sao.bunko')], [crossoverZone.zone, workId('sao.aggo')]]) {
      const path = `/v1/zones/${short(zone!)}/routes?actingSubject=${actor}&path=`;
      const page = await ok<{ kind: string; items: { id: string }[] }>(await call('GET', path + '%2Ffranchise'));
      expect(page.kind).toBe('index');
      expect(page.items.map(item => item.id)).toContain(work!);
      expect(await ok(await call('GET', path + encodeURIComponent(`/franchise/${short(work!)}`))))
        .toMatchObject({ kind: 'detail', resource: { id: work } });
      if (work === workId('sao.bunko')) {
        expect((await ok<{ items: { agent: string }[] }>(await call('GET',
          `/v1/works/${short(work)}/agent-credits?actingSubject=${actor}`))).items.map(item => item.agent)).toContain(kawahara);
      } else {
        expect((await relations(work!)).some(item => item.rendering?.bindings.some(binding =>
          binding.role === 'contributor' && binding.participant.key === kawahara))).toBe(true);
      }
    }
    await grant('semantic:create:root', 'semantic.change');
    const semantic = async (state: object) => ok<{ component: string; revision: string }>(await call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, state, actingSubject: person }), 201);
    const event = await semantic({ component: 'resource', types: ['https://schema.org/Event'], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: 'Synthetic crossover event', language: 'en' } }] });
    await grant(`semantic:read:${event.component}`, 'semantic.read');
    const membership = await semantic({ component: 'definition', kind: 'relation', workSubjectRole: 'work',
      roles: ['work', 'event'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) });
    await grant(`semantic:read:${membership.component}`, 'semantic.read');
    const beforeEvent = await Promise.all([workId('sao.bunko'), novel].map(async work =>
      ok<{ id: string; mainVersion: string; revision: string }>(await call('GET', `/v1/works/${short(work)}?actingSubject=${actor}`))));
    for (const work of [workId('sao.bunko'), novel]) {
      const joined = await ok<{ occurrence: string }>(await call('POST', '/v1/relations/changes', {
        profile: 'relation-change-v1', expectedHead: null, definition: membership.revision, actingSubject: person,
        evidence: 'https://example.com/catalogue-fixture/event', participations: [
          { role: 'work', participant: { kind: 'resource', ref: work } },
          { role: 'event', participant: { kind: 'resource', ref: event.component } }] }), 201);
      expect((await relations(work)).some(item => item.counterparts.some(entry => entry.reference === event.component))).toBe(true);
      await grant(`semantic:read:${joined.occurrence}`, 'semantic.read');
      expect(await ok(await call('GET', `/v1/relations/${short(joined.occurrence)}?actingSubject=${actor}`)))
        .toMatchObject({ occurrence: joined.occurrence });
    }
    const eventWorks = (await relations(event.component)).flatMap(item => item.counterparts.map(entry => entry.reference));
    expect(new Set(eventWorks)).toEqual(new Set([workId('sao.bunko'), novel]));
    for (const before of beforeEvent) {
      expect(await ok(await call('GET', `/v1/works/${short(before.id)}?actingSubject=${actor}`)))
        .toMatchObject({ id: before.id, mainVersion: before.mainVersion, revision: before.revision });
    }
    expect(await members('sao.franchise')).toEqual(sao);
    expect(await members('index.franchise')).toEqual(index);

    // 5. Grain is the exact target base, including independently related manga
    // and anime Works. Shared questions never combine their review populations.
    await grant(`rating:context:${saoZone.realm}`, 'rating.context.create');
    const storyQuestion = 'How good is this story or adaptation?';
    const storyContext = await ok<{ context: string }>(await call('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm: saoZone.realm, question: storyQuestion, actingSubject: person }), 201);
    const reviewTargets = [
      { label: 'edition', target: first.releases[digital.id]!.release, grain: 'release', score: 8, question: 'How good is this edition?' },
      { label: 'translation', target: first.realizations[digital.id]!.realization, grain: 'realization', score: 10, question: 'How good is this translation?' },
      { label: 'story', target: workId('sao.bunko'), grain: 'main-version', score: 9, question: storyQuestion },
      { label: 'manga', target: manga, grain: 'main-version', score: 7, question: storyQuestion },
      { label: 'anime', target: anime, grain: 'main-version', score: 6, question: storyQuestion },
    ] as const;
    const reviewIds = new Set<string>();
    for (const target of reviewTargets) {
      const generic = target.grain !== 'main-version';
      const context = generic ? await ok<{ context: string }>(await call('POST', '/v1/rating-contexts', {
        profile: 'realm-target-rating-context-v2', language: 'en', realm: saoZone.realm, question: target.question,
        targetGrain: target.grain, actingSubject: person }), 201) : storyContext;
      await grant(`rating:observe:${context.context}`, 'rating.observation.set');
      const work = Object.values(first.works).find(item => item.work === target.target);
      const observation = generic ? { profile: 'realm-target-rating-observation-v1', target: target.target }
        : { profile: 'realm-standing-rating-observation-v1', work: target.target, mainVersion: work!.mainVersion };
      await ok(await call('POST', '/v1/rating-observations', { ...observation, context: context.context,
        value: target.score, expectedRevisionHead: null, actingSubject: person }), 201);
      const review = await ok<{ review: string }>(await call('POST', '/v1/reviews', {
        profile: 'reader-review-command-v1', actingSubject: person, context: context.context, target: target.target,
        expectedRevision: null, language: 'en', text: `${target.label} review`, spoiler: false }), 201);
      reviewIds.add(review.review);
      const page = await ok<{ items: { id: string; work: string; context: string; rating: number; text: string }[] }>(await call('GET',
        `/v1/resources/${short(target.target)}/reviews?context=${encodeURIComponent(context.context)}&actingSubject=${actor}`));
      expect(page.items).toEqual([expect.objectContaining({ id: review.review, work: target.target,
        context: context.context, rating: target.score, text: `${target.label} review` })]);
      const aggregateScope = { question: target.question, grain: target.grain,
        population: 'account-principal', countedTarget: generic ? target.target : work!.mainVersion };
      expect(await ok(await call('GET', `/v1/resources/${short(target.target)}/ratings?scope=realm&realm=${encodeURIComponent(saoZone.realm)}&context=${encodeURIComponent(context.context)}&actingSubject=${actor}`)))
        .toMatchObject({ count: 1, mean: generic ? null : target.score, aggregationScope: aggregateScope });
      if (generic) expect(await ok(await call('POST', '/v1/rating-aggregates', {
        profile: 'realm-target-latest-mean-v1', context: context.context, target: target.target, actingSubject: person })))
        .toMatchObject({ count: 1, sum: target.score, mean: null, scope: aggregateScope });
      expect((await ok<{ items: unknown[] }>(await call('GET', `/v1/resources/${short(target.target)}/reviews?context=${encodeURIComponent(context.context)}&rating=1&actingSubject=${actor}`))).items).toEqual([]);
    }
    expect(reviewIds.size).toBe(5);
    expect((await call('GET', `/v1/resources/${short(first.releases[digital.id]!.release)}/reviews?context=${encodeURIComponent(storyContext.context)}&actingSubject=${actor}`)).status).toBe(422);
    for (const target of reviewTargets.filter(item => item.grain === 'main-version')) {
      expect(await ok(await call('GET', `/v1/resources/${short(target.target)}/ratings?scope=realm&realm=${encodeURIComponent(saoZone.realm)}&context=${encodeURIComponent(storyContext.context)}&actingSubject=${actor}`)))
        .toMatchObject({ count: 1, mean: target.score });
    }

    // 7. The same subject and predicate retain contradictory claims. Reviewed
    // publications commit continuity IRIs and exact chapter revelation boundaries.
    const character = await semantic({ component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: 'Catalogue fixture character', language: 'en' } }] });
    const predicate = await semantic({ component: 'definition', kind: 'property' });
    const stewardPort = { actingSubject: steward,
      request: async (method: string, path: string, body?: unknown, key?: string) =>
        bodyOf(await call(method, path, body as object | undefined, key, reviewer.token)),
      grant: (scope: string, action: string) => grant(scope, action, steward, reviewer.principalId) };
    await stewardPort.grant(`collection:edit:${chapterCollection}`, 'collection.edit');
    for (const subject of [character.component, predicate.component]) {
      await grant(`semantic:read:${subject}`, 'semantic.read');
      await stewardPort.grant(`semantic:read:${subject}`, 'semantic.read');
    }
    await stewardPort.grant(`statement:speak:${steward}`, 'statement.record');
    const facts: { statement: string; continuity: string; occurrences: string[]; text: string }[] = [];
    for (const planned of plan.statements) {
      const work = first.works[planned.work]!;
      for (const action of ['work.read', 'work.edit', 'work.review']) {
        await stewardPort.grant(`work:${action.slice(5)}:${work.work}`, action);
      }
      const chapters = await cataloguePositions(port, work.work, work.mainVersion);
      const statement = await publishCatalogueFact(port, stewardPort, { work: work.work, zone: saoZone.zone,
        subject: character.component, predicate: predicate.component, text: planned.text, occurrences: chapters.occurrences });
      facts.push({ statement, continuity: work.work, occurrences: chapters.occurrences, text: planned.text });
    }
    expect(new Set(facts.map(fact => fact.statement)).size).toBe(2);
    for (const fact of facts) {
      const path = `/v1/statements/${short(fact.statement)}?actingSubject=${actor}&position=`;
      expect((await call('GET', path + 'start')).status).toBe(404);
      if (fact.occurrences.length > 1) expect((await call('GET', path + encodeURIComponent(fact.occurrences[0]!))).status).toBe(404);
      const revealed = await ok<{ subject: string; predicate: string; value: { lexical: string }; applicability: string[] }>(
        await call('GET', path + encodeURIComponent(fact.occurrences.at(-1)!)));
      expect(revealed).toMatchObject({ subject: character.component, predicate: predicate.component,
        value: { lexical: fact.text }, applicability: [fact.continuity] });
      expect(await ok(await call('GET', path + 'all'))).toMatchObject({ subject: character.component,
        predicate: predicate.component, value: { lexical: fact.text }, applicability: [fact.continuity] });
      const other = facts.find(item => item.statement !== fact.statement)!;
      expect((await call('GET', path + encodeURIComponent(other.occurrences.at(-1)!))).status).toBe(404);
      const chooser = await ok<{ items: { occurrence: string }[] }>(await call('GET',
        `/v1/reading-positions/${short(fact.continuity)}?actingSubject=${actor}&position=all`));
      expect(chooser.items.map(item => item.occurrence)).toEqual(fact.occurrences);
    }
    expect(PENDING).toEqual([]);
  } finally { await stack.stop(); }
}, 600_000);

function missingWork(id: string): never { throw new Error(`catalogue work ${id} is missing`); }
