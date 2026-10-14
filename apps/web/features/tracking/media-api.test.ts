import { expect, setDefaultTimeout, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { mainMediaApi } from './media-api.ts';
import type { EpisodeProgress } from './episode-api.ts';
import { settle } from './failure.ts';

setDefaultTimeout(15_000);
const iri = (n: number) => `https://rezics.com/id/00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const actor = iri(1), work = iri(2), part = { structure: iri(3), occurrence: iri(4) };
const response = (answer: unknown, status = 200) => Response.json(answer, { status });
function api(fetcher: typeof fetch) {
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  return mainMediaApi(actor, () => main);
}
function transport(handler: (request: Request) => Promise<Response> | Response): typeof fetch {
  return Object.assign((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input, init))),
    { preconnect: fetch.preconnect });
}

for (const [status, failure] of [[400, 'invalid'], [401, 'sign-in'], [403, 'sign-in'], [404, 'missing'],
  [409, 'moved'], [422, 'budget'], [429, 'unavailable'], [503, 'unavailable']] as const) {
  test(`whole Work failures preserve HTTP ${status} and every problem extension`, async () => {
    const problem = { type: 'urn:problem:progress', title: 'Progress refused', code: 'progress_refused',
      status, detail: 'Original detail', reason: { limit: 25 }, instance: '/requests/one', requestId: 'request-1234' };
    const media = api(transport(() => response(problem, status)));
    const answer = await media.workStanding(work);
    expect(answer).toMatchObject({ ok: false, failure, status, problem });
    if (!answer.ok) expect(answer.problem).toEqual(problem);
  });
}

test('a has-parts refusal preserves the problem while still selecting part progress', async () => {
  const problem = { code: 'work_has_parts', title: 'Track parts', parts: { structure: part.structure } };
  const media = api(transport(() => response(problem, 409)));
  expect(await media.workParts(work)).toEqual({ ok: true, data: true });
  expect(await media.workStanding(work)).toEqual({ ok: false, failure: 'has-parts', status: 409, problem });
});

test('part progress and refused whole Work writes retain status and problem', async () => {
  const problem = { code: 'foreign_person', detail: 'Person is outside this grant', extra: ['unchanged'] };
  const media = api(transport(request => request.method === 'PUT' || request.url.includes('/occurrences/')
    ? response(problem, 403) : response({ parts: false, standing: 'started', version: 2 })));
  expect(await media.progress(part)).toEqual({ ok: false, failure: 'sign-in', status: 403, problem });
  expect(await media.markWork(work, 'completed')).toEqual({ ok: false, failure: 'sign-in', status: 403, problem });
});

test('unknown whole Work conflicts retain the original refusal without resubmitting', async () => {
  let writes = 0;
  const problem = { code: 'scope_changed', detail: 'Original conflict', current: { scope: 'private' } };
  const media = api(transport(request => {
    if (request.method === 'GET') return response({ parts: false, standing: 'started', version: 2 });
    writes++;
    return response(problem, 409);
  }));
  expect(await media.markWork(work, 'completed')).toEqual({ ok: false, failure: 'moved', status: 409, problem });
  expect(writes).toBe(1);
});

test('transport failure has no invented HTTP status or problem', async () => {
  const media = api(transport(() => { throw new TypeError('Failed to fetch'); }));
  expect(await media.workStanding(work)).toEqual({ ok: false, failure: 'offline' });
});

test('malformed progress retains the actual HTTP 200 and payload instead of inventing a server refusal', async () => {
  const body = { completed: true, position: 'paragraph 4', version: 'invalid version' };
  const media = api(transport(() => response(body)));
  expect(await media.progress(part)).toEqual({ ok: false, failure: 'unavailable', status: 200, problem: body });
});

test('HTTP 202 stays pending and is not retried or returned as completed progress', async () => {
  let calls = 0;
  const media = api(transport(() => { calls++; return response({ code: 'progress_pending' }, 202); }));
  for (const read of [() => media.standing(work), () => media.workStanding(work), () => media.progress(part)]) {
    expect(await read()).toMatchObject({ ok: false, status: 202, problem: { code: 'progress_pending' } });
  }
  expect(calls).toBe(3);
  expect(await settle(async () => ({ data: { complete: false }, error: null, response: { status: 200 } })))
    .toEqual({ ok: true, data: { complete: false } });
});

test('a cached chapter undo cannot overwrite the winning save; recovery uses the winning version', async () => {
  const writes: unknown[] = [];
  let current: EpisodeProgress = { completed: true, position: 'winning paragraph', version: 2 };
  const problem = { code: 'stale_progress', title: 'Progress changed', expectedVersion: 1, actualVersion: 2 };
  const media = api(transport(async request => {
    expect(request.url).toContain(part.structure.slice(-36));
    if (request.method === 'GET') {
      expect(new URL(request.url).searchParams.get('actingSubject')).toBe(actor);
      return response(current);
    }
    const body = await request.json() as { actingSubject: string; completed: boolean; position: string | null; expectedVersion: number };
    writes.push(body);
    expect(body.actingSubject).toBe(actor);
    if (body.expectedVersion === 1) return response(problem, 409);
    current = { completed: body.completed, position: body.position, version: 3 };
    return response(current);
  }));
  const stale = await media.mark(part, { completed: false, position: null, expectedVersion: 1 });
  expect(stale).toEqual({ ok: false, failure: 'stale', status: 409, problem, current,
    submitted: { completed: false, position: null } });
  expect(current.version).toBe(2);
  expect(await media.mark(part, { completed: false, position: null, expectedVersion: 2 }))
    .toEqual({ ok: true, data: { completed: false, position: null, version: 3 } });
  expect(writes).toHaveLength(2);
});

test('a lost chapter response replays the same command with the same version and key', async () => {
  const keys: (string | null)[] = [], bodies: unknown[] = [];
  const media = api(transport(async request => {
    if (request.method === 'GET') return response({ completed: false, position: null, version: 0 });
    keys.push(request.headers.get('idempotency-key'));
    bodies.push(await request.json());
    if (keys.length === 1) return response({ code: 'temporarily_unavailable' }, 503);
    return response({ completed: true, position: 'paragraph 4', version: 1, replayed: true });
  }));
  expect(await media.mark(part, { completed: true, position: 'paragraph 4', expectedVersion: 0 }))
    .toMatchObject({ ok: true, data: { version: 1, replayed: true } });
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(bodies[1]).toEqual(bodies[0]);
});
