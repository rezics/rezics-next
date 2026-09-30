import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import type { SessionState } from '../../../services/main/src/modules/session/contract.ts';
import { EditionPreferenceStore } from '../../../services/main/src/modules/session/preference-store.ts';
import { SeriesSessionReader } from '../../../services/main/src/modules/session/series-store.ts';
import { SERIES_COST } from '../../../services/main/src/modules/session/series-policy.ts';
import { EDITION_PREFERENCE_COST } from '../../../services/main/src/modules/session/preference-contract.ts';
import type { readSeriesProgress } from '../../../services/main/src/modules/session/series-read.ts';
import { startMediaStack } from './media-support.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { mainSelectionDigest, selectMainDefault } from '../../../services/main/src/modules/work/select-main.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (resource: string) => resource.slice(-36);
type Summary = Awaited<ReturnType<typeof readSeriesProgress>>;
type Composition = { structure: string; revision: string; occurrences: string[] };
async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G-835: Index reference API, distinct omnibus coverage, preference races, pinned revisions, privacy and bounded continuation', async () => {
  const preparation = Date.now();
  const stack = await startMediaStack('g-835-series');
  try {
    const a = await stack.member('reader'), b = await stack.member('other');
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
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = a.token) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const person = (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Series reader' }), 201)).agent;
    const other = (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'Other reader' }, randomUUID(), b.token), 201)).agent;
    const grant = async (scope: string, action: string, agent = person, principalId = a.principalId) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, agent, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), agent, scope, action]);
    };
    const work = async (title: string) => {
      const semanticTypes = ['https://schema.org/Book'];
      const result = await activateMetadataWork(stack.env, { title, semanticTypes,
        admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
      const text = await stack.contribution(result.work, person, 'ja', `${title} native text`);
      const selection = { context: { kind: 'main-version-default' as const, id: result.mainVersion }, work: result.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: person };
      await selectMainDefault(stack.env, stack.admission(person, `publication:select:${result.mainVersion}`,
        'publication.select', mainSelectionDigest(selection)), selection);
      await grant(`work:edit:${result.work}`, 'work.edit');
      await grant(`work:read:${result.work}`, 'work.read');
      return result;
    };
    const original = await work('Index Original');
    let composition = await json<Composition>(await call('POST', '/v1/compositions',
      { profile: 'work-composition', work: original.work, mainVersion: original.mainVersion, actingSubject: person }), 201);
    const volumes = [];
    for (let n = 1; n <= 24; n++) volumes.push(await work(n <= 22 ? `Index volume ${n}` : `Index SS${n - 22}`));
    for (let offset = 0; offset < volumes.length; offset += 16) {
      composition = await json<Composition>(await call('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
        profile: 'work-composition', actingSubject: person, expectedHead: composition.revision,
        operations: volumes.slice(offset, offset + 16).map((volume, i) => ({ op: 'insert', role: 'part',
          parent: composition.structure, position: 'last', target: volume.work,
          displayLabel: offset + i < 22 ? String(offset + i + 1) : `SS${offset + i - 21}`,
          inclusion: offset + i < 22 ? 'required' : 'extra' })) }));
    }
    composition = await json<Composition>(await call('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'work-composition', actingSubject: person, expectedHead: composition.revision,
      operations: [{ op: 'completion', completion: { status: 'concluded', evidence: ['https://example.com/index-original'] } }] }));
    const realize = async (target: string, language: string) => {
      const realization = id();
      const result = await json<{ revision: string }>(await call('PUT', `/v1/works/${short(target)}/realizations/${short(realization)}`, {
        profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: person,
        language, kind: 'translation', translators: [person], publishers: [], source: { kind: 'unresolved', work: target },
        status: 'official', verification: 'verified', evidence: id() }));
      return { realization, revision: result.revision, completeness: 'complete' as const };
    };
    const coverage = [];
    for (const volume of volumes.slice(0, 20)) coverage.push(await realize(volume.work, 'zh-Hant'));
    const prefPath = `/v1/me/edition-preferences/${short(original.work)}`;
    const pref = (language: string, expectedVersion: number, key = randomUUID()) => call('PUT', prefPath,
      { actingSubject: person, language, edition: null, expectedVersion }, key);
    const preferenceKey = randomUUID();
    expect(await json(await pref('zh-Hant', 0, preferenceKey))).toMatchObject({ version: 1, replayed: false });
    expect((await pref('en', 0)).status).toBe(409);
    expect((await pref('en', 0, preferenceKey)).status).toBe(409);
    const races = await Promise.all([pref('zh-Hant', 1), pref('zh-Hant', 1)]);
    expect(races.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await json(await pref('zh-Hant', 0, preferenceKey))).toMatchObject({ version: 1, replayed: true });
    const summaryPath = `/v1/me/progress-summaries/${short(original.work)}?actingSubject=${encodeURIComponent(person)}`;
    const summary = (suffix = '') => call('GET', `${summaryPath}${suffix}`);
    const finish = (target: string) => call('POST', '/v1/me/sessions',
      { actingSubject: person, expectedVersion: 0, target, state: 'finished' });
    const empty = await json<Summary>(await summary());
    expect(empty).toMatchObject({ counts: { completed: 0, required: 22 }, partial: false,
      states: { caughtUpWithAvailableMaterial: false, finishedPublishedParts: false, seriesConcluded: true } });
    // Completed in Japanese; the preference selects future availability only.
    for (const volume of volumes.slice(0, 10)) await json(await call('POST', '/v1/me/sessions',
      { actingSubject: person, expectedVersion: 0, target: volume.work, state: 'finished',
        addSelections: [{ target: volume.work, language: 'ja' }] }), 201);
    // Library statements and imported completion dates share the status owner,
    // without requiring a fabricated session or language.
    for (const volume of volumes.slice(10, 15)) await json(await call('PUT', `/v1/works/${short(volume.work)}/reader-status`,
      { actingSubject: person, status: 'read', expectedVersion: 0 }));
    // This is the ordinary command shape emitted by the reviewed-import adapter.
    for (const volume of volumes.slice(15, 20)) await json(await call('PUT', `/v1/works/${short(volume.work)}/reader-status`,
      { actingSubject: person, status: 'read', startedOn: null, finishedOn: '2020-01-01', expectedVersion: 0 }));
    expect((await json<Summary>(await summary())).revisions.library).toContainEqual({ work: volumes[10]!.work, version: 1 });
    const caught = await json<Summary>(await summary());
    expect(caught).toMatchObject({ counts: { completed: 20 },
      states: { caughtUpWithAvailableMaterial: true, finishedPublishedParts: false, correspondenceUnresolved: false },
      next: { part: { displayLabel: '21' }, reason: 'awaiting_chosen_language' },
      furthestCompleted: { part: { displayLabel: '20' } },
      revisions: { composition: { revision: composition.revision } } });
    expect(Date.now() - preparation).toBeLessThan(600_000);
    for (const volume of volumes.slice(20)) coverage.push(await realize(volume.work, 'zh-Hant'));
    const release = id();
    const releaseBody = { profile: 'release-v2', id: release, expectedHead: null, actingSubject: person,
      kind: 'formal', status: 'official', titleLanguage: 'ja', tracklistLanguage: null,
      title: { value: 'Index Original omnibus', language: 'ja' }, editionStatement: null,
      publisher: 'Index Press', publicationYear: 2026, isbn13: null, originalUrl: null, fixedRelease: null,
      identifiers: [], platform: null, territory: null, coverage, evidence: null };
    const releasePath = `/v1/works/${short(volumes[0]!.work)}/releases/${short(release)}`;
    const savedRelease = await json<{ revision: string }>(await call('PUT', releasePath, releaseBody));
    const nextText = coverage[20]!;
    const childPrefPath = `/v1/me/edition-preferences/${short(volumes[20]!.work)}`;
    const edition = { kind: 'realization', resource: nextText.realization, revision: nextText.revision };
    expect(await json(await call('PUT', childPrefPath,
      { actingSubject: person, expectedVersion: 1, language: 'zh-Hant', edition }), 409))
      .toMatchObject({ code: 'stale_edition_preference', current: null });
    expect(await json(await call('PUT', childPrefPath,
      { actingSubject: person, expectedVersion: 0, language: 'zh-Hant', edition }))).toMatchObject({ edition });
    expect(await json<Summary>(await summary())).toMatchObject({
      next: { part: { displayLabel: '21' }, reason: 'next_available_required_part' },
      primaryAction: { work: volumes[20]!.work, edition, language: 'zh-Hant' } });
    const omnibus = await json<SessionState>(await finish(release), 201);
    expect(omnibus.selections[0]?.target.revision).toBe(savedRelease.revision);
    const complete = await json<Summary>(await summary());
    expect(complete).toMatchObject({ counts: { completed: 24, completedRequired: 22 },
      states: { caughtUpWithAvailableMaterial: true, finishedPublishedParts: true, seriesConcluded: true },
      furthestCompleted: { part: { displayLabel: 'SS2' }, locator: null }, next: null });
    expect(complete.revisions.selections).toContainEqual({ resource: release, revision: savedRelease.revision });
    const releasePreferenceKey = randomUUID();
    const releasePreferencePath = `/v1/me/edition-preferences/${short(volumes[0]!.work)}`;
    const releasePreference = { actingSubject: person, language: 'zh-Hant', expectedVersion: 0,
      edition: { kind: 'release', resource: release, revision: savedRelease.revision } };
    await json(await call('PUT', releasePreferencePath, releasePreference, releasePreferenceKey));
    await json(await call('PUT', releasePath, { ...releaseBody, expectedHead: savedRelease.revision,
      publisher: 'Corrected imprint', evidence: id() }));
    expect((await json<Summary>(await summary())).revisions.selections)
      .toContainEqual({ resource: release, revision: savedRelease.revision });
    expect(await json(await call('PUT', releasePreferencePath, releasePreference, releasePreferenceKey)))
      .toMatchObject({ version: 1, replayed: true, edition: releasePreference.edition });
    // Native G-833 realizations are admitted by the generic Session resolver.
    const exact = await json<SessionState>(await finish(coverage[0]!.realization), 201);
    expect(exact.target).toMatchObject({ base: 'realization', work: volumes[0]!.work, revision: coverage[0]!.revision });
    expect((await json<Summary>(await summary())).counts.completed).toBe(24);
    let located = await json<SessionState>(await call('POST', '/v1/me/sessions', {
      actingSubject: person, target: coverage[23]!.realization, expectedVersion: 0, state: 'active' }), 201);
    for (const value of [120, 5]) located = await json<SessionState>(await call('PATCH', `/v1/me/sessions/${short(located.id)}`, {
      actingSubject: person, expectedVersion: located.version, position: { target: coverage[23]!.realization, unit: 'page', value } }));
    await json(await call('PATCH', `/v1/me/sessions/${short(located.id)}`, {
      actingSubject: person, expectedVersion: located.version, state: 'finished' }));
    expect((await json<Summary>(await summary())).furthestCompleted?.locator)
      .toMatchObject({ target: coverage[23]!.realization, unit: 'page', current: 5, furthest: 120 });
    const chapterComposition = await json<Composition>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: volumes[23]!.work, mainVersion: volumes[23]!.mainVersion, actingSubject: person }), 201);
    const chapters = await json<Composition>(await call('POST', `/v1/compositions/${short(chapterComposition.structure)}/changes`, {
      profile: 'book-composition', actingSubject: person, expectedHead: chapterComposition.revision,
      operations: [1, 2].map(n => ({ op: 'insert', role: 'chapter', parent: chapterComposition.structure,
        position: 'last', target: 'https://schema.org/DigitalDocument', label: { value: `Chapter ${n}`, language: 'en' } })) }));
    await json(await call('POST', '/v1/me/sessions', { actingSubject: person,
      target: chapters.occurrences[1]!, expectedVersion: 0, state: 'finished',
      addSelections: [{ target: chapters.occurrences[1]!, language: 'ja' }] }), 201);
    const boundary = await json<Summary>(await summary());
    expect(boundary.counts.completed).toBe(24);
    expect(boundary.furthestCompleted?.occurrence).toEqual({ resource: chapters.occurrences[1]!, revision: chapters.revision });
    expect((await call('PUT', childPrefPath, { actingSubject: person, expectedVersion: 1, language: 'en', edition })).status).toBe(400);

    // Partial coverage is visible as unresolved, and does not complete a part.
    const partialRelease = id();
    await json(await call('PUT', `/v1/works/${short(volumes[0]!.work)}/releases/${short(partialRelease)}`,
      { ...releaseBody, id: partialRelease, coverage: [{ ...coverage[0]!, completeness: 'partial' }] }));
    await json(await finish(partialRelease), 201);
    expect((await json<Summary>(await summary())).states.correspondenceUnresolved).toBe(true);

    // A rewrite's completion never transfers, even if the client knows a correspondence.
    const spider = await work('Book Spider'), web = await work('Web Spider'), bookPart = await work('Book Spider volume');
    const spiderComposition = await json<Composition>(await call('POST', '/v1/compositions',
      { profile: 'work-composition', work: spider.work, mainVersion: spider.mainVersion, actingSubject: person }), 201);
    await json(await call('POST', `/v1/compositions/${short(spiderComposition.structure)}/changes`, {
      profile: 'work-composition', actingSubject: person, expectedHead: spiderComposition.revision,
      operations: [{ op: 'insert', role: 'part', parent: spiderComposition.structure, position: 'last',
        target: bookPart.work, displayLabel: '22 Reverse', inclusion: 'required' }] }));
    await stack.contribution(bookPart.work, person, 'zh-hant', 'Traditional Chinese book part');
    await json(await finish(web.work), 201);
    const webSummary = await json<Summary>(await call('GET', `/v1/me/progress-summaries/${short(spider.work)}?actingSubject=${encodeURIComponent(person)}&language=zh-Hant`));
    expect(webSummary.counts.completed).toBe(0);
    expect(webSummary.next).toMatchObject({ part: { work: bookPart.work, available: true }, reason: 'next_available_required_part' });
    for (const option of ['sessionLimit', 'releaseLimit']) expect((await summary(`&${option}=1`)).status).toBe(400);

    // Unreadable uses do not contribute identifiers, labels, counts or next.
    const hidden = await stack.privateWork(person, 'Private volume');
    await grant(`work:edit:${hidden.work}`, 'work.edit');
    await grant(`work:read:${hidden.work}`, 'work.read');
    composition = await json<Composition>(await call('POST', `/v1/compositions/${short(composition.structure)}/changes`, {
      profile: 'work-composition', actingSubject: person, expectedHead: composition.revision,
      operations: [{ op: 'insert', role: 'part', parent: composition.structure, position: 'last',
        target: hidden.work, displayLabel: 'Secret part', inclusion: 'required' }] }));
    for (const resource of [original.work, ...volumes.map(volume => volume.work)]) {
      await grant(`work:read:${resource}`, 'work.read', other, b.principalId);
    }
    const observer = await json<Summary>(await call('GET', `/v1/me/progress-summaries/${short(original.work)}?actingSubject=${encodeURIComponent(other)}&language=zh-Hant`,
      undefined, randomUUID(), b.token));
    expect(observer.counts.required).toBe(22);
    expect(JSON.stringify(observer)).not.toContain(hidden.work);
    expect(JSON.stringify(observer)).not.toContain('Secret part');
    expect((await call('GET', summaryPath, undefined, randomUUID(), '')).status).toBe(401);
    expect((await call('GET', summaryPath, undefined, randomUUID(), b.token)).status).toBe(403);
    expect((await call('GET', `${prefPath}?actingSubject=${encodeURIComponent(person)}`, undefined, randomUUID(), b.token)).status).toBe(403);
    expect((await call('PUT', prefPath, { actingSubject: a.actor, expectedVersion: 0, language: 'en', edition: null })).status).toBe(403);

    // One batched Content read and seek continuation on a large history.
    for (let n = 0; n < SERIES_COST.sessions; n++) await json(await finish(volumes[0]!.work), 201);
    const owner = { principal: { ...a.principal, emailVerified: true }, agent: person };
    const graph = complete.revisions.graph;
    const query = stack.contentPool.query.bind(stack.contentPool);
    let statements = 0;
    stack.contentPool.query = ((...args: Parameters<typeof query>) => { statements++; return query(...args); }) as typeof stack.contentPool.query;
    let batch;
    try { batch = await series.batch(owner, [original.work, ...volumes.map(volume => volume.work)], [release], graph);
      expect(statements).toBe(SERIES_COST.sessionSql); }
    finally { stack.contentPool.query = query; }
    expect(batch.items).toHaveLength(SERIES_COST.sessions);
    expect(batch.next).toBeTruthy();
    const tail = await series.batch(owner, [original.work, ...volumes.map(volume => volume.work)], [release], graph, batch.next!);
    expect(new Set([...batch.items, ...tail.items].map(item => item.id)).size).toBe(batch.items.length + tail.items.length);
    expect(await json<Summary>(await summary())).toMatchObject({ partial: true, next: null, primaryAction: null,
      states: { caughtUpWithAvailableMaterial: null, finishedPublishedParts: null } });

    let writeSql = 0;
    const countedPool = { connect: async () => {
      const client = await stack.contentPool.connect(); const query = client.query.bind(client);
      return { query: (...args: unknown[]) => { writeSql++; return Reflect.apply(query, client, args); },
        release: () => client.release() } as unknown as PoolClient;
    } } as unknown as Pool;
    await new EditionPreferenceStore(countedPool).write(owner, volumes[1]!.work,
      { language: 'zh-Hant', edition: null }, 0, randomUUID(), async () => {});
    expect(writeSql).toBeLessThanOrEqual(EDITION_PREFERENCE_COST.writeSql);
    const rollbackKey = randomUUID();
    await expect(preferences.write(owner, volumes[1]!.work, { language: 'en', edition: null }, 1,
      rollbackKey, async () => { throw new Error('Revoked own-person authority'); })).rejects.toThrow('Revoked');
    expect((await preferences.read(owner, volumes[1]!.work))?.version).toBe(1);
    await expect(preferences.write(owner, volumes[1]!.work, { language: 'en', edition: null }, 0,
      randomUUID(), async () => { throw new Error('Revoked before stale disclosure'); })).rejects.toThrow('Revoked before stale disclosure');
    expect((await stack.contentPool.query('SELECT 1 FROM reader.edition_preference_command WHERE idempotency_key = $1', [rollbackKey])).rows).toEqual([]);
    const originalWrite = preferences.write.bind(preferences);
    preferences.write = async () => { throw { code: '55P03' }; };
    try { expect((await pref('zh-Hant', 2)).status).toBe(503); }
    finally { preferences.write = originalWrite; }
    expect((await summary()).headers.get('cache-control')).toBe('private, no-store');
    const originalBatch = preferences.batch.bind(preferences);
    preferences.batch = async (...args) => {
      const result = await originalBatch(...args);
      await stack.accessPool.query(`UPDATE access.representation SET active = false
        WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`, [a.principalId, person]);
      return result;
    };
    expect((await summary()).status).toBe(403);
  } finally { await stack.stop(); }
}, 600_000);
