import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { personaSession } from '../support/personas.ts';
import { RequestWatch, requestWatchPrefix } from '../support/request-watch.ts';

function harness() {
  let now = 0;
  const timers = new Map<object, { at: number; callback: () => void }>();
  const lines: string[] = [];
  const watch = new RequestWatch({
    now: () => now,
    setTimer(callback, milliseconds) {
      const key = {};
      timers.set(key, { at: now + milliseconds, callback });
      return key;
    },
    clearTimer: key => { timers.delete(key as object); },
    log: line => { lines.push(line); },
  });
  return { watch, lines, timers, advance(milliseconds: number) {
    now += milliseconds;
    for (const [key, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(key);
      timer.callback();
    }
  } };
}
const request = { persona: 'stranger', service: 'Main' as const, method: 'GET',
  url: new URL('https://main.test/v1/works?q=two%20words&after=next') };
const records = (lines: string[]) => lines.map(line => {
  expect(line.startsWith(`${requestWatchPrefix} `)).toBe(true);
  expect(line.split('\n')).toHaveLength(1);
  return JSON.parse(line.slice(requestWatchPrefix.length + 1));
});

test('one pending line at ten seconds, slow completion with only answer ids, and no retained state', () => {
  const h = harness();
  const finish = h.watch.start(request);
  h.advance(9_999);
  expect(h.lines).toEqual([]);
  h.advance(1);
  h.advance(2_000);
  expect(h.lines).toHaveLength(1);
  finish(new Response('private answer body', { status: 503, headers: {
    'x-request-id': 'request-123', 'x-trace-id': 'trace-123', traceparent: 'trace-parent',
    'request-id': 'alternate-123', 'set-cookie': 'private-cookie', authorization: 'Bearer private-bearer',
  } }));
  expect(records(h.lines)).toEqual([
    { event: 'pending', persona: 'stranger', service: 'Main', method: 'GET',
      path: '/v1/works?q=two%20words&after=next', elapsedMs: 10_000 },
    { event: 'completed', persona: 'stranger', service: 'Main', method: 'GET',
      path: '/v1/works?q=two%20words&after=next', elapsedMs: 12_000, status: 503,
      'x-request-id': 'request-123', 'x-trace-id': 'trace-123', traceparent: 'trace-parent',
      'request-id': 'alternate-123' },
  ]);
  expect(h.lines.join('\n')).not.toContain('private');
  expect(h.watch.size).toBe(0);
  expect(h.timers.size).toBe(0);
  h.watch.reportPending();
  finish();
  h.advance(20_000);
  expect(h.lines).toHaveLength(2);
});

test('completion is silent through five seconds; rejected requests also release their timer and entry', () => {
  const h = harness();
  const fast = h.watch.start(request);
  h.advance(5_000);
  fast(new Response());
  expect(h.lines).toEqual([]);
  const failed = h.watch.start(request);
  h.advance(5_001);
  failed();
  expect(records(h.lines)[0]).toMatchObject({ event: 'completed', status: 'error', elapsedMs: 5_001 });
  expect(h.watch.size).toBe(0);
  expect(h.timers.size).toBe(0);
});

test('test end names every outstanding request and redacts credentials in Account queries', () => {
  const h = harness();
  const main = h.watch.start(request);
  const account = h.watch.start({ ...request, service: 'Account', method: 'POST',
    url: new URL('https://username:private-password@account.test/verify?token=private-token&token=another-secret&cookie=private-cookie&code=private-code&next=%2Fhome') });
  h.advance(200);
  h.watch.reportPending();
  expect(records(h.lines)).toEqual([
    { event: 'test-end', persona: 'stranger', service: 'Main', method: 'GET',
      path: '/v1/works?q=two%20words&after=next', elapsedMs: 200 },
    { event: 'test-end', persona: 'stranger', service: 'Account', method: 'POST',
      path: '/verify?token=%5Bredacted%5D&cookie=%5Bredacted%5D&code=%5Bredacted%5D&next=%2Fhome', elapsedMs: 200 },
  ]);
  expect(h.lines.join('\n')).not.toMatch(/private|another-secret|username/);
  main(new Response());
  account(new Response());
  expect(h.watch.size).toBe(0);
});

test('persona Main, Account and snapshot calls watch deliberately held HTTP attempts without secrets', async () => {
  const h = harness();
  const held: ((response: Response) => void)[] = [];
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(() =>
    new Promise<Response>(resolve => { held.push(resolve); }));
  try {
    const person = personaSession('https://main.test', 'https://account.test', 'account-id',
      'private-cookie', undefined, undefined, 'owner', h.watch);
    const calls = [person.main('GET', '/v1/works?q=phrase'),
      person.account('POST', '/api/auth/sign-in/email', { password: 'private-password' }),
      person.snapshot().main('GET', '/v1/me')];
    // Credential acquisition yields once before each HTTP attempt.
    await Promise.resolve();
    expect(held).toHaveLength(3);
    h.advance(10_000);
    h.watch.reportPending();
    expect(records(h.lines).map(line => [line.event, line.persona, line.service, line.path]))
      .toEqual([
        ['pending', 'owner', 'Main', '/v1/works?q=phrase'],
        ['pending', 'owner', 'Account', '/api/auth/sign-in/email'],
        ['pending', 'owner', 'Main', '/v1/me'],
        ['test-end', 'owner', 'Main', '/v1/works?q=phrase'],
        ['test-end', 'owner', 'Account', '/api/auth/sign-in/email'],
        ['test-end', 'owner', 'Main', '/v1/me'],
      ]);
    for (const release of held) release(new Response('private-body', { headers: { 'x-request-id': 'held-request' } }));
    await Promise.all(calls);
    expect(records(h.lines).filter(line => line.event === 'completed')).toHaveLength(3);
    expect(h.lines.join('\n')).not.toContain('private');
    expect(h.watch.size).toBe(0);
    expect(h.timers.size).toBe(0);
  } finally { fetchMock.mockRestore(); }
});

test('Bun teardown reports held persona requests after assertion failure and the test limit', async () => {
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(resolve('.temp/request-watch-'));
  try {
    const source = `
      import { test } from 'bun:test';
      import { personaSession } from ${JSON.stringify(resolve('tests/qa/support/personas.ts'))};
      globalThis.fetch = () => new Promise(() => {});
      const person = name => personaSession('http://main.test', 'http://account.test', null,
        undefined, undefined, undefined, name);
      test('held request reaches limit', async () => {
        await person('timed-out').main('GET', '/v1/works?q=held-phrase');
      }, 50);
      test('held request survives assertion failure', async () => {
        void person('failed').account('GET', '/api/auth/session');
        await Promise.resolve();
        throw new Error('deliberate assertion failure');
      });
    `;
    const file = resolve(directory, 'held.test.ts');
    await writeFile(file, source);
    const child = Bun.spawn([process.execPath, 'test', file], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    const lines = (stdout + stderr).split('\n').filter(line => line.startsWith(requestWatchPrefix));
    const ended = records(lines).filter(line => line.event === 'test-end');
    expect(ended).toContainEqual(expect.objectContaining({ persona: 'timed-out', service: 'Main',
      method: 'GET', path: '/v1/works?q=held-phrase' }));
    expect(ended).toContainEqual(expect.objectContaining({ persona: 'failed', service: 'Account',
      method: 'GET', path: '/api/auth/session' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test('measure timer and map overhead for fast completed requests', () => {
  const watch = new RequestWatch();
  const response = new Response();
  const attempts = 10_000;
  const started = performance.now();
  for (let index = 0; index < attempts; index++) watch.start(request)(response);
  const elapsedMs = performance.now() - started;
  console.info(`Request watch measurement: ${attempts} attempts, ${elapsedMs.toFixed(3)} ms total, ${(elapsedMs / attempts).toFixed(6)} ms/request`);
  expect(watch.size).toBe(0);
});
