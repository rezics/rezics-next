import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { ReadRankingProjection } from '../../../services/main/src/modules/rankings/projection.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';
import { assertHiddenIdEquality, comparableBody, type HiddenIdCounters } from '../support/hidden-id-equality.ts';
import { startMediaStack } from './media-support.ts';
import { foregroundCounted } from './support/query-cost-meter.ts';

const short = (resource: string) => resource.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('a partless Work is marked on one device and read, undone and refused when stale on another', async () => {
  const stack = await startMediaStack('partless-progress');
  const progress = new StructureProgressStore(stack.contentPool, { automaticOrderProjection: false });
  try {
    const a = await stack.member('reader'), b = await stack.member('other');
    stack.access.configureBaseline(stack.fuseki);
    const library = new ReaderLibraryStatusStore(stack.contentPool);
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      libraryStatus: library, sessions: new ConsumptionSessionStore(stack.contentPool, library),
      editionPreferences: new EditionPreferenceStore(stack.contentPool),
      seriesSessions: new SeriesSessionReader(stack.contentPool),
      structureObjects: objects, progress, media: stack.media, mediaAccess: stack.mediaAccess,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [a, b].find(item => item.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        return { ...member.principal, emailVerified: true };
      } } });
    const call = (method: string, path: string, body?: object, token = a.token, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const person = (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Novel reader' }, a.token), 201)).agent;
    const other = (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Other reader' }, b.token), 201)).agent;
    const grant = async (who: { principalId: string }, agent: string, scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), who.principalId, agent, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), agent, scope, action]);
    };
    await grant(a, person, 'work:create:root', 'work.create');
    const types = ['https://schema.org/VideoGame'];
    const saved = await activateMetadataWork(stack.env, { title: 'Paper Cranes', semanticTypes: types,
      admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest('Paper Cranes', types)) });
    const text = await stack.contribution(saved.work, person, 'ja', 'Paper Cranes, a visual novel with no parts.');
    const selection = { context: { kind: 'main-version-default' as const, id: saved.mainVersion }, work: saved.work,
      contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: person };
    await selectMainDefault(stack.env, stack.admission(person, `publication:select:${saved.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    await grant(a, person, `work:read:${saved.work}`, 'work.read');
    await grant(a, person, `work:edit:${saved.work}`, 'work.edit');
    const path = `/v1/works/${short(saved.work)}/progress`;
    const query = `?actingSubject=${encodeURIComponent(person)}`;
    type Mark = { work: string; parts?: boolean; standing: string; version: number; replayed?: boolean };
    expect(await json<Mark>(await call('GET', `${path}${query}`))).toMatchObject({ parts: false, standing: 'not-started', version: 0 });
    const started = await json<Mark>(await call('PUT', path, { actingSubject: person, expectedVersion: 0, standing: 'started' }));
    expect(started).toMatchObject({ standing: 'started', version: 1 });
    // Another request of the same reader is the other device.
    expect(await json<Mark>(await call('GET', `${path}${query}`))).toMatchObject({ standing: 'started', version: 1 });
    const stale = await call('PUT', path, { actingSubject: person, expectedVersion: 0, standing: 'completed' });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_progress');
    expect(await json<Mark>(await call('GET', `${path}${query}`))).toMatchObject({ standing: 'started', version: 1 });
    const key = randomUUID();
    const completed = await json<Mark>(await call('PUT', path,
      { actingSubject: person, expectedVersion: 1, standing: 'completed' }, a.token, key));
    expect(completed).toMatchObject({ standing: 'completed', version: 2 });
    const replayed = await json<Mark>(await call('PUT', path,
      { actingSubject: person, expectedVersion: 1, standing: 'completed' }, a.token, key));
    expect(replayed).toMatchObject({ standing: 'completed', version: 2, replayed: true });
    const year = new Date().getUTCFullYear();
    expect(await library.readingYear(person, a.principal, year)).toMatchObject({ books: 0, chapters: 0 });
    const chapter = `https://rezics.com/id/${randomUUID()}`;
    await stack.contentPool.query(`INSERT INTO structure.progress_command
      (agent,principal_issuer, principal_subject, idempotency_key, request_digest, structure, occurrence, selection_key,
        result_version, result_completed, first_finish)
      VALUES ($7,$1,$2,$3,$4,$5,$6,'',1,true,true)`, [a.principal.issuer, a.principal.subject, randomUUID(), 'a'.repeat(64),
      `https://rezics.com/id/${randomUUID()}`, chapter, person]);
    expect(await library.readingYear(person, a.principal, year)).toMatchObject({ books: 0, chapters: 1 });
    expect(await json<{ status: string }>(await call('GET',
      `/v1/me/progress-summaries/${short(saved.work)}?actingSubject=${encodeURIComponent(person)}`)))
      .toMatchObject({ status: 'finished' });
    const rankings = new ReadRankingProjection(stack.accessPool, stack.content, stack.contentPool, stack.env);
    for (let i = 0; i < 100 && (await rankings.tick()) > 0; i++) { /* project the whole-Work marks */ }
    await rankings.current();
    expect((await stack.accessPool.query('SELECT 1 FROM access.read_ranking_pending')).rows).toEqual([]);
    const bucket = new Date().toISOString().slice(0, 10);
    expect((await stack.accessPool.query<{ metric: string; score: string }>(
      `SELECT metric, score::text FROM access.read_ranking_score
       WHERE work = $1 AND interval = 'day' AND bucket = $2 ORDER BY metric`,
      [saved.work, bucket])).rows).toEqual([{ metric: 'reads', score: '1' }]);
    expect(await json<Mark>(await call('GET', `${path}?actingSubject=${encodeURIComponent(other)}`, undefined, b.token)))
      .toMatchObject({ standing: 'not-started', version: 0 });
    const cleared = await json<Mark>(await call('PUT', path, { actingSubject: person, expectedVersion: 2, standing: 'not-started' }));
    expect(cleared).toMatchObject({ standing: 'not-started', version: 3 });
    expect(await json<Mark>(await call('GET', `${path}${query}`))).toMatchObject({ standing: 'not-started', version: 3 });
    const dropped = await json<Mark>(await call('PUT', path, { actingSubject: person, expectedVersion: 3, standing: 'dropped' }));
    expect(dropped).toMatchObject({ standing: 'dropped', version: 4 });
    expect(await json<{ status: string }>(await call('GET',
      `/v1/me/progress-summaries/${short(saved.work)}?actingSubject=${encodeURIComponent(person)}`)))
      .toMatchObject({ status: 'dropped' });
    expect((await call('GET', `${path}${query}`, undefined, '')).status).toBe(401);
    expect((await call('GET', `/v1/works/${randomUUID()}/progress${query}`)).status).toBe(404);
    // A Work this caller cannot read answers like an id that names nothing, and a mark does not land.
    const sealed = await stack.privateWork(person, 'Sealed novel');
    const absentId = randomUUID();
    const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const originalQuery = prototype.query;
    let statements = 0;
    let countSql = true;
    let bytes = 0;
    prototype.query = function (this: unknown, ...args: unknown[]) {
      if (countSql && foregroundCounted()) statements++;
      return originalQuery.apply(this, args);
    };
    const progressRows = async (structure: string) => {
      countSql = false;
      try {
        const counted = await stack.contentPool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM structure.progress WHERE structure = $1', [structure]);
        return counted.rows[0]!.n;
      } finally { countSql = true; }
    };
    try {
      const beforeHidden = await progressRows(sealed.work);
      const beforeAbsent = await progressRows(`https://rezics.com/id/${absentId}`);
      const readCounters = async (): Promise<HiddenIdCounters> => {
        countSql = false;
        try {
          const media = await stack.contentPool.query<{ n: number }>('SELECT count(*)::int AS n FROM media.transform_job');
          const rate = await stack.accessPool.query<{ n: string }>(
            'SELECT coalesce(sum(count), 0)::int AS n FROM access.rate_limit_v1');
          return {
            graphCalls: stack.fuseki.queries, sqlStatements: statements, bytes,
            mediaGenerations: media.rows[0]!.n, rateLimitCharges: Number(rate.rows[0]!.n),
          };
        } finally { countSql = true; }
      };
      const outsider = (id: string) =>
        `/v1/works/${id}/progress?actingSubject=${encodeURIComponent(other)}`;
      await assertHiddenIdEquality({
        operation: 'GET /v1/works/{id}/progress',
        hiddenId: short(sealed.work), absentId, readCounters,
        call: async (id) => {
          const response = await call('GET', outsider(id), undefined, b.token);
          bytes += (await response.clone().arrayBuffer()).byteLength;
          return response;
        },
      });
      const put = async (id: string) => {
        const response = await call('PUT', `/v1/works/${id}/progress`,
          { actingSubject: other, expectedVersion: 0, standing: 'started' }, b.token);
        bytes += (await response.clone().arrayBuffer()).byteLength;
        return response;
      };
      const hiddenWrite = await put(short(sealed.work));
      const absentWrite = await put(absentId);
      expect(hiddenWrite.status).toBe(absentWrite.status);
      expect(comparableBody(await hiddenWrite.text(), short(sealed.work)))
        .toBe(comparableBody(await absentWrite.text(), absentId));
      expect(await progressRows(sealed.work)).toBe(beforeHidden);
      expect(await progressRows(`https://rezics.com/id/${absentId}`)).toBe(beforeAbsent);
    } finally { prototype.query = originalQuery; }
    await json(await call('POST', '/v1/compositions', { profile: 'work-composition', work: saved.work,
      mainVersion: saved.mainVersion, actingSubject: person }), 201);
    expect(await json<{ parts: boolean }>(await call('GET', `${path}${query}`))).toEqual({ work: saved.work, parts: true });
    const refused = await call('PUT', path, { actingSubject: person, expectedVersion: 4, standing: 'completed' });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { code: string }).code).toBe('work_has_parts');
    // The same miss as a Structure that names no Work: the event stays pending and rankings stop.
    const ghost = `https://rezics.com/id/${randomUUID()}`;
    await progress.write({ principal: a.principal, structure: ghost, occurrence: ghost,
      completed: true, position: null, expectedVersion: 0, idempotencyKey: randomUUID() });
    let parked = false;
    for (let i = 0; i < 8 && !parked; i++) {
      await rankings.tick();
      parked = ((await stack.accessPool.query('SELECT 1 FROM access.read_ranking_pending')).rowCount ?? 0) > 0;
    }
    expect((await stack.accessPool.query<{ target: string }>(
      'SELECT target FROM access.read_ranking_pending ORDER BY target')).rows).toEqual([{ target: ghost }]);
    await expect(rankings.current()).rejects.toThrow('Rankings are catching up');
    expect((await stack.accessPool.query('SELECT 1 FROM access.read_ranking_score WHERE work = $1', [ghost])).rows)
      .toEqual([]);
  } finally {
    progress.stopOrderProjection();
    await stack.stop();
  }
}, 600_000);
