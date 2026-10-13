import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { rowOutcomes, proved } from '../../../scripts/qa/cases/outcome-cells.ts';
import type { AnswerContract } from '../../../scripts/api/answer-record.ts';
import { LocalOAuthSession } from '../../../scripts/lib/oauth-client.ts';
import { personaSession } from '../support/personas.ts';
import { OutcomeRecorder, outcomeResponse, outcomeTest } from '../support/outcome-test.ts';
import { personaProofActive } from '../support/proof-phase.ts';

afterEach(() => mock.restore());

const declaration = rowOutcomes('books/read-a-book', { member: proved('reads') });
const recorder = () => new OutcomeRecorder(declaration, { directory: '', contract: { paths: {} } });
const person = () => personaSession('http://main.test', 'http://account.test', null);
const pending = (changes: object = {}) => Response.json({ operationId: 'operation',
  status: 'reconciling', phase: 'realm-adoption', result: null,
  retry: { allowed: true, afterMs: 0 }, ...changes }, { status: 202 });
function answers(responses: Response[]) {
  const calls: RequestInit[] = [];
  spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    calls.push(init!);
    return responses.shift()!;
  });
  return calls;
}

test('preparation follows a reconciling write with one key and preserves its request options', async () => {
  for (const key of [undefined, 'supplied-key']) {
    const final = Response.json({ work: 'created' }, { status: 201 });
    const calls = answers([pending(), pending(), final]);
    expect(await person().main('POST', '/v1/works', { title: 'Original' }, key,
      { headers: { 'x-probe': 'retained' } })).toBe(final);
    expect(calls).toHaveLength(3);
    const keys = calls.map(call => new Headers(call.headers).get('idempotency-key'));
    expect(keys[0]).toBeString();
    if (key) expect(keys[0]).toBe(key);
    expect(new Set(keys).size).toBe(1);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.body).toBe(JSON.stringify({ title: 'Original' }));
      expect(new Headers(call.headers).get('x-probe')).toBe('retained');
    }
  }
});

test('a proof keeps the first reconciling answer; preparation may explicitly opt out', async () => {
  const first = pending(), calls = answers([first, pending()]);
  await recorder().prove('member', async () => {
    expect(personaProofActive()).toBe(true);
    expect(await person().main('POST', '/v1/works')).toBe(first);
  });
  expect(personaProofActive()).toBe(false);
  expect((await person().main('POST', '/v1/works', undefined, undefined, { settle: false })).status).toBe(202);
  expect(calls).toHaveLength(2);
});

outcomeTest(declaration, 'member', async () => {
  expect(personaProofActive()).toBe(true);
});

test('nested, concurrent and failed proofs leave only their own phase', async () => {
  const outer = recorder(), inner = recorder();
  await outer.prove('member', async () => {
    await inner.prove('owner', async () => { expect(personaProofActive()).toBe(true); });
    expect(personaProofActive()).toBe(true);
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = recorder().prove('member', async () => {
    await gate;
    expect(personaProofActive()).toBe(true);
  });
  expect(personaProofActive()).toBe(false);
  await recorder().prove('owner', async () => { expect(personaProofActive()).toBe(true); });
  expect(personaProofActive()).toBe(false);
  release(); await running;
  await expect(recorder().prove('member', () => { throw new Error('failed proof'); })).rejects.toThrow('failed proof');
  expect(personaProofActive()).toBe(false);
});

test('runner completion closes the phase of an unfinished proof', async () => {
  const record = recorder();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = record.prove('member', async () => {
    await gate;
    expect(personaProofActive()).toBe(false);
  });
  record.finish('member');
  release(); await running;
});

test('GET, refusals, failures and other pending protocols keep the first answer', async () => {
  for (const [method, first] of [
    ['GET', pending()], ['POST', Response.json({ code: 'denied' }, { status: 403 })],
    ['POST', Response.json({ code: 'another_unavailable' }, { status: 503 })],
    ['POST', Response.json({ operationId: 'agent-provision' }, { status: 202 })],
    ['POST', new Response('invalid JSON', { status: 202 })],
    ...[{ operationId: '' }, { phase: '' }, { result: {} }, { status: 'pending' },
      { retry: { allowed: false, afterMs: 0 } }, { retry: { allowed: true, afterMs: -1 } }]
      .map(change => ['POST', pending(change)] as const),
  ] as const) {
    const calls = answers([first]);
    expect(await person().main(method, '/v1/example')).toBe(first);
    expect(calls).toHaveLength(1);
  }
});

test('dependency refusal waits retry-after before returning the following read answer', async () => {
  const calls = answers([Response.json({ code: 'dependency_unavailable' },
    { status: 503, headers: { 'retry-after': '0.01' } }), Response.json({ code: 'denied' }, { status: 403 })]);
  const waits = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  const log = spyOn(console, 'info').mockImplementation(() => {});
  await recorder().prove('member', async () => {
    expect((await person().main('GET', '/v1/example')).status).toBe(403);
  });
  expect(calls).toHaveLength(2);
  expect(waits).toHaveBeenCalledWith(10);
  expect(log).toHaveBeenCalledWith('Persona repeat GET /v1/example dependency_unavailable try 2');
});

test('work-read refusal waits one second on reads and keyed writes, preserving the key', async () => {
  for (const method of ['GET', 'POST']) {
    const calls = answers([Response.json({ code: 'work_read_unavailable' }, { status: 503 }),
      Response.json({ done: true })]);
    const waits = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    expect((await person().main(method, '/v1/reply-drafts', undefined, 'same-key')).status).toBe(200);
    expect(waits).toHaveBeenCalledWith(1000);
    expect(calls.map(call => new Headers(call.headers).get('idempotency-key'))).toEqual(['same-key', 'same-key']);
  }
  const calls = answers([Response.json({ code: 'work_read_unavailable' }, { status: 503 }), Response.json({ done: true })]);
  await recorder().prove('member', async () => {
    expect((await person().main('POST', '/v1/reply-drafts', {}, 'proof-key')).status).toBe(200);
  });
  expect(calls.map(call => new Headers(call.headers).get('idempotency-key'))).toEqual(['proof-key', 'proof-key']);
});

test('unkeyed writes and writes with the shared dependency code are not repeated', async () => {
  for (const code of ['work_read_unavailable', 'dependency_unavailable', 'other_code']) {
    const first = Response.json({ code }, { status: 503 });
    let calls = 0;
    expect(await outcomeResponse(async () => { calls++; return first; }, 30_000,
      { method: 'POST', path: '/write' })).toBe(first);
    expect(calls).toBe(1);
  }
  const first = Response.json({ code: 'dependency_unavailable' }, { status: 503 });
  const calls = answers([first]);
  expect(await person().main('POST', '/v1/works')).toBe(first);
  expect(calls).toHaveLength(1);
});

test('a deadline returns the last refusal intact without another try', async () => {
  for (const code of ['dependency_unavailable', 'work_read_unavailable']) {
    const first = Response.json({ code }, { status: 503 });
    let calls = 0;
    expect(await outcomeResponse(async () => { calls++; return first; }, 5)).toBe(first);
    expect(await first.json()).toEqual({ code });
    expect(calls).toBe(1);
  }
});

test('an in-flight repeat reaching the deadline returns the preceding refusal', async () => {
  const first = Response.json({ code: 'work_read_unavailable' }, { status: 503, headers: { 'retry-after': '0' } });
  let calls = 0;
  expect(await outcomeResponse(async signal => {
    if (++calls === 1) return first;
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    throw new Error('unreachable');
  }, 20)).toBe(first);
  expect(await first.json()).toEqual({ code: 'work_read_unavailable' });
});

test('every repeated read obtains fresh session credentials; snapshots retain their bearer', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.signature`;
  const oauth = new LocalOAuthSession({ account: 'http://account.test', clientId: 'client',
    redirectUri: 'http://client.test', scope: 'work:read' }, { access_token: token, scope: 'work:read' }, Date.now() + 300_000);
  const current = spyOn(oauth, 'current').mockResolvedValueOnce(token).mockResolvedValueOnce(token + '-renewed');
  const session = personaSession('http://main.test', 'http://account.test', 'account', undefined, oauth);
  const calls = answers([Response.json({ code: 'work_read_unavailable' }, { status: 503 }), Response.json({ done: true }), Response.json({ done: true })]);
  spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  await session.main('GET', '/v1/example');
  expect(current).toHaveBeenCalledTimes(2);
  expect(calls.map(call => new Headers(call.headers).get('authorization'))).toEqual([`Bearer ${token}`, `Bearer ${token}-renewed`]);
  const snapshot = session.snapshot();
  expect(snapshot.expiresAt).toBeGreaterThan(Date.now());
  await snapshot.main('GET', '/v1/example');
  expect(current).toHaveBeenCalledTimes(2);
  expect(new Headers(calls[2]!.headers).get('authorization')).toBe(`Bearer ${token}`);
});

test('server failures never become recorded samples, even when a contract declares them', async () => {
  const contract: AnswerContract = { paths: { '/v1/example': { get: { operationId: 'example',
    responses: { '503': {} } } } } };
  const record = new OutcomeRecorder(declaration, { directory: '', contract });
  await expect(record.prove('member', async () => {
    await record.session('member', { main: async () => Response.json({ code: 'unavailable' }, { status: 503 }) })
      ('read', 'GET', '/v1/example');
  })).rejects.toThrow('received HTTP 503');
});

test('one bearer renewal and the Main observer survive the staged patch', async () => {
  const token = (seconds: number) => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.signature`;
  const expired = token(-1), living = token(300);
  const oauth = new LocalOAuthSession({ account: 'http://account.test', clientId: 'client',
    redirectUri: 'http://client.test', scope: 'work:read' }, { access_token: expired, scope: 'work:read' }, Date.now());
  const current = spyOn(oauth, 'current').mockResolvedValueOnce(expired).mockResolvedValueOnce(living);
  const observed: { response: { status: number }; request: { key: string | null } }[] = [];
  const session = personaSession('http://main.test', 'http://account.test', 'account', undefined, oauth,
    async answer => { observed.push(answer); });
  const calls = answers([Response.json({ code: 'account_assertion_denied' }, { status: 403 }), Response.json({ done: true }),
    Response.json({ code: 'account_assertion_denied' }, { status: 403 })]);
  expect((await session.main('GET', '/v1/example')).status).toBe(200);
  expect(current).toHaveBeenCalledTimes(2);
  expect(observed.map(answer => answer.response.status)).toEqual([403, 200]);
  expect((await session.snapshot().main('GET', '/v1/example')).status).toBe(403);
  expect(current).toHaveBeenCalledTimes(2);
  expect(new Headers(calls[2]!.headers).get('authorization')).toBe(`Bearer ${expired}`);
});
