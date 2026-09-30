import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import * as fc from 'fast-check';
import { treaty } from '@elysia/eden';
import { createReaderStore } from '../../../apps/web/features/catalogue/reader-store.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { ReaderLibraryRatings } from '../../../services/main/src/modules/library/ratings.ts';
import { ReaderLibraryStatusStore, type ReadingStatus, type StatusState }
  from '../../../services/main/src/modules/library/status.ts';
import { startMediaStack } from './media-support.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;

test('G-517: reader status keeps omitted dates, clears named dates and preserves old receipts and authority', async () => {
  const stack = await startMediaStack('g-517-dates');
  try {
    const member = await stack.member('reader');
    const store = new ReaderLibraryStatusStore(stack.contentPool);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      libraryStatus: store, libraryRatings: new ReaderLibraryRatings(stack.accessPool),
      profiles: new ProfilesAccess(stack.accessPool), media: stack.media, mediaAccess: stack.mediaAccess,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      account: { verify: async () => ({ ...member.principal, emailVerified: true }) } });
    const provision = await app.handle(new Request('http://main.local/v1/agents', { method: 'POST',
      headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json',
        'idempotency-key': randomUUID() },
      body: JSON.stringify({ profile: 'agent-provision-v1', displayName: 'Dated reader', kind: 'person' }) }));
    expect(provision.status).toBe(201);
    const { agent } = await provision.json() as { agent: string };
    const { work } = await stack.publicWork(agent, ['en'], 'Recorded reading dates');
    const path = `http://main.local/v1/works/${work.slice(-36)}`;
    const put = (body: { status: ReadingStatus | null; expectedVersion: number;
      startedOn?: string | null; finishedOn?: string | null }, key = randomUUID()) => app.handle(new Request(
      `${path}/reader-status`, { method: 'PUT', headers: { authorization: `Bearer ${member.token}`,
        'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ actingSubject: agent, ...body }) }));
    const read = async () => {
      const response = await app.handle(new Request(`${path}/reader-state?actingSubject=${encodeURIComponent(agent)}`,
        { headers: { authorization: `Bearer ${member.token}` } }));
      expect(response.status).toBe(200);
      return (await response.json() as { status: StatusState }).status;
    };
    const dates = { startedOn: '2026-01-02', finishedOn: '2026-01-20' };
    const oldKey = randomUUID();
    const full = { status: 'read' as const, expectedVersion: 0, ...dates };
    const savedResponse = await put(full, oldKey);
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json() as StatusState & { replayed: boolean };
    expect(saved).toMatchObject({ ...dates, status: 'read', version: 1, replayed: false });
    // Seed the pre-change digest independently of the current implementation.
    const oldDigest = createHash('sha256').update(JSON.stringify([
      work, full.status, full.startedOn, full.finishedOn, full.expectedVersion])).digest('hex');
    await stack.contentPool.query(`UPDATE reader.library_status_command SET request_digest = $3
      WHERE agent = $1 AND idempotency_key = $2`, [agent, oldKey, oldDigest]);

    expect((await put({ status: 'reading', expectedVersion: 1 })).status).toBe(200);
    expect(await read()).toMatchObject({ ...dates, status: 'reading', version: 2 });
    const quickCommands: unknown[] = [];
    const client = treaty(app, { headers: { authorization: `Bearer ${member.token}` }, parseDate: false,
      onRequest: (path, options) => {
        if (path.endsWith('/reader-status') && typeof options.body === 'string') {
          quickCommands.push(JSON.parse(options.body));
        }
      } });
    const quick = createReaderStore({ actingSubject: agent, main: () => client,
      seed: { [work]: { status: 'read', version: 1, rating: null } } });
    // The card/Work adapter retries a stale version without filling in dates it cannot edit.
    expect(await quick.setStatus(work, 'read')).toBe(true);
    expect(await read()).toMatchObject({ ...dates, status: 'read', version: 3 });
    expect(await quick.setStatus(work, 'read')).toBe(true);
    expect(await read()).toMatchObject({ ...dates, status: 'read', version: 4 });
    expect(quickCommands).toEqual([1, 2, 3].map(expectedVersion => ({ actingSubject: agent,
      expectedVersion, status: 'read' })));

    const replay = await put(full, oldKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...saved, replayed: true });
    for (const omitted of [
      { status: 'read' as const, expectedVersion: 0 },
      { status: 'read' as const, expectedVersion: 0, startedOn: dates.startedOn },
      { status: 'read' as const, expectedVersion: 0, finishedOn: dates.finishedOn },
    ]) expect((await put(omitted, oldKey)).status).toBe(409);
    expect(await read()).toMatchObject({ ...dates, version: 4 });

    // Validate the merged pair: an individually valid date cannot precede the retained start.
    expect((await put({ status: 'reading', expectedVersion: 4, finishedOn: '2026-01-01' })).status).toBe(400);
    expect(await read()).toMatchObject({ ...dates, version: 4 });
    await expect(stack.contentPool.query(`UPDATE reader.library_status SET finished_on = '2026-01-01'
      WHERE agent = $1 AND work = $2`, [agent, work])).rejects.toMatchObject({ code: '23514' });

    const concurrent = await Promise.all([
      put({ status: 'reading', expectedVersion: 4 }),
      put({ status: 'want-to-read', expectedVersion: 4 }),
    ]);
    expect(concurrent.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await read()).toMatchObject({ ...dates, version: 5 });
    expect((await put({ status: 'read', expectedVersion: 4, startedOn: null, finishedOn: null })).status).toBe(409);
    expect(await read()).toMatchObject({ ...dates, version: 5 });

    const clearKey = randomUUID();
    const clearStart = { status: 'reading' as const, expectedVersion: 5, startedOn: null };
    expect((await put(clearStart, clearKey)).status).toBe(200);
    expect(await read()).toMatchObject({ status: 'reading', startedOn: null, finishedOn: dates.finishedOn, version: 6 });
    expect((await put(clearStart, clearKey)).status).toBe(200);
    expect((await put({ status: 'reading', expectedVersion: 5 }, clearKey)).status).toBe(409);
    expect((await put({ ...clearStart, finishedOn: null }, clearKey)).status).toBe(409);
    expect((await put({ status: 'want-to-read', expectedVersion: 6, startedOn: dates.startedOn })).status).toBe(200);
    expect(await read()).toMatchObject({ ...dates, status: 'want-to-read', version: 7 });
    expect((await put({ status: null, expectedVersion: 7, finishedOn: null })).status).toBe(200);
    expect(await read()).toMatchObject({ status: null, startedOn: dates.startedOn, finishedOn: null, version: 8 });
    expect((await put({ status: null, expectedVersion: 8, finishedOn: dates.finishedOn })).status).toBe(200);
    const beforeRevocation = await read();
    expect(beforeRevocation).toMatchObject({ ...dates, status: null, version: 9 });

    await stack.accessPool.query(`UPDATE access.representation SET active = false
      WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control'`, [member.principalId, agent]);
    expect((await put({ status: 'read', expectedVersion: 9 })).status).toBe(403);
    expect((await put(full, oldKey)).status).toBe(403);
    expect(await store.batch(agent, [work])).toEqual([beforeRevocation]);
  } finally { await stack.stop(); }
}, 120_000);

test('G-517: empty and invalid reader dates return 400 before accessing owner state', async () => {
  const stack = await startMediaStack('g-517-validation');
  try {
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      libraryStatus: new ReaderLibraryStatusStore(stack.contentPool),
      account: { verify: async () => { throw new Error('Invalid dates must fail before account verification'); } } });
    const actingSubject = id();
    const work = id();
    const results: { field: string; invalid: string; status: number }[] = [];
    for (const field of ['startedOn', 'finishedOn']) {
      for (const invalid of ['', '2026-02-30', '2026-13-01', 'not-a-date']) {
        const response = await app.handle(new Request(`http://main.local/v1/works/${work.slice(-36)}/reader-status`,
          { method: 'PUT', headers: { authorization: 'Bearer reader', 'content-type': 'application/json',
            'idempotency-key': randomUUID() },
          body: JSON.stringify({ actingSubject, status: 'reading', expectedVersion: 0, [field]: invalid }) }));
        results.push({ field, invalid, status: response.status });
      }
    }
    expect(results).toEqual(results.map(result => ({ ...result, status: 400 })));
    expect(await stack.contentPool.query('SELECT 1 FROM reader.library_status WHERE agent = $1', [actingSubject]))
      .toMatchObject({ rows: [] });
  } finally { await stack.stop(); }
}, 120_000);

test('G-517: every omitted date survives arbitrary sequences of status-only store writes', async () => {
  const stack = await startMediaStack('g-517-property');
  try {
    const store = new ReaderLibraryStatusStore(stack.contentPool);
    const day = fc.integer({ min: 0, max: 3652 }).map(offset =>
      new Date(Date.UTC(2020, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10));
    const dates = fc.tuple(day, day, fc.boolean(), fc.boolean()).map(([a, b, hasStart, hasFinish]) => ({
      startedOn: hasStart ? (a < b ? a : b) : null,
      finishedOn: hasFinish ? (a < b ? b : a) : null,
    }));
    const statuses = fc.array(fc.constantFrom<ReadingStatus | null>('want-to-read', 'reading', 'read', null),
      { minLength: 1, maxLength: 20 });
    await fc.assert(fc.asyncProperty(dates, statuses, async (recorded, sequence) => {
      const agent = id();
      const work = id();
      await store.write({ agent, work, status: 'read', ...recorded, expectedVersion: 0,
        idempotencyKey: randomUUID() });
      for (const [index, status] of sequence.entries()) {
        const written = await store.write({ agent, work, status, expectedVersion: index + 1,
          idempotencyKey: randomUUID() });
        expect(written).toMatchObject({ ...recorded, status, version: index + 2 });
        expect(await store.batch(agent, [work])).toEqual([expect.objectContaining({ ...recorded, status,
          version: index + 2 })]);
      }
    }), { seed: 517, numRuns: 50 });
  } finally { await stack.stop(); }
}, 120_000);
