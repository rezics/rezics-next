import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { idOf, runHarness } from './source-run-harness.ts';

type Checkpoint = { seq: number; kind: string; continuity: string; from: string; to: string; itemCount: number;
  observation: string | null };
type Window = { state: string; floor: string | null; checkpoints: Checkpoint[];
  changes: Array<{ position: string; records: string[] }> };
type Feed = { feed: string; head: { seq: number; position: string; resumeToken: string | null } | null;
  openGaps: Array<{ from: string; to: string }>; recent: Checkpoint[] };

test('LIVE12: bootstrap baseline then change windows handle overlap and gaps, resume from frozen pages and stay bounded', async () => {
  const h = await runHarness();
  try {
    h.provider.addChanges(100);
    h.provider.work('OL1W', 1);
    // Changes that land while the bootstrap run is capturing are deliberately re-read later.
    h.provider.afterRequest = path => { if (path === '/recentchanges.json?limit=1') h.provider.addChanges(5); };
    const bootstrap = await h.post('/v1/sources/acquisitions', 'owner', { profile: 'open-library-works-run-v1',
      workIds: ['OL1W'], editions: false, ratings: false, frontier: true }, `bootstrap-${randomUUID()}`);
    h.provider.afterRequest = null;
    const bootstrapRun = (await bootstrap.json() as { run: { run: string; state: string } }).run;
    expect(bootstrapRun.state).toBe('completed');

    const created = await h.post('/v1/sources/feeds', 'owner', { profile: 'open-library-recent-changes-v1', pageItems: 10 });
    expect(created.status).toBe(201);
    const feed = (await created.json() as { feed: Feed }).feed;
    const feedId = idOf(feed.feed);
    expect((await h.post('/v1/sources/feeds', 'owner', { profile: 'open-library-recent-changes-v1', pageItems: 10 })).status)
      .toBe(200);
    expect((await h.post('/v1/sources/feeds', 'owner', { profile: 'open-library-recent-changes-v1', pageItems: 20 })).status)
      .toBe(409);
    const window = (maxPages: number, key = `window-${randomUUID()}`) => h.post(`/v1/sources/feeds/${feedId}/windows`,
      'owner', { profile: 'source-feed-window-v1', maxPages }, key);
    const read = async () => await (await h.get(`/v1/sources/feeds/${feedId}`, 'reader')).json() as Feed;
    expect((await window(1)).status).toBe(409);

    // Only a completed run with a frozen frontier is a baseline.
    const incomplete = await h.post('/v1/sources/acquisitions', 'owner', { profile: 'open-library-works-run-v1',
      workIds: ['OL404W'], editions: false, ratings: false, frontier: true }, `failed-${randomUUID()}`);
    const incompleteRun = (await incomplete.json() as { run: { run: string } }).run.run;
    const baseline = (run: string) => h.post(`/v1/sources/feeds/${feedId}/baselines`, 'owner',
      { profile: 'source-feed-baseline-v1', run });
    expect((await baseline(incompleteRun)).status).toBe(409);
    expect((await baseline(bootstrapRun.run)).status).toBe(201);
    expect((await baseline(bootstrapRun.run)).status).toBe(200);
    expect((await read()).head).toMatchObject({ seq: 1, position: '100' });

    // Overlap: the first window reaches below the baseline frontier and deduplicates it.
    const firstKey = `window-${randomUUID()}`;
    const first = await window(3, firstKey);
    expect(first.status).toBe(201);
    const firstWindow = (await first.json() as { window: Window }).window;
    expect(firstWindow).toMatchObject({ state: 'committed', floor: '100' });
    expect(firstWindow.checkpoints.map(item => [item.continuity, item.from, item.to])).toEqual([['overlap', '96', '105']]);
    expect(firstWindow.changes.map(change => change.position)).toEqual(['101', '102', '103', '104', '105']);
    expect(firstWindow.changes[0]!.records).toEqual(['/works/OL101W']);
    const requests = h.provider.requests.length;
    const replay = await window(3, firstKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ window: firstWindow, replayed: true });
    expect(h.provider.requests.length).toBe(requests);
    const quiet = (await (await window(2)).json() as { window: Window }).window;
    expect(quiet.checkpoints.map(item => item.continuity)).toEqual(['overlap']);
    expect(quiet.changes).toEqual([]);

    // A burst beyond the page budget records an explicit gap instead of silently skipping it.
    h.provider.addChanges(25);
    const burst = (await (await window(2)).json() as { window: Window }).window;
    expect(burst.checkpoints.map(item => [item.continuity, item.from, item.to]))
      .toEqual([['gap', '111', '120'], ['contiguous', '121', '130']]);
    expect(burst.changes.map(change => change.position)).toHaveLength(20);
    expect((await read()).openGaps).toEqual([expect.objectContaining({ from: '106', to: '110' })]);

    // An interrupted window resumes from its frozen pages without refetching them.
    h.provider.addChanges(15);
    h.gate.failAt = h.gate.reserved + 1;
    const resumeKey = `window-${randomUUID()}`;
    expect((await window(3, resumeKey)).status).toBe(429);
    h.gate.failAt = null;
    const beforeResume = h.provider.requests.length;
    const resumed = await window(3, resumeKey);
    expect(resumed.status).toBe(200);
    const resumedWindow = (await resumed.json() as { window: Window }).window;
    expect(h.provider.requests.length - beforeResume).toBe(1);
    expect(resumedWindow.checkpoints.map(item => [item.continuity, item.from, item.to]))
      .toEqual([['overlap', '126', '135'], ['contiguous', '136', '145']]);
    expect((await read()).head).toMatchObject({ position: '145', resumeToken: 'change:145' });

    // Captured but uncommitted pages (a crash between the two phases) commit on retry.
    const services = sourceAcquisitionServices(h.contentPool, { fetcher: h.provider.fetch, reserve: async () => {} });
    h.provider.addChanges(3);
    const crashKey = `window-${randomUUID()}`;
    await services.feeds.captureWindow(h.ownerId, feedId, crashKey, 2);
    expect((await read()).head).toMatchObject({ position: '145' });
    const recovered = (await (await window(2, crashKey)).json() as { window: Window }).window;
    expect(recovered.checkpoints.map(item => [item.continuity, item.to])).toEqual([['overlap', '148']]);

    // A window read against a head that has since moved is stale and appends nothing.
    h.provider.addChanges(2);
    const staleKey = `window-${randomUUID()}`;
    await services.feeds.captureWindow(h.ownerId, feedId, staleKey, 2);
    await window(2);
    const stale = (await (await window(2, staleKey)).json() as { window: Window }).window;
    expect(stale).toMatchObject({ state: 'stale-head', checkpoints: [] });

    // A failed or oversized page records no progress.
    h.provider.addChanges(1);
    const head = (await read()).head;
    h.provider.overrides.set('/recentchanges.json?limit=10&offset=0', () => new Response(
      JSON.stringify([{ id: '999', pad: 'x'.repeat(70_000) }]), { headers: { 'content-type': 'application/json' } }));
    const oversized = (await (await window(2)).json() as { window: Window }).window;
    expect(oversized).toMatchObject({ state: 'failed', checkpoints: [] });
    h.provider.overrides.set('/recentchanges.json?limit=10&offset=0', () => new Response('login', { status: 401 }));
    expect((await (await window(2)).json() as { window: Window }).window.state).toBe('failed');
    h.provider.overrides.clear();
    expect((await read()).head).toEqual(head);

    // A new completed baseline closes every open gap.
    const rebaseline = await h.post('/v1/sources/acquisitions', 'owner', { profile: 'open-library-works-run-v1',
      workIds: ['OL1W'], editions: false, ratings: false, frontier: true }, `bootstrap-${randomUUID()}`);
    expect((await baseline((await rebaseline.json() as { run: { run: string } }).run.run)).status).toBe(201);
    const after = await read();
    expect(after.openGaps).toEqual([]);
    expect(after.head).toMatchObject({ position: '151' });

    // Bounded memory: pages are at most 64 KiB and a window holds at most eight of them.
    expect((await window(9)).status).toBe(400);
    expect((await h.post('/v1/sources/feeds', 'owner', { profile: 'open-library-recent-changes-v1', pageItems: 101 }))
      .status).toBe(400);
    const pages = await h.contentPool.query<{ size: number }>(`SELECT max(octet_length(o.raw_bytes))::int AS size
      FROM source.run_capture c JOIN source.observation o ON o.id = c.observation_id
      JOIN source.feed_checkpoint k ON k.capture_id = c.id WHERE k.feed_id = $1`, [feedId]);
    expect(pages.rows[0]!.size).toBeLessThanOrEqual(65_536);
    expect((await h.get(`/v1/sources/feeds/${feedId}`, 'other')).status).toBe(404);
    expect((await h.post(`/v1/sources/feeds/${feedId}/windows`, 'reader',
      { profile: 'source-feed-window-v1', maxPages: 1 }, `denied-${randomUUID()}`)).status).toBe(401);
  } finally { await h.close(); }
}, 90_000);
