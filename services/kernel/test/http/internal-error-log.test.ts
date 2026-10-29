import { afterAll, expect, spyOn, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { ProblemError } from '../../src/http/problem.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

const detail = (operationId: string) => ({
  operationId,
  'x-action': 'probe:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
});
const app = createApp({ pool })
  .post('/probe/:id', { detail: detail('probe.write') }, () => {
    throw Object.assign(new TypeError('connection to 10.0.0.7 refused'), { code: 'ECONNREFUSED' });
  })
  .get('/forbidden', { detail: detail('probe.forbidden') }, () => {
    throw new ProblemError('forbidden');
  })
  .get('/deadline', { detail: detail('probe.deadline') }, () => {
    throw new ProblemError('deadline_exceeded');
  })
  .get('/plain', { detail: detail('probe.plain') }, () => {
    throw new Error('plain failure');
  });

async function call(method: string, path: string, init: RequestInit = {}) {
  const lines: unknown[][] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args));
  try {
    const response = await app.handle(new Request(`http://localhost${path}`, { method, ...init }));
    return { response, text: await response.text(), lines };
  } finally {
    spy.mockRestore();
  }
}

test('an error that becomes internal_error writes one structured log line', async () => {
  const { response, text, lines } = await call('POST', '/probe/42?token=query-secret', {
    headers: { 'content-type': 'application/json', 'x-probe': 'header-value' },
    body: JSON.stringify({ password: 'body-secret' }),
  });
  const body = JSON.parse(text);
  expect(response.status).toBe(500);
  expect(body).toMatchObject({ code: 'internal_error', retryable: false });
  expect(text).not.toMatch(/10\.0\.0\.7|ECONNREFUSED/);

  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveLength(1);
  const raw = lines[0]![0] as string;
  const line = JSON.parse(raw);
  expect(line).toMatchObject({
    request_id: body.request_id,
    method: 'POST',
    route: '/probe/:id',
    name: 'TypeError',
    code: 'ECONNREFUSED',
  });
  expect(line.stack).toContain('connection to 10.0.0.7 refused');
  expect(raw).not.toMatch(/body-secret|header-value|query-secret|\/probe\/42/);
});

test('a thrown error without a code logs no code member', async () => {
  const { response, text, lines } = await call('GET', '/plain');
  expect(response.status).toBe(500);
  expect(lines).toHaveLength(1);
  const line = JSON.parse(lines[0]![0] as string);
  expect(line).toMatchObject({
    request_id: JSON.parse(text).request_id,
    method: 'GET',
    route: '/plain',
    name: 'Error',
  });
  expect('code' in line).toBe(false);
});

test('client errors write no internal error or deadline line', async () => {
  for (const path of ['/forbidden', '/missing']) {
    const { response, lines } = await call('GET', path);
    expect(response.status).toBeLessThan(500);
    expect(lines).toEqual([]);
  }
});

test('a deadline problem writes exactly one attributed line instead of an internal error line', async () => {
  const { response, text, lines } = await call('GET', '/deadline');
  expect(response.status).toBe(503);
  expect(JSON.parse(text).code).toBe('deadline_exceeded');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toHaveLength(1);
  const line = JSON.parse(lines[0]![0] as string);
  expect(line).toEqual({
    event: 'deadline_exceeded',
    request_id: JSON.parse(text).request_id,
    method: 'GET',
    route: '/deadline',
    elapsed_ms: expect.any(Number),
    phases_ms: expect.any(Object),
    contention_retries: 0,
    dominant_phase: 'before_command',
  });
});
