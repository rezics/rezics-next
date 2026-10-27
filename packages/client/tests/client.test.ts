import { expect, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER, type KernelClient } from '../src/index.ts';

const ORIGIN = 'https://kernel.test';
const ID = '019a1b2c-3d4e-7f00-8a00-000000000001';
const subject = {
  id: ID,
  type: 'schema:Book',
  revision: 1,
  release: 'bundled',
  context: '019a1b2c-3d4e-7f00-8a00-000000000002',
  resolution: {},
  labels: { en: '1984' },
  descriptions: { en: '2024-01-01' },
  aliases: {},
  statements: {},
};

type Sent = { url: string; method: string; headers: Headers; body: string | null };

/** A fetch that records each request and answers with the next of `answers`. */
function kernel(answers: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === null ? null : await request.text(),
    });
    return answers.shift()!();
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json', ...headers },
  });

test('a subject read answers like an Eden Treaty call, with the JSON as the kernel sent it', async () => {
  const { sent, fetch } = kernel([() => json(200, { subject, account: null, summary: null, related: {} })]);
  const client = createKernelClient(ORIGIN, { fetch });
  const { data, error, status } = await client.subjects({ id: ID }).get();
  expect(sent.map(({ url, method }) => [url, method])).toEqual([[`${ORIGIN}/v1/subjects/${ID}`, 'GET']]);
  expect(status).toBe(200);
  expect(error).toBeNull();
  expect(data).toEqual({ subject, account: null, summary: null, related: {} });
  expect(typeof data?.subject.descriptions.en).toBe('string');
});

test('a problem is the error value and no data', async () => {
  const problem = {
    type: 'https://rezics.com/problems/not_found',
    title: 'Not Found',
    status: 404,
    code: 'not_found',
    retryable: false,
    effect_status: 'not_applicable',
    request_id: '019a1b2c-3d4e-7f00-8a00-0000000000ff',
  };
  const { fetch } = kernel([() => json(404, problem)]);
  const { data, error, status } = await createKernelClient(ORIGIN, { fetch }).subjects({ id: ID }).get();
  expect(status).toBe(404);
  expect(data).toBeNull();
  expect(error).toMatchObject({ status: 404, value: problem });
});

test('the client sends back the session token the kernel last gave it', async () => {
  const { sent, fetch } = kernel([
    () => json(200, { subject, summary: null, related: {} }, { [SESSION_HEADER]: 'first' }),
    () => json(200, { subject, summary: null, related: {} }),
    () => json(200, { subject, summary: null, related: {} }, { [SESSION_HEADER]: 'second' }),
    () => json(200, { subject, summary: null, related: {} }),
  ]);
  const tokens: string[] = [];
  const client = createKernelClient(ORIGIN, {
    fetch,
    headers: { authorization: 'Bearer reader' },
    session: 'earlier',
    onSession: (token) => tokens.push(token),
  });
  for (let n = 0; n < 4; n++) await client.subjects({ id: ID }).get();
  expect(SESSION_HEADER).toBe('rezics-session-token');
  expect(sent.map(({ headers }) => headers.get(SESSION_HEADER))).toEqual(['earlier', 'first', 'first', 'second']);
  expect(sent.every(({ headers }) => headers.get('authorization') === 'Bearer reader')).toBe(true);
  expect(tokens).toEqual(['first', 'second']);
});

test("a create sends its idempotency key and JSON body, as the kernel's route types require", async () => {
  const { sent, fetch } = kernel([() => json(201, { subject }, { location: `/v1/subjects/${ID}` })]);
  const client: KernelClient = createKernelClient(ORIGIN, { fetch });
  const body = { type: 'schema:Book', labels: { en: '1984' } };
  const { data, status } = await client.subjects.post(body, { headers: { 'idempotency-key': '"k-1"' } });
  expect(status).toBe(201);
  expect(data?.subject.id).toBe(ID);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ url: `${ORIGIN}/v1/subjects`, method: 'POST', body: JSON.stringify(body) });
  expect(sent[0]!.headers.get('idempotency-key')).toBe('"k-1"');
  expect(sent[0]!.headers.get('content-type')).toBe('application/json');

  // Compile-time only: the types come from the kernel's routes.
  const typed = async () => {
    // @ts-expect-error a create needs its idempotency key
    await client.subjects.post(body);
    // @ts-expect-error an item needs labels
    await client.subjects.post({}, { headers: { 'idempotency-key': '"k-2"' } });
    // @ts-expect-error there is no such route
    await client.things.get();
  };
  expect(typeof typed).toBe('function');
});
