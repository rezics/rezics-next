import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { shareClassificationContext, recordClassifiedStatement, statementDecisionBody,
  discloseClassificationConcept, acceptClassifiedStatement, type ClassificationPost } from '../../../scripts/dev/seed/classified-statement.ts';
import { GRAPHS, RV, iri } from '../src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
interface Page<T> { items: T[]; nextCursor: string | null;
  count: { value: number; total: null; kind: 'exact-page' } }

test('Realm reads: public home, scoped Works, indexed decisions, privacy and stale pages', async () => {
  const stack = await startMediaStack('realm-read', { library: true, agents: true });
  try {
    const editor = await stack.member('realm-reader');
    const first = await stack.publicWork(editor.actor, ['en'], 'Realm first');
    const second = await stack.publicWork(editor.actor, ['en'], 'Realm second');
    const privateWork = await stack.privateWork(editor.actor, 'Do not disclose');
    await editor.grant('space:create:root', 'space.create');
    const createRealm = async (name: string) => json<{ realm: string; space: string }>(await editor.send('POST',
      '/v1/spaces', { profile: 'space-realm-v1', name, capabilities: ['realm'], actingSubject: editor.actor }), 201);
    const realm = await createRealm('Public reading Realm');
    const other = await createRealm('Other Realm');
    const root = `/v1/realms/${short(realm.realm)}`;
    const get = (path: string) => stack.call('GET', path);

    const home = await json<{ name: { value: string }; description: null; banner: null; rules: null;
      membership: { count: { kind: string; value: null }; publicMembers: null };
      moderators: { kind: string; items: string[] } }>(await get(root));
    expect(home).toMatchObject({ name: { value: 'Public reading Realm' }, description: null,
      banner: null, rules: null, membership: { count: { kind: 'unknown', value: null },
        publicMembers: null }, moderators: { kind: 'unknown', items: [] } });
    expect((await get(`/v1/realms/${randomUUID()}`)).status).toBe(404);
    expect((await get(`${root}/works`)).status).toBe(200);
    expect((await json<Page<unknown>>(await get(`${root}/decisions`))).items).toEqual([]);

    await editor.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
    await editor.grant(`publication:adopt:${other.realm}`, 'publication.adopt');
    const adopt = async (target: typeof first, scope: string) => json(await editor.send('POST',
      '/v1/publication-selections', { profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: scope }, work: target.work,
        mainVersion: target.mainVersion, contribution: target.variants[0]!.contribution,
        publicationDecision: target.variants[0]!.decision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review', actingSubject: editor.actor }), 201);
    await adopt(first, realm.realm);
    await adopt(second, realm.realm);
    await adopt(first, other.realm);
    const beforeWorks = stack.fuseki.queries;
    const page = await json<Page<{ id: string; selection: string }>>(await get(`${root}/works?limit=1`));
    expect(stack.fuseki.queries - beforeWorks).toBeLessThanOrEqual(12);
    expect(page.items).toHaveLength(1);
    expect(page.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    expect(page.nextCursor).toBeString();
    const more = await json<Page<{ id: string }>>(await get(`${root}/works?limit=1&cursor=${page.nextCursor}`));
    expect(new Set([...page.items, ...more.items].map(item => item.id))).toEqual(new Set([first.work, second.work]));
    expect([...page.items, ...more.items].map(item => item.id)).not.toContain(privateWork.work);
    expect(more.nextCursor).toBeNull();
    expect((await get(`/v1/realms/${short(other.realm)}/works?cursor=${page.nextCursor}`)).status).toBe(400);
    expect((await get(`${root}/works?limit=21`)).status).toBe(400);
    expect((await get(`${root}/works?cursor=broken`)).status).toBe(400);

    await editor.grant(`classification:context:${realm.realm}`, 'classification.context.configure');
    await editor.grant(`classification:decide:${realm.realm}`, 'statement.decide');
    await editor.grant('classification:define:global', 'classification.proposition.define');
    await json(await editor.send('POST', '/v1/classification-contexts', {
      profile: 'classification-context-v1', realm: realm.realm, actingSubject: editor.actor }), 201);
    await editor.grant('context:create:root', 'context.create');
    await editor.grant(`statement:speak:${editor.actor}`, 'statement.record');
    await editor.grant('classification:decide:global', 'statement.decide');
    const post: ClassificationPost = (path, body, _token, key) =>
      editor.send('POST', path, body, key).then(response => json(response, 201));
    const concept = await json<{ sense: string; concept: string; definitionRevision: string }>(
      await editor.send('POST', '/v1/classification-propositions', {
        profile: 'classification-proposition-v1', label: 'Realm reading', actingSubject: editor.actor }), 201);
    const interpretation = await shareClassificationContext(post, editor.token, editor.actor, [concept], 'realm-topic-context');
    const statement = await recordClassifiedStatement(post, editor.token, editor.actor,
      first.mainVersion, concept.concept, interpretation, 'realm-topic-statement');
    await discloseClassificationConcept(post, editor.token, editor.actor, concept.concept, 'realm-topic-hint',
      { kind: 'realm', realm: realm.realm });
    const accepted = await post<{ decision: string }>('/v1/statement-decisions', statementDecisionBody(editor.actor,
      statement, { kind: 'realm-classification', id: realm.realm }, 'accepted', null), editor.token, 'realm-topic-decision');
    const beforeDecisions = stack.fuseki.queries;
    const decisions = await json<Page<{ kind: string; work: string | null; subject: string | null;
      outcome: string | null }>>(await get(`${root}/decisions?limit=1`));
    expect(stack.fuseki.queries - beforeDecisions).toBeLessThanOrEqual(24);
    expect(decisions.items).toMatchObject([{ kind: 'classification', work: first.work,
      subject: concept.sense, outcome: 'accepted' }]);
    expect(decisions.nextCursor).toBeString();
    const rest = await json<Page<{ kind: string }>>(await get(`${root}/decisions?limit=1&cursor=${decisions.nextCursor}`));
    expect(rest.items).toMatchObject([{ kind: 'adoption' }]);
    expect((await get(`/v1/realms/${short(other.realm)}/decisions?cursor=${decisions.nextCursor}`)).status).toBe(400);

    const exact = await json<{ id: string; kind: string; subject: string }>(
      await get(`${root}/decisions/${short(accepted.decision)}`));
    expect(exact).toMatchObject({ id: accepted.decision, kind: 'classification', subject: concept.sense });

    // The reader's totals and genre enrichment consume Global Statement acceptance.
    const reader = await json<{ agent: string }>(await editor.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Realm stats reader' }), 201);
    await json(await editor.send('PUT', `/v1/works/${short(first.work)}/reader-status`, {
      actingSubject: reader.agent, status: 'read', finishedOn: '2026-06-01', expectedVersion: 0 }));
    const stats = () => stack.call('GET', `/v1/me/reading-stats?year=2026&actingSubject=${encodeURIComponent(reader.agent)}`,
      { token: editor.token }).then(response =>
      json<{ books: number; detailsAvailability: string; topConcepts: { name: string; count: number }[] }>(response));
    expect(await stats()).toMatchObject({ books: 1, detailsAvailability: 'complete', topConcepts: [] });
    await discloseClassificationConcept(post, editor.token, editor.actor, concept.concept, 'global-topic-hint');
    const global = await post<{ decision: string }>('/v1/statement-decisions', statementDecisionBody(editor.actor,
      statement, { kind: 'global' }, 'accepted', null), editor.token, 'global-topic-decision');
    expect(await stats()).toMatchObject({ books: 1, topConcepts: [{ name: 'Realm reading', count: 1 }] });
    const rejected = await post<{ decision: string }>('/v1/statement-decisions', statementDecisionBody(editor.actor, statement, { kind: 'global' },
      'rejected', global.decision), editor.token, 'global-topic-rejection');
    expect(await stats()).toMatchObject({ books: 1, topConcepts: [] });
    await post('/v1/statement-decisions', statementDecisionBody(editor.actor, statement, { kind: 'global' },
      'accepted', rejected.decision), editor.token, 'global-topic-reaccepted');
    await post(`/v1/concepts/${short(concept.concept)}/spoiler-hints`, {
      profile: 'concept-spoiler-hint-v1', context: { kind: 'global' }, hint: 'major',
      expectedGeneration: '1', actingSubject: editor.actor }, editor.token, 'global-topic-spoiler');
    expect(await stats()).toMatchObject({ books: 1, topConcepts: [] });
    await post(`/v1/concepts/${short(concept.concept)}/spoiler-hints`, {
      profile: 'concept-spoiler-hint-v1', context: { kind: 'realm', realm: realm.realm }, hint: 'major',
      expectedGeneration: '1', actingSubject: editor.actor }, editor.token, 'realm-topic-spoiler');
    expect((await json<Page<{ kind: string }>>(await get(`${root}/decisions`))).items
      .some(item => item.kind === 'classification')).toBe(false);
    expect((await get(`${root}/decisions/${short(accepted.decision)}`)).status).toBe(404);

    // The detail budget is shared across finished Works. One book can carry
    // more than eight genres when the whole batch still fits its pair bound.
    await json(await editor.send('PUT', `/v1/works/${short(second.work)}/reader-status`, {
      actingSubject: reader.agent, status: 'read', finishedOn: '2026-06-02', expectedVersion: 0 }));
    const genres: { concept: string; definitionRevision: string }[] = [];
    for (let index = 0; index < 9; index++) {
      genres.push(await json(await editor.send('POST', '/v1/classification-propositions', {
        profile: 'classification-proposition-v1', label: `Reading genre ${index}`, actingSubject: editor.actor }), 201));
    }
    const genreContext = await shareClassificationContext(post, editor.token, editor.actor, genres, 'reading-genre-context');
    for (const [index, genre] of genres.entries()) {
      await discloseClassificationConcept(post, editor.token, editor.actor, genre.concept, `reading-genre-hint-${index}`);
      await acceptClassifiedStatement(post, editor.token, editor.actor, first, genre.concept, genreContext,
        { kind: 'global' }, { state: 'absent', source: 'none', decision: null },
        { statement: `reading-genre-statement-${index}`, decision: `reading-genre-decision-${index}` });
    }
    const varied = await stats();
    expect(varied).toMatchObject({ books: 2, detailsAvailability: 'complete' });
    expect(varied.topConcepts).toHaveLength(5);
    expect(varied.topConcepts.every(item => item.name.startsWith('Reading genre ') && item.count === 1)).toBe(true);

    // A public semantic Context rule revision is visible without its actor or manifest.
    const rule = `https://rezics.com/id/${randomUUID()}`;
    const slot = `urn:rezics:context-rule:${'a'.repeat(64)}`;
    const context = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} a rv:ContextRule ; rv:realm ${iri(realm.realm)} ;
        rv:context ${iri(context)} . ${iri(context)} a rv:SemanticContext ;
        rv:contextState rv:Active ; rv:disclosure rv:Public . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(rule)} a rv:FiniteRuleRevision, rv:RevisionAnchor ;
        rv:component ${iri(slot)} ; rv:realm ${iri(realm.realm)} ;
        rv:dataEpoch "${stack.env.lineage.dataEpoch}" ; rv:sequence 999999 . } }`);
    const log = await json<Page<{ id: string; kind: string; subject: string | null; work: string | null;
      dataEpoch: string; sequence: string; outcome: string | null }>>(
      await get(`${root}/decisions?limit=1`));
    expect(log.items).toEqual([{ id: rule, kind: 'semantic-rule-change',
      dataEpoch: stack.env.lineage.dataEpoch, sequence: '999999', work: null,
      subject: context, outcome: null }]);

    const erasedPin = `urn:rezics:content-publication:${'b'.repeat(64)}`;
    const erasedRevision = `urn:rezics:content:revision:${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { <urn:rezics:variant:${randomUUID()}> rv:resource ${iri(first.work)} ;
        rv:contentPublicationHead ${iri(erasedPin)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(erasedPin)} rv:contentRevision ${iri(erasedRevision)} .
        ${iri(erasedRevision)} a rv:ErasedRevision } }`);
    expect((await json<Page<{ id: string }>>(await get(`${root}/works`))).items.map(item => item.id))
      .toEqual([second.work]);
    expect((await json<Page<{ work: string | null }>>(await get(`${root}/decisions`))).items
      .some(item => item.work === first.work)).toBe(false);
    await stack.privateWork(editor.actor, 'Graph position changed');
    expect((await get(`${root}/works?limit=1&cursor=${page.nextCursor}`)).status).toBe(409);
    expect((await get(`${root}/decisions?limit=1&cursor=${decisions.nextCursor}`)).status).toBe(409);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect((await get(root)).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(realm.space)} rv:disclosure rv:Public } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(realm.space)} rv:disclosure rv:Private } } WHERE {}`);
    for (const suffix of ['', '/works', '/decisions']) expect((await get(`${root}${suffix}`)).status).toBe(404);
    expect((await stack.call('GET', `${root}?actingSubject=${encodeURIComponent(editor.actor)}`, { token: editor.token })).status).toBe(404);
  } finally { await stack.stop(); }
}, 120_000);
