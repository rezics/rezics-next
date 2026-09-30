import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ReaderLibraryStatusStore, type StatusState } from '../../../services/main/src/modules/library/status.ts';
import { ConsumptionSessionStore } from '../../../services/main/src/modules/session/store.ts';
import { SESSION_COST, type SessionState } from '../../../services/main/src/modules/session/contract.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
type Saved = SessionState & { replayed: boolean };
type Page = { items: SessionState[]; nextCursor: string | null };
async function json<T>(response: Response, status: number): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('G-834: private exact-target attempts survive lifecycle, formats, races, replay, projection rollback and exhaustive traversal', async () => {
  const preparation = Date.now();
  const stack = await startMediaStack('g-834-session');
  try {
    const a = await stack.member('reader-a'), b = await stack.member('reader-b');
    const library = new ReaderLibraryStatusStore(stack.contentPool);
    const sessions = new ConsumptionSessionStore(stack.contentPool, library);
    const structureObjects = stack.objects('semantic/structure/');
    await structureObjects.initialize();
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      libraryStatus: library, sessions, media: stack.media, mediaAccess: stack.mediaAccess, structureObjects,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const member = [a, b].find(member => member.token === token);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        return { ...member.principal, emailVerified: true };
      } } });
    const call = (method: string, path: string, body?: object, key = randomUUID(), token = a.token) => app.handle(new Request(
      `http://main.local${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        'idempotency-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const provision = async (token: string, kind: 'person' | 'service' = 'person') => json<{ agent: string }>(
      await call('POST', '/v1/agents', { profile: 'agent-provision-v1', kind, displayName: `Session ${kind}` }, randomUUID(), token), 201);
    const person = (await provision(a.token)).agent;
    const other = (await provision(b.token)).agent;
    const service = (await provision(a.token, 'service')).agent;
    const base = '/v1/me/sessions';
    const create = (target: string, changes: object = {}, key = randomUUID()) => call('POST', base,
      { actingSubject: person, target, expectedVersion: 0, ...changes }, key);
    const patch = (saved: SessionState, changes: object, key = randomUUID()) => call('PATCH', `${base}/${saved.id.slice(-36)}`,
      { actingSubject: person, expectedVersion: saved.version, ...changes }, key);
    const page = async (target?: string, cursor?: string | null, limit = 20, token = a.token, agent = person) => {
      const query = new URLSearchParams({ actingSubject: agent, limit: String(limit),
        ...(target ? { target } : {}), ...(cursor ? { cursor } : {}) });
      return call('GET', `${base}?${query}`, undefined, randomUUID(), token);
    };
    const target = await stack.publicWork(person, ['en'], 'Consumption Work');
    const legacy = await stack.publicWork(person, ['en'], 'Legacy status without attempts');
    const putStatus = (changes: object, key = randomUUID()) => call('PUT',
      `/v1/works/${target.work.slice(-36)}/reader-status`, { actingSubject: person, ...changes }, key);
    const shelfSnapshot = async () => ({
      row: (await stack.contentPool.query(`SELECT status, started_on::text, finished_on::text,
        version::text, changed_at::text, session_projection FROM reader.library_status WHERE agent = $1 AND work = $2`,
      [person, target.work])).rows[0],
      commands: (await stack.contentPool.query(`SELECT count(*)::text AS count FROM reader.library_status_command
        WHERE agent = $1`, [person])).rows[0],
      sourceFence: (await stack.contentPool.query('SELECT revision::text FROM reader.also_enjoyed_source_fence WHERE id')).rows[0],
      shelfFence: await library.fence(person),
    });
    await library.write({ agent: person, work: legacy.work, status: 'read', startedOn: '2025-02-01',
      finishedOn: '2025-02-28', expectedVersion: 0, idempotencyKey: randomUUID() });
    expect(await json<Page>(await page(legacy.work), 200)).toEqual({ items: [], nextCursor: null });
    expect((await library.batch(person, [legacy.work]))[0]).toMatchObject({ status: 'read', version: 1 });
    expect(Date.now() - preparation).toBeLessThan(600_000);

    const startKey = randomUUID();
    const planned = await json<Saved>(await create(target.work, { startedOn: '2026-09' }, startKey), 201);
    expect(planned).toMatchObject({ state: 'planned', startedOn: '2026-09', finishedOn: null,
      completedAt: null, version: 1, target: { resource: target.work, base: 'work', work: target.work } });
    expect(planned.target.revision).toMatch(/^https:\/\/rezics.com\/id\//);
    expect((await library.batch(person, [target.work]))[0]).toMatchObject({ status: 'want-to-read', startedOn: null });
    let attempt: Saved = planned;
    const plannedShelf = await shelfSnapshot();
    attempt = await json<Saved>(await patch(attempt, { startedOn: '2026' }), 200);
    expect(await shelfSnapshot()).toEqual(plannedShelf);
    attempt = await json<Saved>(await patch(attempt, { startedOn: '2026-09' }), 200);
    expect(await shelfSnapshot()).toEqual(plannedShelf);
    for (const state of ['active', 'paused', 'active', 'dnf']) {
      const previous = attempt;
      const shelfBefore = await shelfSnapshot();
      attempt = await json<Saved>(await patch(attempt, { state }), 200);
      expect(attempt).toMatchObject({ state, startedOn: '2026-09', finishedOn: null, completedAt: null });
      expect((await library.batch(person, [target.work]))[0]?.status).toBe(state === 'dnf' ? null : 'reading');
      if (state === 'paused' || previous.state === 'paused') expect(await shelfSnapshot()).toEqual(shelfBefore);
    }
    expect((await patch(attempt, { state: 'active' })).status).toBe(400);
    // Re-adding a DNF'd Work is a new Library statement, not a new attempt.
    const dnfShelf = await shelfSnapshot();
    const dnfHistory = await json<Page>(await page(target.work), 200);
    expect(dnfShelf.row).toMatchObject({ status: null, session_projection: attempt.id });
    const readded = await json<StatusState>(await putStatus({ status: 'want-to-read',
      expectedVersion: Number(dnfShelf.row!.version) }), 200);
    expect(readded).toMatchObject({ status: 'want-to-read', version: Number(dnfShelf.row!.version) + 1 });
    const readdedShelf = await shelfSnapshot();
    expect(readdedShelf.row!.session_projection).toBeNull();
    expect(await json<Page>(await page(target.work), 200)).toEqual(dnfHistory);
    expect(await json<{ code: string }>(await putStatus({ status: 'read',
      expectedVersion: Number(dnfShelf.row!.version) }), 409)).toMatchObject({ code: 'stale_reader_status' });
    expect(await shelfSnapshot()).toEqual(readdedShelf);
    const reread = await json<Saved>(await create(target.work, { state: 'active' }), 201);
    expect(reread.id).not.toBe(attempt.id);
    expect(reread).toMatchObject({ startedOn: null, finishedOn: null, completedAt: null });
    expect(reread.selections[0]?.progress).toBe('structure');
    expect((await patch(reread, { position: { target: target.work, unit: 'page', value: 3 } })).status).toBe(400);
    // Editing a historical attempt never replaces the latest attempt's shelf.
    attempt = await json<Saved>(await patch(attempt, { startedOn: '2026' }), 200);
    expect((await library.batch(person, [target.work]))[0]?.status).toBe('reading');
    const finished = await json<Saved>(await patch(reread, { state: 'finished' }), 200);
    expect(finished).toMatchObject({ state: 'finished', startedOn: null, finishedOn: null });
    expect(finished.completedAt).toBeTruthy();
    expect((await library.batch(person, [target.work]))[0]).toMatchObject({ status: 'read', startedOn: null, finishedOn: null });
    expect((await patch(finished, { state: 'active' })).status).toBe(400);
    const [projected] = await library.batch(person, [target.work]);
    const historyBeforeQuickEdit = await json<Page>(await page(target.work), 200);
    const quickKey = randomUUID();
    const quickIntent = { status: 'want-to-read', startedOn: '2026-08-01', finishedOn: '2026-08-31',
      expectedVersion: projected!.version };
    const quick = await json<StatusState & { replayed: boolean }>(await putStatus(quickIntent, quickKey), 200);
    expect(quick).toMatchObject({ status: 'want-to-read', startedOn: '2026-08-01', finishedOn: '2026-08-31',
      version: projected!.version + 1, replayed: false });
    expect((await shelfSnapshot()).row!.session_projection).toBeNull();
    expect(await json<Page>(await page(target.work), 200)).toEqual(historyBeforeQuickEdit);
    expect(await json<{ code: string }>(await putStatus({ status: 'read', expectedVersion: projected!.version }), 409))
      .toMatchObject({ code: 'stale_reader_status' });
    expect(await json<StatusState & { replayed: boolean }>(await putStatus(quickIntent, quickKey), 200))
      .toEqual({ ...quick, replayed: true });
    // Replay returns its immutable original result even after several later edits.
    expect(await json<Saved>(await create(target.work, { startedOn: '2026-09' }, startKey), 201))
      .toEqual({ ...planned, replayed: true });
    expect((await create(target.work, {}, startKey)).status).toBe(409);
    const sameKey = randomUUID();
    const retries = await Promise.all([create(target.work, {}, sameKey), create(target.work, {}, sameKey)]);
    const retryStates = await Promise.all(retries.map(response => json<Saved>(response, 201)));
    expect(retryStates[0]!.id).toBe(retryStates[1]!.id);
    expect(retryStates.map(state => state.replayed).sort()).toEqual([false, true]);

    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), a.principalId, person, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), person, scope, action]);
    };
    await grant(`work:edit:${target.work}`, 'work.edit');
    const release = async (title: string) => {
      const release = id();
      return json<{ release: string; revision: string }>(await call('PUT',
        `/v1/works/${target.work.slice(-36)}/releases/${release.slice(-36)}`, {
          profile: 'release-v1', expectedHead: null, actingSubject: person, id: release,
          kind: 'formal', status: 'official', contentLanguages: ['en'], isTranslation: false,
          originalLanguages: [], titleLanguage: 'en', tracklistLanguage: null,
          title: { value: title, language: 'en' }, editionStatement: null, publisher: 'Session Press',
          publicationYear: 2026, isbn13: null, originalUrl: null, fixedRelease: null,
          coverage: null, evidence: null }), 200);
    };
    const print = await release('Print edition'), audio = await release('Audio edition');
    let mixed = await json<Saved>(await create(target.work, { state: 'active', startedOn: '2026-09-01' }), 201);
    const shelfBeforeSelections = await shelfSnapshot();
    mixed = await json<Saved>(await patch(mixed, {
      addSelections: [{ target: print.release, format: 'print', language: 'en' },
        { target: audio.release, format: 'audio', language: 'en' }] }), 200);
    expect(mixed.selections.map(selection => selection.target.resource)).toEqual([target.work, print.release, audio.release]);
    expect(mixed.selections[1]).toMatchObject({ target: { base: 'release', revision: print.revision }, language: 'en', format: 'print' });
    expect((await patch(mixed, { addSelections: [{ target: print.release, format: 'print', language: 'en' },
      { target: id() }] })).status).toBe(404);
    expect((await create(target.mainVersion)).status).toBe(422);
    mixed = await json<Saved>(await patch(mixed, { addSelections: [{ language: 'en', format: 'print', target: print.release }] }), 200);
    expect(mixed.selections).toHaveLength(3);
    expect(await shelfSnapshot()).toEqual(shelfBeforeSelections);
    const raced = await Promise.all([30, 60].map(value => patch(mixed, { position: { target: print.release, unit: 'page', value } })));
    expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
    const winnerIndex = raced.findIndex(response => response.status === 200);
    const winner = await json<Saved>(raced[winnerIndex]!, 200);
    const loser = await json<{ current: SessionState; submitted: object; code: string }>(raced[1 - winnerIndex]!, 409);
    expect(loser).toMatchObject({ code: 'stale_session', current: { id: mixed.id, version: 4, locators: winner.locators },
      submitted: { expectedVersion: 3, position: { value: [30, 60][1 - winnerIndex] } } });
    mixed = winner;
    // Locator-only updates neither write Library commands nor reveal reading
    // activity through shelf order or invalidate a public shelf's paging fence.
    expect(await shelfSnapshot()).toEqual(shelfBeforeSelections);
    const historyBeforeLocatorQuickEdit = await json<Page>(await page(target.work), 200);
    await json<StatusState>(await putStatus({ status: 'want-to-read',
      expectedVersion: Number(shelfBeforeSelections.row!.version) }), 200);
    expect(await json<Page>(await page(target.work), 200)).toEqual(historyBeforeLocatorQuickEdit);
    const manualShelf = await shelfSnapshot();
    expect(manualShelf.row).toMatchObject({ status: 'want-to-read', session_projection: null });
    const locatorKey = randomUUID();
    const beforeLocator = mixed;
    mixed = await json<Saved>(await patch(mixed, { position: { target: print.release, unit: 'page', value: 80 } }, locatorKey), 200);
    const locatorResult = mixed;
    mixed = await json<Saved>(await patch(mixed, { position: { target: print.release, unit: 'page', value: 5 } }), 200);
    expect(mixed).toMatchObject({ startedOn: '2026-09-01', locators: [{ current: 5, furthest: 80 }] });
    expect(await json<Saved>(await patch(beforeLocator, { position: { target: print.release, unit: 'page', value: 80 } }, locatorKey), 200))
      .toEqual({ ...locatorResult, replayed: true });
    mixed = await json<Saved>(await patch(mixed, { position: { target: audio.release, unit: 'media-time', value: 1200.5 } }), 200);
    expect(await shelfSnapshot()).toEqual(manualShelf);
    mixed = await json<Saved>(await patch(mixed, { state: 'finished', finishedOn: '2026-09-30' }), 200);
    const completedAt = mixed.completedAt;
    const finishedShelf = await shelfSnapshot();
    expect(finishedShelf.row).toMatchObject({ status: 'read', session_projection: mixed.id,
      version: String(Number(manualShelf.row!.version) + 1) });
    mixed = await json<Saved>(await patch(mixed, { state: 'finished' }), 200);
    expect(mixed.completedAt).toBe(completedAt);
    expect(await shelfSnapshot()).toEqual(finishedShelf);
    expect(mixed.locators).toEqual([{ target: print.release, unit: 'page', current: 5, furthest: 80 },
      { target: audio.release, unit: 'media-time', current: 1200.5, furthest: 1200.5 }]);
    expect((await library.batch(person, [target.work]))[0]).toMatchObject({ status: 'read', startedOn: '2026-09-01', finishedOn: '2026-09-30' });
    expect((await patch(mixed, { completed: true, format: 'audio' })).status).toBe(400);
    expect((await patch(mixed, { state: 'owned' })).status).toBe(400);
    expect((await patch(mixed, { position: { target: print.release, unit: 'percentage', value: 10 } })).status).toBe(400);
    expect((await patch(mixed, { startedOn: '2026-10' })).status).toBe(400);
    expect((await patch(mixed, {})).status).toBe(400);
    // Exact release-only targets do not become Work-only attempts.
    const exactRelease = await json<Saved>(await create(print.release), 201);
    expect(exactRelease.target).toMatchObject({ resource: print.release, base: 'release', revision: print.revision });
    expect((await json<Page>(await page(target.work), 200)).items.map(item => item.id)).not.toContain(exactRelease.id);
    expect((await json<Page>(await page(print.release), 200)).items.map(item => item.id)).toEqual([exactRelease.id, mixed.id]);
    // A native realization can be tracked as an attempt, but its hosted text
    // locator is rejected rather than creating a second chapter-progress owner.
    const realization = await json<Saved>(await create(target.variants[0]!.contribution), 201);
    expect(realization.target.base).toBe('realization');
    expect(realization.selections[0]?.progress).toBe('structure');
    expect((await patch(realization, { position: { target: realization.target.resource, unit: 'page', value: 3 } })).status).toBe(400);
    const title = `Hosted chapter boundary ${randomUUID()}`;
    const semanticTypes = ['https://schema.org/Book'];
    const composed = await activateMetadataWork(stack.env, { title, semanticTypes,
      admission: stack.admission(person, 'work:create:root', 'work.create', metadataWorkRequestDigest(title, semanticTypes)) });
    await grant(`work:edit:${composed.work}`, 'work.edit');
    await grant(`work:read:${composed.work}`, 'work.read');
    const composition = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions',
      { profile: 'book-composition', work: composed.work, mainVersion: composed.mainVersion, actingSubject: person }), 201);
    const placed = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `/v1/compositions/${composition.structure.slice(-36)}/changes`, { profile: 'book-composition',
        expectedHead: composition.revision, actingSubject: person,
        operations: [{ op: 'insert', parent: composition.structure, position: 'last', role: 'chapter',
          target: 'https://schema.org/DigitalDocument', label: { value: 'Chapter', language: 'en' } }] }), 200);
    const occurrence = placed.occurrences[0]!;
    const part = await json<Saved>(await create(occurrence), 201);
    expect(part.target).toMatchObject({ resource: occurrence, base: 'occurrence', work: composed.work, revision: placed.revision });
    expect(part.selections[0]?.progress).toBe('structure');
    expect((await patch(part, { position: { target: occurrence, unit: 'percentage', value: 100 } })).status).toBe(400);
    expect((await stack.contentPool.query('SELECT 1 FROM structure.progress WHERE occurrence = $1', [occurrence])).rows).toEqual([]);

    // Atomic projection failures leave neither an attempt nor a command receipt.
    const originalWrite = library.write.bind(library);
    const failureKey = randomUUID();
    const count = async () => Number((await stack.contentPool.query<{ count: string }>(
      'SELECT count(*)::text FROM reader.consumption_session WHERE principal_subject = $1', [a.principal.subject])).rows[0]!.count);
    const before = await count();
    const shelfBefore = await library.batch(person, [target.work]);
    library.write = async () => { throw new Error('Injected projection outage'); };
    try { expect((await create(target.work, { state: 'active' }, failureKey)).status).toBe(503); }
    finally { library.write = originalWrite; }
    expect(await count()).toBe(before);
    expect(await library.batch(person, [target.work])).toEqual(shelfBefore);
    expect((await stack.contentPool.query('SELECT 1 FROM reader.consumption_session_command WHERE idempotency_key = $1', [failureKey])).rows).toEqual([]);
    expect((await create(target.work, { state: 'active' }, failureKey)).status).toBe(201);

    // Fifty is a request bound, never a total-inventory bound. Seek traversal
    // remains complete after an older attempt is edited between pages.
    const allBefore = await count();
    for (let index = 0; index < 55; index++) expect((await create(target.work)).status).toBe(201);
    expect((await library.batch(person, [target.work]))[0]?.status).toBe('want-to-read');
    const first = await json<Page>(await page(undefined, undefined, SESSION_COST.page), 200);
    expect(first.items).toHaveLength(SESSION_COST.page);
    expect(first.nextCursor).toBeTruthy();
    await json<Saved>(await patch(attempt, { startedOn: null }), 200);
    const seen = first.items.map(item => item.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await json<Page>(await page(undefined, cursor, SESSION_COST.page), 200);
      seen.push(...next.items.map(item => item.id)); cursor = next.nextCursor;
    }
    expect(seen).toHaveLength(allBefore + 55);
    expect(new Set(seen).size).toBe(seen.length);
    expect((await page(target.work, first.nextCursor)).status).toBe(400);
    expect((await page(undefined, first.nextCursor, 50, b.token, other)).status).toBe(400);
    const filtered = await json<Page>(await page(target.work, undefined, 50), 200);
    expect(filtered.nextCursor).toBeTruthy();
    expect((await page(print.release, filtered.nextCursor)).status).toBe(400);
    const filteredIds = filtered.items.map(item => item.id);
    cursor = filtered.nextCursor;
    while (cursor) {
      const next = await json<Page>(await page(target.work, cursor, 50), 200);
      filteredIds.push(...next.items.map(item => item.id)); cursor = next.nextCursor;
    }
    const exactCount = (await stack.contentPool.query<{ count: string }>(`SELECT count(*)::text
      FROM reader.consumption_session_target WHERE principal_subject = $1 AND resource = $2`,
    [a.principal.subject, target.work])).rows[0]!.count;
    expect(filteredIds).toHaveLength(Number(exactCount));
    expect(new Set(filteredIds).size).toBe(filteredIds.length);
    expect((await page(undefined, 'malformed')).status).toBe(400);
    expect((await page(undefined, undefined, 51)).status).toBe(400);
    const pageQuery = stack.contentPool.query.bind(stack.contentPool);
    let reads = 0;
    stack.contentPool.query = ((...args: Parameters<typeof pageQuery>) => {
      reads++; return pageQuery(...args);
    }) as typeof stack.contentPool.query;
    try { await json<Page>(await page(print.release), 200); expect(reads).toBe(SESSION_COST.pageSql); }
    finally { stack.contentPool.query = pageQuery; }
    const plan = await stack.contentPool.query(`EXPLAIN (FORMAT JSON) SELECT state FROM reader.consumption_session
      WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND attempt_order < 10
      ORDER BY attempt_order DESC LIMIT 5`, [a.principal.issuer, a.principal.subject, person]);
    expect(JSON.stringify(plan.rows)).toContain('consumption_session_inventory');
    // Exercise the actual Content owner transaction with a counted real SQL
    // connection. Large existing history does not add statements to a write.
    let statements = 0;
    const countedPool = { connect: async () => {
      const client = await stack.contentPool.connect();
      const query = client.query.bind(client);
      return { query: (...args: unknown[]) => { statements++; return Reflect.apply(query, client, args); },
        release: () => client.release() } as unknown as PoolClient;
    } } as unknown as Pool;
    const countedStore = new ConsumptionSessionStore(countedPool, library);
    const assertOwner = async () => {
      expect(await stack.access.canReadAsBaselineMember({ ...a.principal, emailVerified: true }, person)).toBe(true);
    };
    const measured = await countedStore.write({ principal: a.principal, agent: person, target: target.work,
      changes: {}, expectedVersion: 0, idempotencyKey: randomUUID() }, async () => planned.selections, assertOwner);
    expect(statements).toBeLessThanOrEqual(SESSION_COST.writeSql);
    statements = 0;
    await countedStore.write({ principal: a.principal, agent: person, id: measured.id,
      changes: { state: 'active' }, expectedVersion: 1, idempotencyKey: randomUUID() }, async () => [], assertOwner);
    expect(statements).toBeLessThanOrEqual(SESSION_COST.writeSql);

    for (const agent of [a.actor, service]) {
      expect((await call('POST', base, { actingSubject: agent, target: target.work, expectedVersion: 0 })).status).toBe(403);
      expect((await call('GET', `${base}?actingSubject=${encodeURIComponent(agent)}`)).status).toBe(403);
      expect((await call('PATCH', `${base}/${mixed.id.slice(-36)}`, { actingSubject: agent, expectedVersion: mixed.version, state: 'finished' })).status).toBe(403);
    }
    expect((await page(undefined, undefined, 20, b.token, person)).status).toBe(403);
    expect((await call('PATCH', `${base}/${mixed.id.slice(-36)}`,
      { actingSubject: other, expectedVersion: mixed.version, state: 'finished' }, randomUUID(), b.token)).status).toBe(404);
    expect((await call('GET', `${base}?actingSubject=${encodeURIComponent(person)}`, undefined, randomUUID(), '')).status).toBe(401);
    await expect(stack.contentPool.query(`UPDATE reader.consumption_session_command SET result = '{}'::jsonb
      WHERE principal_subject = $1`, [a.principal.subject])).rejects.toMatchObject({ code: '23514' });

    const revoke = async () => stack.accessPool.query(`UPDATE access.representation SET active = false
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`, [a.principalId, person]);
    const authorityKey = randomUUID();
    const beforeRevoke = await count();
    library.write = async (...args) => { const result = await originalWrite(...args); await revoke(); return result; };
    try {
      expect((await create(target.work, { state: 'active' }, authorityKey)).status).toBe(403);
      expect(await count()).toBe(beforeRevoke);
      expect((await create(target.work, { startedOn: '2026-09' }, startKey)).status).toBe(403);
      expect((await page()).status).toBe(403);
    } finally { library.write = originalWrite; }
    expect((await stack.contentPool.query('SELECT 1 FROM reader.consumption_session_command WHERE idempotency_key = $1', [authorityKey])).rows).toEqual([]);
    expect((await library.batch(person, [legacy.work]))[0]).toMatchObject({ status: 'read', version: 1,
      startedOn: '2025-02-01', finishedOn: '2025-02-28' });
  } finally { await stack.stop(); }
}, 240_000);
