import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import type { RealizationWrite } from '../../../services/main/src/modules/realization/schema.ts';
import type { ReleaseV2Write } from '../../../services/main/src/modules/release/schema.ts';
import { RELEASE_QUERY_COST, releaseWorksPage } from '../../../services/main/src/modules/facets/release-contract.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const root = (work: string) => `/v1/works/${work.slice(-36)}`;
type Editor = Awaited<ReturnType<MediaStack['member']>>;
type Page = { profile: 'release-works-v1'; items: { id: string; matchedReleases: string[]; moreMatchedReleases: boolean }[];
  nextCursor: string | null; sourcePosition: { dataEpoch: string; sequence: string }; count: { kind: string; total: null } };
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
const condition = (facet: string, ...values: string[]) => ({ facet, any: values });
const group = (...conditions: ReturnType<typeof condition>[]) => ({ facet: 'release', where: { all: conditions } });
const language = (tag: string) => condition('releaseLanguage', tag);
const platform = (value: string) => condition('releasePlatform', value);
const complete = condition('releaseCompleteness', 'complete');
const playable = condition('releaseStatus', 'official', 'unofficial');
const base = { context: 'global', scope: { kind: 'all' }, sort: 'newest', page: { size: 20 } };

async function realization(editor: Editor, work: string, language: string) {
  const body: RealizationWrite = { profile: 'realization-v1', expectedHead: null, actingSubject: editor.actor,
    id: id(), language, kind: 'translation', translators: [editor.actor], publishers: [editor.actor],
    source: { kind: 'unresolved', work }, status: 'official', verification: 'verified', evidence: id() };
  const result = await json<{ revision: string }>(await editor.send('PUT',
    `${root(work)}/realizations/${body.id.slice(-36)}`, body));
  return { realization: body.id, revision: result.revision, completeness: 'complete' as const };
}
async function release(editor: Editor, work: string, coverage: ReleaseV2Write['coverage'],
  platform: string, overrides: Partial<ReleaseV2Write> = {}) {
  const body: ReleaseV2Write = { profile: 'release-v2', expectedHead: null, actingSubject: editor.actor, id: id(),
    kind: 'formal', status: 'official', title: { value: 'Release', language: 'en' }, titleLanguage: 'en',
    tracklistLanguage: null, editionStatement: null, publisher: null, publicationYear: null, isbn13: null,
    originalUrl: null, fixedRelease: null, evidence: null, identifiers: [], platform, territory: 'US', coverage,
    ...overrides };
  const saved = await json<{ revision: string }>(await editor.send('PUT',
    `${root(work)}/releases/${body.id.slice(-36)}`, body));
  return { body, saved };
}

// These are owner-command API fixtures, including a real mixed public/private omnibus.
// The adversarial split puts every requested fact somewhere on the Work, but never on one usable release.
test('G851: one usable release supplies every condition and every explanation; denied releases supply neither', async () => {
  const stack = await startMediaStack('g851-same-release');
  try {
    const editor = await stack.member('release-editor');
    const vn = await stack.publicWork(editor.actor, ['ja'], 'Three incompatible VN releases');
    const book = await stack.publicWork(editor.actor, ['ja'], 'English paperback and Japanese e-book');
    const hidden = await stack.privateWork(editor.actor, 'Hidden omnibus coverage');
    for (const work of [vn, book, hidden]) await editor.grant(`work:edit:${work.work}`, 'work.edit');
    const ja = await realization(editor, vn.work, 'ja');
    const en = await realization(editor, vn.work, 'en');
    await release(editor, vn.work, [ja], 'Windows');
    await release(editor, vn.work, [en], 'Switch');
    const trial = await release(editor, vn.work, [{ ...en, completeness: 'trial' }], 'Windows');
    const bookEn = await realization(editor, book.work, 'en'), bookJa = await realization(editor, book.work, 'ja');
    await release(editor, book.work, [bookEn], 'paperback');
    await release(editor, book.work, [bookJa], 'e-book');
    const hiddenEn = await realization(editor, hidden.work, 'en');
    const denied = await release(editor, vn.work, [en, hiddenEn], 'Windows');
    const call = async (conditions: unknown[], overrides: object = {}) => {
      const response = await stack.call('POST', '/v1/query', { body: { ...base,
        filter: { all: conditions }, ...overrides } });
      const body = await json<{ template: string; selection: { facetRefs: string[] }; result: Page }>(response);
      expect(body.template).toBe('release-works-v1');
      expect(Value.Check(releaseWorksPage, body.result)).toBe(true);
      return body.result;
    };
    expect((await call([group(language('en'), platform('Windows'), complete, playable)])).items).toEqual([]);
    const playableTrial = await call([group(language('en'), platform('Windows'))]);
    expect(playableTrial.items).toEqual([expect.objectContaining({ id: vn.work,
      matchedReleases: [trial.body.id], moreMatchedReleases: false })]);
    expect(JSON.stringify(playableTrial)).not.toContain(denied.body.id);
    expect((await call([group(language('en'), platform('e-book'))])).items).toEqual([]);
    // Prove this guard detects the deliberate cross-release join, through the real API.
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = (sparql, maxBytes) => originalQuery(sparql.replace(
      /(\?release\d*) <https:\/\/rezics\.com\/vocab\/platform>/g,
      '$1 <https://rezics.com/vocab/coverageWork> ?work . ?mutantRelease <https://rezics.com/vocab/coverageWork> ?work . ?mutantRelease <https://rezics.com/vocab/platform>'), maxBytes);
    const sameReleaseGuard = async () => expect((await call([
      group(language('en'), platform('Windows'), complete, playable),
    ])).items).toEqual([]);
    try { await expect(sameReleaseGuard()).rejects.toThrow(); }
    finally { stack.fuseki.query = originalQuery; }
    expect((await call([condition('language', 'ja'), group(language('en'), platform('Windows'))])).items)
      .toHaveLength(1);
    expect((await call([condition('language', 'en'), group(language('en'), platform('Windows'))])).items).toEqual([]);

    const th = await realization(editor, vn.work, 'th');
    const thaiRelease = await release(editor, vn.work, [th], 'Windows', { territory: 'TH', status: 'unofficial' });
    expect((await call([group(language('th'), platform('Windows'), complete,
      condition('releaseTerritory', 'TH'), playable)])).items[0]!.matchedReleases).toEqual([thaiRelease.body.id]);
    const saved = await json<{ result: Page }>(await stack.call('POST', '/v1/query', { body: { ...base,
      filter: { all: [{ facet: 'https://rezics.com/definition/facet-release-v1', where: { all: [
        { facet: 'https://rezics.com/definition/facet-release-language-v1', any: ['th'] },
      ] } }] } } }));
    expect(saved.result.items[0]!.matchedReleases).toEqual([thaiRelease.body.id]);

    // Explanation cap reports more and preserves Work grain, including across separate groups.
    const releaseIds = [trial.body.id];
    for (let index = 0; index < 9; index++) releaseIds.push((await release(editor, vn.work, [en], 'Windows')).body.id);
    const many = await call([group(language('en'), platform('Windows'))]);
    expect(many.items).toHaveLength(1);
    expect(many.items[0]!.matchedReleases).toEqual(releaseIds.sort().slice(0, 8));
    expect(many.items[0]!.moreMatchedReleases).toBe(true);
    const separate = await call([group(language('th')), group(language('en'), platform('Windows'))]);
    expect(separate.items).toHaveLength(1);
    expect(separate.items[0]!.moreMatchedReleases).toBe(true);

    // A correction advances the read basis. Existing continuations cannot mix graph versions.
    const first = await call([group(playable)], { page: { size: 1 } });
    expect(first.nextCursor).not.toBeNull();
    await json(await editor.send('PUT', `${root(vn.work)}/releases/${trial.body.id.slice(-36)}`,
      { ...trial.body, expectedHead: trial.saved.revision, evidence: id(), publisher: 'Corrected publisher' }));
    const stale = await stack.call('POST', '/v1/query', { body: { ...base,
      page: { size: 1, continuation: first.nextCursor }, filter: { all: [group(playable)] } } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'read_basis_changed' });

    const before = stack.fuseki.queries;
    const misplaced = await stack.call('POST', '/v1/query', { body: { ...base, filter: { all: [language('en')] } } });
    expect(misplaced.status).toBe(422);
    expect(await misplaced.json()).toMatchObject({ code: 'invalid_query' });
    expect(stack.fuseki.queries).toBe(before);
  } finally { await stack.stop(); }
}, 120_000);

/** Isolated query-owner fixture, built in one graph update. Owner commands are tested above.
 * Each Work has its own public selection, draft, head and release; 620 rows cross 60/128/512.
 * The oldest matching Work follows all nonmatching candidates to detect pre-filter LIMIT mutations. */
async function catalogue(stack: MediaStack, realm: string, size: number) {
  const current: string[] = [], revisions: string[] = [], works: string[] = [], matching: string[] = [];
  for (let index = 0; index < size; index++) {
    const work = id(), main = id(), head = id(), contribution = id(), draft = id(), decision = id(), selection = id();
    const release = id(), releaseHead = id(), slot = id(), zoneSelection = id();
    works.push(work);
    const yes = index >= 70;
    if (yes) matching.push(work);
    current.push(`${iri(work)} a <https://schema.org/CreativeWork>, <https://schema.org/Book> ;
      rv:mainVersion ${iri(main)} ; rv:head ${iri(head)} ; <http://www.w3.org/2000/01/rdf-schema#label> ${lit(`Catalogue ${index}`)}@en .
      ${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} ; rv:selectionHead ${iri(selection)} .
      ${iri(contribution)} rv:work ${iri(work)} ; rv:publicationHead ${iri(decision)} ; rv:language "ja" .
      ${iri(release)} a rv:Release ; rv:work ${iri(work)} ; rv:coverageWork ${iri(work)} ;
        rv:releaseHead ${iri(releaseHead)} ; rv:contentLanguage "th" ; rv:platform ${lit(yes ? 'Windows' : 'Switch')} ;
        rv:completeness "complete" ; rv:releaseStatus "official" ; rv:territory "001" .
      ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ; rv:work ${iri(work)} ;
        rv:mainVersion ${iri(main)} ; rv:selectionHead ${iri(zoneSelection)} .`);
    revisions.push(`${iri(head)} a rv:RevisionAnchor ; rv:component ${iri(work)} ;
      rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ; rv:sequence ${size - index} .
      ${iri(selection)} a rv:PublicationSelection ; rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
        rv:contribution ${iri(contribution)} ; rv:publicationDecision ${iri(decision)} ; rv:selectedDraft ${iri(draft)} .
      ${iri(decision)} a rv:PublicationDecision ; rv:component ${iri(contribution)} ; rv:work ${iri(work)} ;
        rv:contribution ${iri(contribution)} ; rv:disclosure rv:Public ; rv:selectedDraft ${iri(draft)} .
      ${iri(draft)} a rv:RevisionAnchor ; rv:component ${iri(contribution)} ; rv:language "ja" .
      ${iri(releaseHead)} a rv:ReleaseRevision ; rv:component ${iri(release)} ;
        rv:modelRevision <https://rezics.com/definition/release-v2> .
      ${iri(zoneSelection)} a rv:PublicationSelection ; rv:component ${iri(slot)} ; rv:context ${iri(realm)} ;
        rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ; rv:contribution ${iri(contribution)} ;
        rv:publicationDecision ${iri(decision)} ; rv:selectedDraft ${iri(draft)} .`);
  }
  await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
    GRAPH ${iri(GRAPHS.current)} { ${current.join('\n')} }
    GRAPH ${iri(GRAPHS.revisions)} { ${revisions.join('\n')} }
  }`);
  return { works, matching };
}

test('G851: global and Zone inventories filter before pagination and traverse beyond every former candidate bound', async () => {
  const stack = await startMediaStack('g851-traversal');
  try {
    const editor = await stack.member('catalogue-reader');
    const input = { name: 'Release catalogue', actingSubject: editor.actor };
    const created = await createRealmSpace(stack.env, stack.admission(editor.actor, 'space:create:root',
      'space.create', spaceCreationDigest(input)), input);
    if (created.outcome !== 'succeeded' || !created.realm) throw new Error('Realm creation failed');
    const realm = created.realm;
    const fixture = await catalogue(stack, realm, 620);
    const filter = { all: [group(language('th'), platform('Windows'), complete, playable,
      condition('releaseTerritory', '001'))] };
    for (const scope of [{ kind: 'all' }, { kind: 'realm', realm }]) {
      const seen: string[] = [];
      let pages = 0, maxRequestMs = 0, maxGraphCalls = 0;
      let next: string | null = null;
      let position: Page['sourcePosition'] | null = null;
      do {
        const body = { ...base, scope, context: scope.kind === 'realm' ? { realm } : 'global', filter,
          page: { size: 20, ...(next ? { continuation: next } : {}) } };
        const before = stack.fuseki.queries;
        const started = Date.now();
        const page = (await json<{ result: Page }>(await stack.call('POST', '/v1/query', { body }))).result;
        pages++;
        maxRequestMs = Math.max(maxRequestMs, Date.now() - started);
        maxGraphCalls = Math.max(maxGraphCalls, stack.fuseki.queries - before);
        expect(Value.Check(releaseWorksPage, page)).toBe(true);
        expect(page.items.length).toBeLessThanOrEqual(20);
        expect(stack.fuseki.queries - before).toBeLessThanOrEqual(RELEASE_QUERY_COST.graphCalls);
        expect(Date.now() - started).toBeLessThan(RELEASE_QUERY_COST.deadlineMs);
        expect(page.count).toMatchObject({ kind: 'exact-page', total: null });
        if (position) expect(page.sourcePosition).toEqual(position);
        position = page.sourcePosition;
        seen.push(...page.items.map(item => item.id));
        next = page.nextCursor;
        expect(seen.length).toBeLessThanOrEqual(fixture.matching.length);
      } while (next);
      expect(seen).toEqual(fixture.matching);
      expect(new Set(seen).size).toBe(550);
      console.info('G851 traversal:', JSON.stringify({ scope: scope.kind, works: seen.length,
        pages, maxRequestMs, maxGraphCalls }));
    }
    const firstBody = { ...base, filter, page: { size: 1 } };
    const first = (await json<{ result: Page }>(await stack.call('POST', '/v1/query', { body: firstBody }))).result;
    const repeated = (await json<{ result: Page }>(await stack.call('POST', '/v1/query', { body: firstBody }))).result;
    expect(repeated.items).toEqual(first.items);
    // Prove the complete traversal guard detects applying the former 60-Work window
    // before the release filter. The first 70 Works deliberately do not match.
    const liveQuery = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = (sparql, maxBytes) => liveQuery(sparql.replace(
      'SELECT DISTINCT ?work ?head ?main ?epochOrder ?sequence WHERE {',
      `SELECT DISTINCT ?work ?head ?main ?epochOrder ?sequence WHERE {
        { SELECT ?work WHERE { GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?mutantHead }
          GRAPH ${iri(GRAPHS.revisions)} { ?mutantHead rv:dataEpoch ${lit(stack.env.lineage.dataEpoch)} ;
            rv:sequence ?mutantSequence } } ORDER BY DESC(?mutantSequence) LIMIT 60 }`), maxBytes);
    const paginationGuard = async () => {
      const page = (await json<{ result: Page }>(await stack.call('POST', '/v1/query', { body: firstBody }))).result;
      expect(page.items.map(item => item.id)).toEqual([fixture.matching[0]!]);
    };
    try { await expect(paginationGuard()).rejects.toThrow(); }
    finally { stack.fuseki.query = liveQuery; }
    const mismatched = await stack.call('POST', '/v1/query', { body: { ...firstBody,
      filter: { all: [group(language('th'), platform('Switch'), complete, playable)] },
      page: { size: 1, continuation: first.nextCursor } } });
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toMatchObject({ code: 'invalid_work_read' });
    // A real correction during a page read must never emit a mixed snapshot.
    const original = stack.fuseki.query.bind(stack.fuseki);
    let moved = false;
    stack.fuseki.query = async (...args) => {
      const result = await original(...args);
      if (!moved && args[0].includes('SELECT DISTINCT ?work ?head ?main ?epochOrder ?sequence')) {
        moved = true;
        await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:sequence ?n } } INSERT { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:sequence ?next } } WHERE { GRAPH ${iri(GRAPHS.control)} {
          ${iri(DATASET)} rv:sequence ?n } BIND(?n + 1 AS ?next) }`);
      }
      return result;
    };
    const changed = await stack.call('POST', '/v1/query', { body: firstBody });
    const recovered = (await json<{ result: Page }>(changed)).result;
    expect(moved).toBe(true);
    expect(recovered.items).toEqual(first.items);
    expect(BigInt(recovered.sourcePosition.sequence)).toBeGreaterThan(BigInt(first.sourcePosition.sequence));
    stack.fuseki.query = original;
  } finally { await stack.stop(); }
}, 240_000);
