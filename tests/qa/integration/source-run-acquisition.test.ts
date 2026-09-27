import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { idOf, runHarness, type RunHarness } from './source-run-harness.ts';

type Run = { run: string; state: string; completion: { outcome: string } | null;
  surfaces: Array<{ surface: string; outcome: { outcome: string; reason: string; captureCount: number;
    captureSetDigest: string | null } | null; captures: Array<{ requestKey: string; observation: string;
    sourceRevision: string | null; byteLength: number | null; byteDigest: string | null }> }> };
type Drift = { surfaces: Array<{ surface: string; status: string; itemsAdded: number; itemsRemoved: number;
  itemsPaired: number; fields: Array<{ field: string; status: string; disposition: string; reason: string;
    changedItems: number }> }> };

const body = (workIds: string[], options: Partial<{ editions: boolean; ratings: boolean; frontier: boolean }> = {}) =>
  ({ profile: 'open-library-works-run-v1', workIds, editions: false, ratings: false, frontier: false, ...options });
const surface = (run: Run, name: string) => run.surfaces.find(item => item.surface === name)!;
const edition = (n: number, extra: Record<string, unknown> = {}) =>
  ({ key: `/books/OL${n}M`, title: `Edition ${n}`, revision: 1, ...extra });

async function acquire(h: RunHarness, workIds: string[], options = {}, key = `run-${randomUUID()}`) {
  const response = await h.post('/v1/sources/acquisitions', 'owner', body(workIds, options), key);
  return { response, key, result: response.status < 300 ? await response.json() as { run: Run; replayed: boolean } : null };
}

test('LIVE09: a run freezes each request capture, reuses it across consumers and retries, and the next run refreshes', async () => {
  const h = await runHarness();
  try {
    h.provider.work('OL1W', 7);
    h.provider.work('OL2W', 3);
    h.provider.editions.set('OL1W', Array.from({ length: 60 }, (_, n) => edition(n + 1)));
    h.provider.editions.set('OL2W', [edition(900)]);
    // The provider changes after the Work response is served, while the run is still paging editions.
    h.provider.afterRequest = path => {
      if (path === '/works/OL1W.json') h.provider.work('OL1W', 8, { title: 'Changed mid-run' });
    };
    const first = await acquire(h, ['OL1W', 'OL2W'], { editions: true });
    expect(first.response.status).toBe(201);
    h.provider.afterRequest = null;
    const run = first.result!.run;
    expect(run.state).toBe('completed');
    expect(surface(run, 'works').captures.map(capture => capture.sourceRevision))
      .toEqual(['open-library-revision:7', 'open-library-revision:3']);
    expect(surface(run, 'editions').captures).toHaveLength(4);
    expect(new Set(run.surfaces.flatMap(item => item.captures.map(capture => capture.requestKey))).size).toBe(6);
    const fetched = h.provider.requests.length;
    expect(fetched).toBe(6);

    // Replay, a lost-response retry and the exact read all use the frozen set; nothing is refetched.
    const replay = await h.post('/v1/sources/acquisitions', 'owner', body(['OL1W', 'OL2W'], { editions: true }), first.key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ run, replayed: true });
    expect(await (await h.get(`/v1/sources/runs/${idOf(run.run)}`, 'reader')).json()).toEqual(run);
    const workObservation = idOf(surface(run, 'works').captures[0]!.observation);
    // Missing copyright clearance is recorded as unknown; it is not an
    // acquisition failure or a fabricated grant for this factual capture.
    const captured = await h.get(`/v1/sources/observations/${workObservation}`, 'reader');
    expect(captured.status).toBe(200);
    expect(await captured.json()).toMatchObject({ rightsEvidence: { basis: 'unknown' } });
    const converted = await h.post(`/v1/sources/observations/${workObservation}/conversions/open-library-work`,
      'owner', { profile: 'open-library-work-map-v1' }, `convert-${randomUUID()}`);
    expect(converted.status).toBe(201);
    expect((await converted.json() as { conversion: { projection: { title: string } } }).conversion.projection.title)
      .toBe('Fixture OL1W');
    expect(h.provider.requests.length).toBe(fetched);

    // An interrupted run resumes: completed captures are reused and only missing requests are fetched.
    h.gate.failAt = h.gate.reserved + 2;
    const interrupted = await acquire(h, ['OL1W', 'OL2W'], { editions: true });
    expect(interrupted.response.status).toBe(429);
    const partial = (await h.contentPool.query<{ state: string | null; captures: number }>(`SELECT
      (SELECT outcome FROM source.acquisition_run_completion WHERE run_id = r.id) AS state,
      (SELECT count(*)::int FROM source.run_capture WHERE run_id = r.id) AS captures
      FROM source.acquisition_run r WHERE r.principal_id = $1 AND r.idempotency_key = $2`,
    [h.ownerId, interrupted.key])).rows[0]!;
    expect(partial).toEqual({ state: null, captures: 2 });
    h.gate.failAt = null;
    const beforeResume = h.provider.requests.length;
    const resumed = await h.post('/v1/sources/acquisitions', 'owner', body(['OL1W', 'OL2W'], { editions: true }),
      interrupted.key);
    expect(resumed.status).toBe(200);
    const resumedRun = (await resumed.json() as { run: Run }).run;
    expect(resumedRun.state).toBe('completed');
    expect(h.provider.requests.length - beforeResume).toBe(4);
    // The next run refreshes and sees the changed source; the earlier run keeps its capture.
    expect(surface(resumedRun, 'works').captures[0]!.sourceRevision).toBe('open-library-revision:8');
    expect(surface(resumedRun, 'works').captures[0]!.observation).not.toBe(surface(run, 'works').captures[0]!.observation);
    expect(await (await h.get(`/v1/sources/runs/${idOf(run.run)}`, 'reader')).json()).toEqual(run);

    // Concurrent executors of one key converge on one capture per request.
    const racedKey = `race-${randomUUID()}`;
    const beforeRace = h.provider.requests.length;
    const raced = await Promise.all([1, 2].map(() =>
      h.post('/v1/sources/acquisitions', 'owner', body(['OL2W'], { editions: true }), racedKey)));
    expect(raced.map(response => response.status).sort()).toContain(201);
    expect(raced.every(response => [200, 201, 409].includes(response.status))).toBe(true);
    const settled = await h.post('/v1/sources/acquisitions', 'owner', body(['OL2W'], { editions: true }), racedKey);
    expect(settled.status).toBe(200);
    expect(h.provider.requests.length - beforeRace).toBe(2);

    // Denials and stale intent create no run and make no provider request.
    const before = h.provider.requests.length;
    expect((await h.post('/v1/sources/acquisitions', 'reader', body(['OL1W']), `denied-${randomUUID()}`)).status).toBe(401);
    expect((await h.post('/v1/sources/acquisitions', 'owner', body(['OL1W']))).status).toBe(400);
    expect((await h.post('/v1/sources/acquisitions', 'owner', body(['OL1W']), first.key)).status).toBe(409);
    expect((await h.post('/v1/sources/acquisitions', 'owner',
      body(Array.from({ length: 9 }, (_, n) => `OL${n + 1}W`)), `big-${randomUUID()}`)).status).toBe(400);
    expect((await h.get(`/v1/sources/runs/${idOf(run.run)}`, 'other')).status).toBe(404);
    await h.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [h.ownerId]);
    expect((await h.post('/v1/sources/acquisitions', 'owner', body(['OL1W']), `inactive-${randomUUID()}`)).status).toBe(403);
    expect((await h.get(`/v1/sources/runs/${idOf(run.run)}`, 'reader')).status).toBe(403);
    expect(h.provider.requests.length).toBe(before);
  } finally { await h.close(); }
}, 60_000);

test('LIVE02: partial, malformed and failed surfaces leave no completed receipt and no omission-driven withdrawal', async () => {
  const h = await runHarness();
  try {
    h.provider.work('OL1W', 1, { description: 'Kept' });
    h.provider.editions.set('OL1W', Array.from({ length: 60 }, (_, n) => edition(n + 1)));
    const complete = (await acquire(h, ['OL1W'], { editions: true })).result!.run;
    expect(complete.completion?.outcome).toBe('completed');

    const cases: Array<[string, () => Response, string, string]> = [
      ['/works/OL1W/editions.json?limit=25&offset=25', () => new Response('{"entries": [', {
        headers: { 'content-type': 'application/json' } }), 'editions', 'malformed'],
      ['/works/OL1W/editions.json?limit=25&offset=25', () => new Response(`{"size":60,"entries":[],"pad":"${'x'.repeat(70_000)}"}`,
        { headers: { 'content-type': 'application/json' } }), 'editions', 'oversized'],
      ['/works/OL1W.json', () => { throw new TypeError('connection reset'); }, 'works', 'network'],
      ['/works/OL1W.json', () => new Response('busy', { status: 503 }), 'works', 'http-status'],
      ['/works/OL1W.json', () => new Response('slow down', { status: 429 }), 'works', 'rate-limited'],
      ['/works/OL1W.json', () => new Response(null, { status: 302, headers: { location: 'https://example.test/' } }),
        'works', 'redirect-refused'],
      ['/works/OL1W.json', () => new Response('{"key":"/works/OL9W","title":"Other"}', {
        headers: { 'content-type': 'application/json' } }), 'works', 'identity-mismatch'],
    ];
    for (const [path, respond, failedSurface, reason] of cases) {
      h.provider.overrides.clear();
      h.provider.overrides.set(path, respond);
      const run = (await acquire(h, ['OL1W'], { editions: true })).result!.run;
      expect(run.state).toBe('incomplete');
      expect(run.completion?.outcome).toBe('incomplete');
      expect(surface(run, failedSurface).outcome).toMatchObject({ outcome: 'failed', reason });
    }
    // A partial edition set that exceeds the capture budget is never a complete surface.
    h.provider.overrides.clear();
    h.provider.editions.set('OL1W', Array.from({ length: 250 }, (_, n) => edition(n + 1)));
    const budget = (await acquire(h, ['OL1W'], { editions: true })).result!.run;
    expect(surface(budget, 'editions').outcome).toMatchObject({ outcome: 'failed', reason: 'budget-exhausted',
      captureCount: 1 });
    expect(budget.completion?.outcome).toBe('incomplete');
    // A missing Work is a failed required surface, not an empty qualified one.
    const missing = (await acquire(h, ['OL404W'])).result!.run;
    expect(surface(missing, 'works').outcome).toMatchObject({ outcome: 'failed', reason: 'http-status', captureCount: 0 });
    expect(missing.completion?.outcome).toBe('incomplete');

    // A later narrower response that omits a field only records the omission.
    h.provider.editions.set('OL1W', [edition(1)]);
    h.provider.work('OL1W', 2);
    const narrower = (await acquire(h, ['OL1W'], { editions: true })).result!.run;
    const drift = await (await h.get(`/v1/sources/runs/${idOf(complete.run)}/drift/${idOf(narrower.run)}`, 'reader'))
      .json() as Drift;
    const works = drift.surfaces.find(item => item.surface === 'works')!;
    expect(works.fields.find(field => field.field === 'description')).toMatchObject({ status: 'removed' });
    expect(drift.surfaces.find(item => item.surface === 'editions')).toMatchObject({ itemsRemoved: 59 });
    expect(await (await h.get(`/v1/sources/runs/${idOf(complete.run)}`, 'reader')).json()).toEqual(complete);
    const observation = idOf(surface(complete, 'works').captures[0]!.observation);
    const kept = await h.get(`/v1/sources/observations/${observation}`, 'reader');
    expect(Buffer.from((await kept.json() as { rawBytesBase64: string }).rawBytesBase64, 'base64').toString())
      .toContain('"description":"Kept"');
    const completed = await h.contentPool.query(`SELECT count(*)::int AS total FROM source.acquisition_run_completion c
      JOIN source.acquisition_run r ON r.id = c.run_id WHERE r.principal_id = $1 AND c.outcome = 'completed'`, [h.ownerId]);
    expect(completed.rows[0]!.total).toBe(2);
    // Comparing with a failed surface reports it unavailable instead of inferring removal.
    const failedDrift = await (await h.get(`/v1/sources/runs/${idOf(complete.run)}/drift/${idOf(missing.run)}`,
      'reader')).json() as Drift;
    expect(failedDrift.surfaces.find(item => item.surface === 'works')).toMatchObject({ status: 'unavailable', fields: [] });
  } finally { await h.close(); }
}, 60_000);

test('LIVE11: a surface behind provider access is unqualified with no bypass or guessed values', async () => {
  const h = await runHarness();
  try {
    h.provider.work('OL1W', 1);
    h.provider.work('OL3W', 1);
    h.provider.overrides.set('/works/OL3W.json', () => new Response('forbidden', { status: 403 }));
    h.provider.overrides.set('/works/OL1W/ratings.json', () => new Response('login', { status: 401 }));
    const run = (await acquire(h, ['OL1W', 'OL3W'], { ratings: true })).result!.run;
    expect(surface(run, 'works').outcome).toMatchObject({ outcome: 'unqualified', reason: 'authorization-denied',
      captureCount: 1 });
    expect(surface(run, 'works').captures.map(capture => capture.requestKey)).toEqual(['GET /works/OL1W.json']);
    expect(surface(run, 'ratings').outcome).toMatchObject({ outcome: 'unqualified', reason: 'authentication-required',
      captureCount: 0 });
    expect(run.completion).toMatchObject({ outcome: 'incomplete', unqualified: 2 });
    // Exactly the fixed requests were made once: no alternate route, credential or retry bypass.
    expect(h.provider.requests).toEqual(['/works/OL1W.json', '/works/OL3W.json', '/works/OL1W/ratings.json']);
    const rows = await h.contentPool.query(`SELECT r.namespace, r.external_id FROM source.observation o
      JOIN source.record r ON r.id = o.record_id WHERE o.principal_id = $1`, [h.ownerId]);
    expect(rows.rows).toEqual([{ namespace: 'work', external_id: 'OL1W' }]);

    // An optional statistics surface behind access does not block completion but stays unqualified.
    h.provider.overrides.delete('/works/OL3W.json');
    const optional = (await acquire(h, ['OL1W'], { ratings: true })).result!.run;
    expect(optional.completion).toMatchObject({ outcome: 'completed', qualified: 1, unqualified: 1 });
    h.provider.overrides.clear();
    const open = (await acquire(h, ['OL1W'], { ratings: true })).result!.run;
    const drift = await (await h.get(`/v1/sources/runs/${idOf(optional.run)}/drift/${idOf(open.run)}`, 'reader'))
      .json() as Drift;
    expect(drift.surfaces.find(item => item.surface === 'ratings')).toMatchObject({ status: 'unavailable', fields: [] });
  } finally { await h.close(); }
}, 60_000);

test('LIVE01: a source field that is added, removed or changed between runs is reported with its declared disposition', async () => {
  const h = await runHarness();
  try {
    h.provider.work('OL1W', 1, { description: 'Old', covers: [1] });
    h.provider.editions.set('OL1W', [edition(1), edition(2, { publishers: ['A'] })]);
    h.provider.ratings.set('OL1W', { summary: { average: 4.1, count: 10 }, counts: { 5: 4 } });
    const base = (await acquire(h, ['OL1W'], { editions: true, ratings: true })).result!.run;
    h.provider.work('OL1W', 2, { subjects: ['Foxes', 'Farmers'], covers: [1], first_publish_date: '1970',
      x_provider_new: { nested: true } });
    h.provider.editions.set('OL1W', [edition(2, { publishers: ['B'], isbn_13: ['9780000000000'] }), edition(3)]);
    h.provider.ratings.set('OL1W', { summary: { average: 4.2, count: 11 }, counts: { 5: 5 } });
    const candidate = (await acquire(h, ['OL1W'], { editions: true, ratings: true })).result!.run;
    const response = await h.get(`/v1/sources/runs/${idOf(base.run)}/drift/${idOf(candidate.run)}`, 'reader');
    expect(response.status).toBe(200);
    const drift = await response.json() as Drift;
    const fields = (name: string) => new Map(drift.surfaces.find(item => item.surface === name)!.fields
      .map(field => [field.field, field]));
    const works = fields('works');
    // Every observed field is listed; none is silently dropped.
    expect([...works.keys()].sort()).toEqual(['covers', 'description', 'first_publish_date', 'key', 'revision',
      'subjects', 'title', 'type', 'x_provider_new']);
    expect(works.get('description')).toMatchObject({ status: 'removed', disposition: 'structured-source-only' });
    expect(works.get('subjects')).toMatchObject({ status: 'changed', disposition: 'structured-source-only', changedItems: 1 });
    expect(works.get('title')).toMatchObject({ status: 'unchanged', disposition: 'native' });
    expect(works.get('first_publish_date')).toMatchObject({ status: 'added', disposition: 'unsupported' });
    expect(works.get('x_provider_new')).toMatchObject({ status: 'added', disposition: 'unsupported',
      reason: 'undeclared-field' });
    expect(works.get('covers')).toMatchObject({ status: 'unchanged' });
    const editions = drift.surfaces.find(item => item.surface === 'editions')!;
    expect(editions).toMatchObject({ status: 'compared', itemsPaired: 1, itemsAdded: 1, itemsRemoved: 1 });
    expect(fields('editions').get('publishers')).toMatchObject({ status: 'changed', changedItems: 1 });
    expect(fields('editions').get('isbn_13')).toMatchObject({ status: 'added', disposition: 'unsupported' });
    // Provider statistics stay source-only statistics, never native values.
    expect(fields('ratings').get('summary')).toMatchObject({ status: 'changed', disposition: 'unsupported' });

    expect((await h.get(`/v1/sources/runs/${idOf(base.run)}/drift/${idOf(candidate.run)}`, 'other')).status).toBe(404);
    expect((await h.get(`/v1/sources/runs/${idOf(base.run)}/drift/${idOf(base.run)}`, 'reader')).status).toBe(400);
    expect((await h.get(`/v1/sources/runs/${idOf(base.run)}/drift/${randomUUID()}`, 'reader')).status).toBe(404);
  } finally { await h.close(); }
}, 60_000);
