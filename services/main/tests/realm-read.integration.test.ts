import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isForegroundOperation } from '../../../tests/qa/integration/support/operation-cost.ts';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { shareClassificationContext, recordClassifiedStatement, statementDecisionBody,
  discloseClassificationConcept, acceptClassifiedStatement, classificationContextBody, type ClassificationPost } from '../../../scripts/dev/seed/classified-statement.ts';
import { GRAPHS, RV, iri } from '../src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
interface Page<T> { items: T[]; nextCursor: string | null;
  count: { value: number; total: null; kind: 'exact-page' } }

/** Retain exact foreground queries when the original page budget fails. */
async function measuredDecisionPage<T>(stack: MediaStack, path: string, sample: string): Promise<T> {
  const queries: string[] = [];
  const original = stack.fuseki.query;
  const before = stack.fuseki.queries;
  stack.fuseki.query = async (...args) => {
    if (isForegroundOperation()) queries.push(args[0]);
    return original.apply(stack.fuseki, args);
  };
  try { return await json<T>(await stack.call('GET', path)); }
  finally {
    stack.fuseki.query = original;
    const directory = join(import.meta.dir, '../../../.temp/goal');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'decision-page-query-cost.json');
    const samples = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    samples[sample] = { run: Bun.env.REZICS_QA_RUN_ID, graphQueries: stack.fuseki.queries - before, queries };
    writeFileSync(path, JSON.stringify(samples, null, 2));
  }
}

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
    const decisions = await measuredDecisionPage<Page<{ kind: string; work: string | null; subject: string | null;
      outcome: string | null }>>(stack, `${root}/decisions?limit=1`, 'one-classification');
    expect(stack.fuseki.queries - beforeDecisions).toBeLessThanOrEqual(8);
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

test('Statement classification disclosure hides judgments, private meaning, withheld Concepts and unsettled Realm facts', async () => {
  const stack = await startMediaStack('classification-disclosure', { library: true, agents: true });
  try {
    const editor = await stack.member('classification-editor');
    const book = await stack.publicWork(editor.actor, ['en'], 'Disclosure book');
    for (const [scope, action] of [['space:create:root', 'space.create'],
      ['classification:define:global', 'classification.proposition.define'], ['context:create:root', 'context.create'],
      [`statement:speak:${editor.actor}`, 'statement.record'], ['classification:decide:global', 'statement.decide']] as const) {
      await editor.grant(scope, action);
    }
    const realm = await json<{ realm: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Disclosure Realm', capabilities: ['realm'], actingSubject: editor.actor }), 201);
    await editor.grant(`classification:context:${realm.realm}`, 'classification.context.configure');
    await editor.grant(`classification:decide:${realm.realm}`, 'statement.decide');
    await json(await editor.send('POST', '/v1/classification-contexts', {
      profile: 'classification-context-v1', realm: realm.realm, actingSubject: editor.actor }), 201);
    const post: ClassificationPost = (path, body, _token, key) =>
      editor.send('POST', path, body, key).then(response => json(response, 201));
    const define = async (label: string) => json<{ concept: string; sense: string; definitionRevision: string }>(
      await editor.send('POST', '/v1/classification-propositions', {
        profile: 'classification-proposition-v1', label, actingSubject: editor.actor }), 201);
    const terms = {
      visible: await define('Visible genre'), judgment: await define('Judgment hidden genre'),
      privateMeaning: await define('Private meaning genre'), withheld: await define('Withheld genre'),
      rejected: await define('Rejected genre'), pending: await define('Pending genre'),
    };
    const publicContext = await shareClassificationContext(post, editor.token, editor.actor,
      Object.values(terms).filter(term => term !== terms.privateMeaning), 'disclosure-public-context');
    const privateContext = await post<{ context: string; semanticRevision: string }>('/v1/contexts', {
      ...classificationContextBody(editor.actor, [terms.privateMeaning]), disclosure: 'private',
    }, editor.token, 'disclosure-private-context');
    await editor.grant(`context:read:${privateContext.context}`, 'context.read');
    const recorded = new Map<string, { statement: string; meaningKey: string }>();
    const decisions = new Map<string, string>();
    for (const [name, term] of Object.entries(terms)) {
      const statement = await recordClassifiedStatement(post, editor.token, editor.actor, book.mainVersion,
        term.concept, name === 'privateMeaning' ? privateContext : publicContext, `disclosure-statement-${name}`);
      recorded.set(name, statement);
      for (const scope of [{ kind: 'global' } as const, { kind: 'realm-classification', id: realm.realm } as const]) {
        const population = scope.kind === 'global' ? 'global' : 'realm';
        await discloseClassificationConcept(post, editor.token, editor.actor, term.concept,
          `disclosure-hint-${name}-${population}`, scope.kind === 'global' ? scope : { kind: 'realm', realm: scope.id });
        if (name === 'pending') continue;
        const decision = await post<{ decision: string }>('/v1/statement-decisions', statementDecisionBody(editor.actor,
          statement, scope, name === 'rejected' ? 'rejected' : 'accepted', null), editor.token,
        `disclosure-decision-${name}-${population}`);
        if (scope.kind !== 'global') decisions.set(name, decision.decision);
      }
    }
    const reader = await json<{ agent: string }>(await editor.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Disclosure reader' }), 201);
    await json(await editor.send('PUT', `/v1/works/${short(book.work)}/reader-status`, {
      actingSubject: reader.agent, status: 'read', finishedOn: '2026-06-01', expectedVersion: 0 }));
    const stats = () => stack.call('GET', `/v1/me/reading-stats?year=2026&actingSubject=${encodeURIComponent(reader.agent)}`,
      { token: editor.token }).then(response => json<{ books: number; detailsAvailability: string;
        topConcepts: { name: string; count: number }[] }>(response));
    const root = `/v1/realms/${short(realm.realm)}/decisions`;
    const visibleBefore = await measuredDecisionPage<Page<{ id: string; subject: string }>>(stack, root,
      'three-classifications');
    expect(new Set(visibleBefore.items.map(item => item.subject))).toEqual(new Set([
      terms.visible.sense, terms.judgment.sense, terms.withheld.sense]));
    expect((await stats()).topConcepts.map(item => item.name).sort()).toEqual([
      'Judgment hidden genre', 'Visible genre', 'Withheld genre']);

    // A real spoiler judgment must override the explicitly non-spoiler Concept hint.
    // Exact Statement acceptance admits the judgment API; the classified fact retains its own slot.
    const judged = recorded.get('judgment')!;
    for (const acceptance of [{ kind: 'global' } as const, { kind: 'realm', realm: realm.realm } as const]) {
      await post('/v1/statement-decisions', {
        ...statementDecisionBody(editor.actor, judged, acceptance.kind === 'global' ? acceptance
          : { kind: 'realm-classification', id: acceptance.realm }, 'accepted', null),
        target: { kind: 'statement', statement: judged.statement },
      }, editor.token, `disclosure-exact-${acceptance.kind}`);
    }
    // Membership is owner fixture data, exactly as in the judgment API integration fixture.
    await stack.accessPool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent') ON CONFLICT DO NOTHING`, [realm.realm]);
    await stack.accessPool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('realm',$1,1,'disclosure-terms')`, [realm.realm]);
    const consent = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.private_membership_consent
      (id,principal_id,principal_epoch,kind,owner_subject,policy_revision,terms_revision,next_generation,expires_at)
      VALUES ($1,$2,0,'realm',$3,1,'disclosure-terms',1,now()+interval '5 minutes')`, [consent, editor.principalId, realm.realm]);
    await stack.accessPool.query(`INSERT INTO access.private_membership
      (id,kind,owner_subject,principal_id,state,generation,policy_revision,terms_revision,consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'disclosure-terms',$4)`, [randomUUID(), realm.realm, editor.principalId, consent]);
    for (const context of [{ kind: 'global' } as const, { kind: 'realm', realm: realm.realm } as const]) {
      await post(`/v1/statements/${short(judged.statement)}/judgments`, {
        profile: 'statement-judgment-v1', context, dimension: 'spoiler', value: 2, expectedRevision: '0',
      }, editor.token, `disclosure-spoiler-${context.kind}`);
      const badge = await json<{ conceptHint: string; spoiler: { protection: string; sampleSize: number } }>(
        await editor.send('GET', `/v1/statements/${short(judged.statement)}/judgments${context.kind === 'realm'
          ? `?realm=${encodeURIComponent(realm.realm)}` : ''}`));
      expect(badge).toMatchObject({ conceptHint: 'not-spoiler', spoiler: { protection: 'hide-major', sampleSize: 1 } });
    }
    // No general Concept protection writer exists; inject the owning graph's withholding marker,
    // using the same adverse-state fixture as onboarding's shared disclosure tests.
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(terms.withheld.concept)} rv:protectionHead ${iri(`https://rezics.com/id/${randomUUID()}`)} } }`);
    const hidden = ['judgment', 'privateMeaning', 'withheld', 'rejected', 'pending'] as const;
    const publicPage = await json<Page<{ id: string; subject: string }>>(await stack.call('GET', root));
    expect(publicPage.items.map(item => item.subject)).toEqual([terms.visible.sense]);
    expect(publicPage.nextCursor).toBeNull();
    for (const name of hidden) {
      expect(publicPage.items.map(item => item.subject)).not.toContain(terms[name].sense);
      if (decisions.has(name)) expect((await stack.call('GET', `${root}/${short(decisions.get(name)!)}`)).status).toBe(404);
      const resolution = await json<{ state: string }>(await stack.call('POST', '/v1/classification-resolutions', {
        body: { profile: 'classification-resolution-v1', work: book.work, mainVersion: book.mainVersion,
          sense: terms[name].sense, context: { kind: 'realm-classification', id: realm.realm } },
      }));
      expect(resolution.state).toBe(name === 'pending' ? 'absent' : name === 'rejected' ? 'rejected' : 'accepted');
    }
    expect(await stats()).toMatchObject({ books: 1, detailsAvailability: 'complete',
      topConcepts: [{ name: 'Visible genre', count: 1 }] });
  } finally { await stack.stop(); }
}, 120_000);
