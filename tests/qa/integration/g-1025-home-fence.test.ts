import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { RankingHomeTrendingReader } from '../../../services/main/src/modules/feed/trending.ts';
import { ReadRankingProjection } from '../../../services/main/src/modules/rankings/projection.ts';
import { ControlDenied, ControlUnavailable } from '../../../services/main/src/modules/access/topology-control.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { meterStatements, startHomeStack } from './feed-read-support.ts';

test('G1025: closing Home fences seek one revision at exclusion scales and retain authority/recovery checks', async () => {
  const home = await startHomeStack('g-1025-fence', { projectionStart: 'current' });
  try {
    const reader = await home.provision('Home fence reader', home.reader.token);
    const principal = { ...home.reader.principal, emailVerified: true };
    const store = home.deps.homePersonal;
    expect(await store.fence(principal, reader)).toEqual({ revision: null });
    const meter = meterStatements();
    try {
      let inserted = 0;
      for (const exclusions of [4, 16, 64]) {
        for (; inserted < exclusions; inserted++) {
          await home.json(await home.call('PUT', `/v1/me/continue/${randomUUID()}/hidden`, {
            actingSubject: reader, hidden: true }, home.reader.token));
        }
        const state = await store.read(principal, reader);
        expect(state.exclusions).toHaveLength(exclusions);
        const before = meter.count();
        const fenced = await store.fence(principal, reader);
        expect(fenced).toEqual({ revision: state.revision });
        expect(meter.count() - before).toBe(8);
        // This is a real indexed owner query, not a simulated scan counter.
        const explained = (await home.stack.accessPool.query<{ 'QUERY PLAN': {
          Plan: { 'Actual Rows': number; 'Actual Loops': number } }[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON, TIMING OFF)
            SELECT revision FROM access.home_state WHERE principal_id = $1`, [home.reader.principalId])).rows[0]!['QUERY PLAN'][0]!.Plan;
        expect(explained['Actual Rows']).toBe(1);
        expect(explained['Actual Loops']).toBe(1);
      }
      expect(meter.violations).toEqual([]);
    } finally { meter.restore(); }

    const state = await store.read(principal, reader);
    await home.json(await home.call('PUT', '/v1/me/feed-preferences', { actingSubject: reader,
      expectedRevision: state.revision, preferences: { ...state.preferences, contentLanguages: ['ja'] } }, home.reader.token));
    expect((await store.fence(principal, reader)).revision).not.toBe(state.revision);
    await expect(store.fence({ ...principal, emailVerified: false }, reader)).rejects.toBeInstanceOf(ControlDenied);
    await expect(store.fence(principal, `https://rezics.com/id/${randomUUID()}`)).rejects.toBeInstanceOf(ControlDenied);
    await home.stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    try { await expect(store.fence(principal, reader)).rejects.toBeInstanceOf(ControlUnavailable); }
    finally { await home.stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id'); }
    await home.stack.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [home.reader.principalId]);
    try { await expect(store.fence(principal, reader)).rejects.toBeInstanceOf(ControlDenied); }
    finally { await home.stack.accessPool.query('UPDATE access.principal SET active = true WHERE id = $1', [home.reader.principalId]); }
    expect(await store.fence(principal, reader)).toEqual({ revision: (await store.read(principal, reader)).revision });
  } finally { await home.stop(); }
}, 120_000);

test('G1025: Feed, head, Continue and trending restart after an intervening Home change without reloading exclusions', async () => {
  const home = await startHomeStack('g-1025-fence-race', { projectionStart: 'current' });
  try {
    const author = await home.provision('Home race author', home.author.token);
    const reader = await home.provision('Home race reader', home.reader.token);
    const api = workProfileCorpusApi('http://main.local', home.author.token, {
      fetch: ((input, init) => home.app.handle(new Request(input, init))) as typeof fetch,
    });
    const work = await seedPublicProfileWork(api, 'g1025:race:work', { actingSubject: author,
      title: 'Home fence race Work', body: 'A public Work for the fence race' });
    await home.project();
    const state = await home.deps.homePersonal.read({ ...home.reader.principal, emailVerified: true }, reader);
    await home.json(await home.call('PUT', '/v1/me/feed-preferences', { actingSubject: reader,
      expectedRevision: state.revision, preferences: { ...state.preferences, tab: 'all', recommendations: false } }, home.reader.token));
    const projection = new ReadRankingProjection(home.stack.accessPool, home.stack.content,
      home.stack.contentPool, home.stack.env);
    await projection.tick();
    const app = createMainApp(home.stack.fuseki, { ...home.deps,
      homeTrending: new RankingHomeTrendingReader(projection) });
    const request = (path: string) => app.handle(new Request(`http://main.local${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(reader)}`,
      { headers: { authorization: `Bearer ${home.reader.token}` } }));
    const owner = home.deps.homePersonal;
    const originalRead = owner.read.bind(owner), originalFence = owner.fence.bind(owner);
    for (const path of ['/v1/feed?scope=all&sort=best', '/v1/feed?scope=all&sort=new',
      '/v1/feed/head?scope=all&after=0', '/v1/me/continue', '/v1/trending?scope=global']) {
      let fullReads = 0, fences = 0;
      owner.read = async (...args) => {
        fullReads++;
        const opened = await originalRead(...args);
        // Complete a real public command between the opening read and its fence.
        if (fullReads === 1) await home.json(await home.call('PUT', `/v1/me/continue/${work.work.slice(-36)}/hidden`, {
          actingSubject: reader, hidden: true }, home.reader.token));
        return opened;
      };
      owner.fence = async (...args) => { fences++; return originalFence(...args); };
      try {
        const response = await request(path);
        await response.text();
        expect({ path, status: response.status, fullReads, fences }).toEqual({ path, status: 200, fullReads: 2, fences: 2 });
      } finally { owner.read = originalRead; owner.fence = originalFence; }
      expect((await request(path)).status).toBe(200);
    }
  } finally { await home.stop(); }
}, 120_000);
