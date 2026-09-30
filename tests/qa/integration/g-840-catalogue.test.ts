import { expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { relationLexiconSeedMapPath, seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { cataloguePlan, loadCatalogue, type CatalogueResponse } from '../../fixtures/catalogue/load.ts';
import { startMediaStack } from './media-support.ts';

const short = (resource: string) => resource.slice(-36);
const LEXICON = ['rewrite', 'reboot', 'sequel', 'spin-off', 'adaptation', 'credit-illustrator', 'credit-concept-supervision'];
const PENDING = [
  { query: 5, owner: 'G-652', clause: 'review grain', reason: 'G-650 lists reviews, and grain is not a query field' },
  { query: 6, owner: 'G-835', clause: 'suggested correspondence', reason: 'progress summaries have no suggested-correspondence state' },
  { query: 7, owner: 'G-847', clause: 'continuity and spoiler boundary', reason: 'statements cannot record continuity or a spoiler boundary' },
  { query: 12, owner: 'G-831', clause: 'event membership', reason: 'event-overlap relations are not writable' },
  { query: 12, owner: 'G-655', clause: 'one identity across Zones', reason: 'zone reads reject a contributor identity' },
];

test('G-840: catalogue fixture queries through the public API', async () => {
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
    stack.access.configureBaseline(stack.fuseki);
    const library = new ReaderLibraryStatusStore(stack.contentPool);
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      libraryStatus: library, sessions: new ConsumptionSessionStore(stack.contentPool, library),
      editionPreferences: new EditionPreferenceStore(stack.contentPool),
      seriesSessions: new SeriesSessionReader(stack.contentPool), structureObjects: objects,
      media: stack.media, mediaAccess: stack.mediaAccess,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      profiles: new ProfilesAccess(stack.accessPool),
      personPreferences: new PersonPreferencesStore(stack.accessPool),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        if (token !== reader.token) throw new AccountAssertionDenied('Unknown bearer');
        const verified = { ...reader.principal, emailVerified: true as const };
        return { ...verified, currentAssertion: async () => verified };
      } } });
    const call = (method: string, path: string, body?: object, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        authorization: `Bearer ${reader.token}`, 'idempotency-key': key,
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
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Catalogue reader' }), 201)).agent;
    const grant = async (scope: string, action: string) => {
      const client = await stack.accessPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
        await client.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), reader.principalId, person, action]);
        await client.query(`INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [randomUUID(), person, scope, action]);
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
    const found = await Promise.all(specs.map(item => readDefinitionByKey(stack.env, item.key)));
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
    const sao = await members('sao.franchise');
    const index = await members('index.franchise');
    expect(sao).toHaveLength(8);
    expect(index).toHaveLength(6);
    const releaseIds = new Set(Object.values(first.releases).map(item => item.release));
    for (const member of [...sao, ...index]) {
      expect(releaseIds.has(member)).toBe(false);
      const header = await ok<{ mainVersion: string }>(await call('GET', `/v1/works/${short(member)}?actingSubject=${actor}`));
      expect(header.mainVersion.startsWith('https://rezics.com/id/')).toBe(true);
    }
    const saoVolumes = await parts('sao.bunko');
    const indexVolumes = await parts('index.original');
    expect(saoVolumes.parts.map(part => part.displayLabel)).toEqual(['1']);
    expect(indexVolumes.parts).toHaveLength(24);
    const anime = workId('index.railgun.anime');
    expect(sao.includes(anime) || index.includes(anime)).toBe(false);
    expect(new Set([sao.join(), indexVolumes.parts.map(part => part.work).join(), anime]).size).toBe(3);

    const digital = plan.releases.find(item => item.identifiers.length);
    if (!digital) throw new Error('digital release is missing from the plan');
    const foundRelease = await ok<{ items: { id: string; coverage: { realization: string | null; work: string; mainVersion: string }[] }[] }>(
      await call('GET', `/v1/releases?provider=${encodeURIComponent(digital.identifiers[0]!.provider)}&identifier=${encodeURIComponent(digital.identifiers[0]!.value)}&actingSubject=${actor}`));
    expect(foundRelease.items.map(item => item.id)).toEqual([first.releases[digital.id]!.release]);
    expect(foundRelease.items[0]!.coverage[0]).toMatchObject({ realization: first.realizations[digital.id]!.realization,
      work: workId('sao.bunko'), mainVersion: first.works['sao.bunko']!.mainVersion });

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

    const progressive = await relations(workId('sao.progressive'));
    expect(progressive.find(item => item.rendering?.viewingRole === 'reboot')?.counterparts
      .some(item => item.reference === workId('sao.bunko'))).toBe(true);
    const aggo = await relations(workId('sao.aggo'));
    expect(aggo.find(item => item.rendering?.viewingRole === 'spin-off')?.counterparts
      .some(item => item.reference === workId('sao.bunko'))).toBe(true);
    const aggoCredits = await ok<{ items: { role: string; agent: string; displayName: string }[] }>(await call('GET',
      `/v1/works/${short(workId('sao.aggo'))}/agent-credits?actingSubject=${actor}`));
    expect(aggoCredits.items).toContainEqual(expect.objectContaining({ role: 'author', displayName: 'Keiichi Sigsawa' }));

    await ok(await call('POST', '/v1/me/sessions',
      { actingSubject: person, expectedVersion: 0, target: workId('D03.web'), state: 'finished' }), 201);
    const webSessions = await ok<{ items: { state: string; target: { resource: string } }[] }>(await call('GET',
      `/v1/me/sessions?actingSubject=${actor}&target=${encodeURIComponent(workId('D03.web'))}`));
    expect(webSessions.items.some(item => item.state === 'finished' && item.target.resource === workId('D03.web'))).toBe(true);
    const bookSessions = await ok<{ items: { state: string; target: { resource: string } }[] }>(await call('GET',
      `/v1/me/sessions?actingSubject=${actor}&target=${encodeURIComponent(workId('D03.books'))}`));
    expect(bookSessions.items.some(item => item.state === 'finished' && item.target.resource === workId('D03.web'))).toBe(false);
    for (const id of ['D03.web', 'D03.books']) {
      const summary = await bodyOf(await call('GET', `/v1/me/progress-summaries/${short(workId(id))}?actingSubject=${actor}&language=ja`));
      expect(summary.status).toBe(404);
      // A Work with no composition is WorkReadMissing; this route reports that as work_unavailable.
      expect(summary.body).toMatchObject({ code: 'work_unavailable' });
    }

    const published = indexVolumes.parts.map(part => part.work);
    const reading = await members('index.original.reading');
    expect(new Set(reading)).toEqual(new Set(published));
    expect(reading).not.toEqual(published);
    expect(reading[0]).toBe(workId('index.original.SS1'));
    expect(indexVolumes.parts.map(part => part.displayLabel)).toEqual([
      ...Array.from({ length: 22 }, (_, index) => String(index + 1)), 'SS1', 'SS2']);

    const nt = await parts('index.nt');
    expect(new Set(nt.parts.map(part => part.displayLabel))).toEqual(new Set([...Array.from({ length: 22 }, (_, index) => String(index + 1)), '22 Reverse']));
    expect((await parts('index.gt')).parts.map(part => part.displayLabel)).toEqual(['1']);
    const omnibus = await ok<{ coverage: { work: string }[] }>(await call('GET',
      `/v1/works/${short(first.releases['index.original:omnibus']!.work)}/releases/${short(first.releases['index.original:omnibus']!.release)}?actingSubject=${actor}`));
    expect(new Set(omnibus.coverage.map(item => item.work)).size).toBe(24);
    await ok(await call('POST', '/v1/me/sessions', { actingSubject: person, expectedVersion: 0,
      target: first.releases['index.original:omnibus']!.release, state: 'finished' }), 201);
    expect((await ok<{ counts: { completed: number } }>(await call('GET',
      `/v1/me/progress-summaries/${short(workId('index.original'))}?actingSubject=${actor}&language=ja`))).counts.completed).toBe(24);

    const hant = await ok<{ language: string; source: { kind: string; work: string; mainVersion?: string } }>(await call('GET',
      `/v1/works/${short(workId('sao.bunko'))}/realizations/${short(first.realizations['sao.bunko:zh-Hant']!.realization)}?actingSubject=${actor}`));
    const hans = await ok<{ language: string; source: { kind: string; work: string; mainVersion?: string } }>(await call('GET',
      `/v1/works/${short(workId('sao.bunko.volume1'))}/realizations/${short(first.realizations['sao.bunko.volume1:zh-Hans']!.realization)}?actingSubject=${actor}`));
    expect(hant).toMatchObject({ language: 'zh-Hant', source: { kind: 'main-version', work: workId('sao.bunko'), mainVersion: first.works['sao.bunko']!.mainVersion } });
    expect(hans).toMatchObject({ language: 'zh-Hans', source: { kind: 'main-version', work: workId('sao.bunko.volume1'),
      mainVersion: first.works['sao.bunko.volume1']!.mainVersion } });
    expect(hant.source.work).not.toBe(hans.source.work);

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

    expect(sao.some(item => index.includes(item))).toBe(false);
    const kawahara = (await ok<{ items: { role: string; agent: string }[] }>(await call('GET',
      `/v1/works/${short(workId('sao.bunko'))}/agent-credits?actingSubject=${actor}`))).items.find(item => item.role === 'author')?.agent;
    expect(typeof kawahara).toBe('string');
    const supervision = await ok<{ definition: string }>(await call('GET',
      `/v1/lexicon/definitions/credit-concept-supervision?actingSubject=${actor}`));
    const concept = aggo.find(item => item.rendering?.meaning.definition === supervision.definition);
    expect(concept?.rendering?.bindings.some(binding =>
      binding.role === 'contributor' && binding.participant.key === kawahara)).toBe(true);

    await expectRejected(await bodyOf(await call('GET',
      `/v1/resources/${short(workId('sao.bunko'))}/reviews?context=${encodeURIComponent(workId('sao.bunko'))}&grain=edition&actingSubject=${actor}`)), 'query 5 grain');
    await expectRejected(await bodyOf(await call('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: workId('sao.bunko'),
      predicate: 'https://example.com/catalogue-fixture/predicate',
      relationDefinition: 'https://example.com/catalogue-fixture/relation',
      value: { kind: 'literal', lexical: 'survives in the books', datatype: 'http://www.w3.org/2001/XMLSchema#string', language: 'en' },
      applicability: ['https://example.com/catalogue-fixture/applicability'], interpretation: { kind: 'selected' },
      evidence: ['https://example.com/catalogue-fixture/evidence'], actingSubject: person,
      continuity: 'books', spoilerBoundary: 'books' })), 'query 7 continuity');
    await expectRejected(await bodyOf(await call('GET',
      `/v1/zones/${randomUUID()}?actingSubject=${actor}&contributorIdentity=1`)), 'query 12 zones');
    console.log(JSON.stringify(PENDING));
    expect(PENDING.map(item => item.owner).sort()).toEqual(['G-652', 'G-655', 'G-831', 'G-835', 'G-847']);
  } finally { await stack.stop(); }
}, 600_000);

function missingWork(id: string): never { throw new Error(`catalogue work ${id} is missing`); }

async function expectRejected(response: CatalogueResponse, label: string) {
  const body = response.body as { code?: string; title?: string };
  if (response.status === 400 && body.code === 'invalid_request' && body.title === 'Request does not match the Work contract') return;
  throw new Error(`${label} accepted an extra field (${response.status} ${body.code ?? ''} ${body.title ?? ''}); write the real assertion`);
}
