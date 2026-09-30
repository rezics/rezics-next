import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import type { SessionState } from '../../../services/main/src/modules/session/contract.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { WORK_PROGRESS_COST, workSummary } from '../../../services/main/src/modules/progress-summary/contract.ts';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { cataloguePlan } from '../../fixtures/catalogue/load.ts';
import { readDefinitionByKey } from '../../../services/main/src/modules/relation/change.ts';
import { relationLexiconSeed } from '../../../scripts/dev/seed/relation-lexicon-data.ts';
import { relationLexiconSeedMapPath, seedRelationLexicon } from '../../../scripts/dev/seed/relation-lexicon.ts';
import { startMediaStack } from './media-support.ts';

const short = (resource: string) => resource.slice(-36);
type Summary = Static<typeof workSummary>;
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G-894: Spider Works without composition have private own-Work summaries, isolated from their Rewrite', async () => {
  const preparation = Date.now();
  const stack = await startMediaStack('g-894-progress');
  try {
    const a = await stack.member('reader'), b = await stack.member('other');
    stack.access.configureBaseline(stack.fuseki);
    const library = new ReaderLibraryStatusStore(stack.contentPool);
    const sessions = new ConsumptionSessionStore(stack.contentPool, library);
    const preferences = new EditionPreferenceStore(stack.contentPool);
    const series = new SeriesSessionReader(stack.contentPool);
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      libraryStatus: library, sessions, editionPreferences: preferences, seriesSessions: series,
      structureObjects: objects, media: stack.media, mediaAccess: stack.mediaAccess,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [a, b].find(member => member.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        return { ...member.principal, emailVerified: true };
      } } });
    const call = (method: string, path: string, body?: object, token = a.token) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const provision = async (token: string) => (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Spider reader' }, token), 201)).agent;
    const person = await provision(a.token), other = await provision(b.token);
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), a.principalId, person, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), person, scope, action]);
    };
    // Expand just the Spider slice from the same catalogue acceptance fixture.
    const plan = cataloguePlan();
    const works = new Map<string, { work: string; mainVersion: string; mainRevision: string }>();
    await grant('work:create:root', 'work.create');
    for (const item of plan.works.filter(item => item.id.startsWith('D03.'))) {
      const semanticTypes = [item.semanticType];
      const saved = await activateMetadataWork(stack.env, { title: item.title, semanticTypes,
        admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest(item.title, semanticTypes)) });
      const text = await stack.contribution(saved.work, person, 'ja', `${item.id} native text`);
      const selection = { context: { kind: 'main-version-default' as const, id: saved.mainVersion }, work: saved.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: person };
      await selectMainDefault(stack.env, stack.admission(person, `publication:select:${saved.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await grant(`work:read:${saved.work}`, 'work.read');
      await grant(`work:edit:${saved.work}`, 'work.edit');
      const header = await json<{ mainVersionRevision: string }>(await call('GET',
        `/v1/works/${short(saved.work)}?actingSubject=${encodeURIComponent(person)}`));
      works.set(item.id, { ...saved, mainRevision: header.mainVersionRevision });
    }
    const web = works.get('D03.web')!, book = works.get('D03.books')!;
    const rewrite = plan.relations.find(item => item.derivative === 'D03.books')!;
    const definition = await readDefinitionByKey(stack.env, 'rewrite');
    if (definition) await grant(`semantic:read:${definition.definition}`, 'semantic.read');
    else {
      await grant('semantic:create:root', 'semantic.change');
      const spec = relationLexiconSeed.find(item => item.key === 'rewrite')!;
      const namespace = `g894-${randomUUID()}`;
      try {
        await seedRelationLexicon({ post: async <T>(path: string, body: object) => json<T>(await call('POST', path, body), 201),
          authorizeDefinition: async receipt => { await grant(`semantic:read:${receipt.component}`, 'semantic.read'); } },
        person, namespace, [{ ...spec, labels: [] }]);
      } finally { await unlink(relationLexiconSeedMapPath(namespace)); }
    }
    await grant(`derivation:link:${book.work}`, 'work.derive');
    await json(await call('POST', `/v1/resources/${short(book.work)}/derivations`, { profile: 'work-derivation-v2',
      targetMainVersion: book.mainVersion, expectedTargetHead: book.mainRevision,
      sourceWork: web.work, sourceMainVersion: web.mainVersion, sourceMainRevision: web.mainRevision,
      kind: rewrite.kind.toLowerCase(), evidence: rewrite.evidence, actingSubject: person }), 201);
    const summaryResponse = (resource: string, extra = '', token = a.token, agent = person) => call('GET',
      `/v1/me/progress-summaries/${short(resource)}?actingSubject=${encodeURIComponent(agent)}${extra}`, undefined, token);
    const summary = async (resource: string, extra = '', token = a.token, agent = person) => {
      const result = await json<Summary>(await summaryResponse(resource, extra, token, agent));
      expect(Value.Check(workSummary, result)).toBe(true);
      return result;
    };
    const before = await summary(book.work);
    expect(before).toMatchObject({ scope: 'work', language: null, status: 'not-started', counts: { required: 1, completed: 0 } });
    expect(Date.now() - preparation).toBeLessThan(600_000);
    const realization = `https://rezics.com/id/${randomUUID()}`;
    await json(await call('PUT', `/v1/works/${short(web.work)}/realizations/${short(realization)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: person,
      language: 'en', kind: 'translation', translators: [person], publishers: [], source: { kind: 'unresolved', work: web.work },
      status: 'official', verification: 'verified', evidence: rewrite.evidence }));
    const unchangedBook = await summary(book.work);
    let attempt = await json<SessionState>(await call('POST', '/v1/me/sessions',
      { actingSubject: person, target: realization, state: 'active', expectedVersion: 0 }), 201);
    expect(await summary(web.work)).toMatchObject({ status: 'reading', counts: { completed: 0 } });
    attempt = await json<SessionState>(await call('PATCH', `/v1/me/sessions/${short(attempt.id)}`,
      { actingSubject: person, expectedVersion: attempt.version,
        position: { target: realization, unit: 'percentage', value: 100 } }));
    expect((await summary(web.work)).status).toBe('reading');
    await json(await call('PATCH', `/v1/me/sessions/${short(attempt.id)}`,
      { actingSubject: person, expectedVersion: attempt.version, state: 'finished' }));
    await json(await call('POST', '/v1/me/sessions',
      { actingSubject: person, target: web.work, state: 'finished', expectedVersion: 0 }), 201);
    expect(await summary(web.work, '&language=zh-Hant')).toMatchObject({ status: 'finished', counts: { completed: 1 } });
    expect(await summary(book.work)).toEqual(unchangedBook);
    expect(await summary(web.work, '', b.token, other)).toMatchObject({ status: 'not-started', counts: { completed: 0 } });
    expect((await summaryResponse(web.work, '', b.token)).status).toBe(403);
    expect((await summaryResponse(web.work, '', '')).status).toBe(401);
    await json(await call('PUT', `/v1/works/${short(book.work)}/reader-status`,
      { actingSubject: person, expectedVersion: 0, status: 'reading' }));
    expect((await summary(book.work)).status).toBe('reading');
    await json(await call('PUT', `/v1/works/${short(book.work)}/reader-status`,
      { actingSubject: person, expectedVersion: 1, status: 'read', finishedOn: '2020-02-01' }));
    expect(await summary(book.work)).toMatchObject({ status: 'finished', revisions: { sessions: [], library: [{ version: 2 }] } });

    const hidden = await stack.privateWork(a.actor, 'Private standalone Work');
    const absent = `https://rezics.com/id/${randomUUID()}`;
    const denied = await summaryResponse(hidden.work), missing = await summaryResponse(absent);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());
    expect((await summaryResponse(web.work)).headers.get('cache-control')).toBe('private, no-store');
    expect((await summaryResponse(web.work, `&parent=${encodeURIComponent(web.work)}`)).status).toBe(400);
    expect((await summaryResponse(web.work, '&releaseCursor=invalid')).status).toBe(400);

    // No composition is different from an empty composition, even when its Work is read.
    await json(await call('POST', '/v1/compositions', { profile: 'work-composition', work: book.work,
      mainVersion: book.mainVersion, actingSubject: person }), 201);
    expect(await json(await summaryResponse(book.work, '&language=ja')))
      .toMatchObject({ scope: 'disclosed-composition', counts: { required: 0, completed: 0 } });

    // A large unfinished history stays bounded, and cannot be called not started.
    const history = await stack.publicWork(person, ['en'], 'Long standalone history');
    for (let n = 0; n <= WORK_PROGRESS_COST.sessions; n++) await json(await call('POST', '/v1/me/sessions',
      { actingSubject: person, target: history.work, expectedVersion: 0, state: 'planned' }), 201);
    const query = stack.contentPool.query.bind(stack.contentPool);
    const statements: string[] = [];
    stack.contentPool.query = ((...args: Parameters<typeof query>) => {
      statements.push(String(args[0])); return query(...args);
    }) as typeof stack.contentPool.query;
    let head: Summary;
    try {
      head = await summary(history.work);
      expect(statements.filter(sql => /reader\.(consumption_session|edition_preference|library_status)/.test(sql)).length)
        .toBe(WORK_PROGRESS_COST.librarySql + WORK_PROGRESS_COST.preferenceSql + WORK_PROGRESS_COST.sessionSql);
      expect(statements).toHaveLength(WORK_PROGRESS_COST.directWorkContentSql);
    } finally { stack.contentPool.query = query; }
    expect(head!).toMatchObject({ status: null, partial: true });
    expect(head!.revisions.sessions).toHaveLength(WORK_PROGRESS_COST.sessions);
    const tail = await summary(history.work, `&sessionCursor=${head!.continuation.sessions}`);
    expect(tail).toMatchObject({ status: null, partial: true, continuation: { sessions: null } });
    expect(tail.revisions.sessions).toHaveLength(1);
    expect(new Set([...head!.revisions.sessions, ...tail.revisions.sessions].map(item => item.id)).size)
      .toBe(WORK_PROGRESS_COST.sessions + 1);
    expect((await summaryResponse(web.work, `&sessionCursor=${head!.continuation.sessions}`)).status).toBe(400);

    const originalBatch = preferences.batch.bind(preferences);
    const originalOwn = stack.access.canReadAsBaselineMember.bind(stack.access);
    let revoked = false;
    stack.access.canReadAsBaselineMember = async (...args) => !revoked && await originalOwn(...args);
    preferences.batch = async (...args) => { const result = await originalBatch(...args); revoked = true; return result; };
    try { expect((await summaryResponse(web.work)).status).toBe(403); }
    finally { preferences.batch = originalBatch; stack.access.canReadAsBaselineMember = originalOwn; }
  } finally { await stack.stop(); }
}, 600_000);
