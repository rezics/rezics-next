import { expect, test } from 'bun:test';
import { answerPersonas, answerRecord, recordAnswer, redactAnswer, type AnswerSample } from './answer-record.ts';

const sample: AnswerSample = { label: 'populated', operationId: 'browse', method: 'GET',
  path: '/v1/browse?limit=10&cursor=opaque%2Bcursor', status: 200, headers: { etag: '"head"' },
  answer: { id: 'https://rezics.com/id/123', at: '2026-10-13T12:34:56.000Z', nextCursor: 'opaque+cursor' } };

test('records labelled answers without measurements or rewriting API data', () => {
  const personas = Object.fromEntries(answerPersonas.map(persona => [persona, [sample]]));
  const record = answerRecord('books/browse', personas as Record<typeof answerPersonas[number], AnswerSample[]>);
  expect(record).toEqual({ version: 1, row: 'books/browse', personas });
  expect(record.personas.visitor[0]).not.toBe(sample);
});

test('each credential kind is redacted in nested data and URLs', () => {
  for (const key of ['authorization', 'bearer', 'cookie', 'cookies', 'set-cookie', 'x-session-key',
    'sessionKey', 'session_token', 'access_token', 'refreshToken', 'id_token', 'password',
    'client_secret', 'api-key', 'credentials', 'idempotency-key', 'idempotencySecret']) {
    expect(redactAnswer({ nested: [{ [key]: 'secret', title: 'keep' }] })).toEqual({ nested: [{ title: 'keep' }] });
    expect(redactAnswer(`/next?${encodeURIComponent(key)}=secret&cursor=opaque`)).toBe('/next?redacted&cursor=opaque');
  }
  for (const text of ['Bearer secret', 'Cookie: secret', 'Authorization: secret', 'Idempotency-Key: secret'])
    expect(redactAnswer(text)).toBe('[redacted]');
});

test('only client response headers and application call fields cross the record boundary', () => {
  expect(recordAnswer({ ...sample, headers: { 'Content-Type': 'application/json', location: '/next',
    'retry-after': '2', etag: '"head"', 'cache-control': 'no-store', 'set-cookie': 'secret',
    authorization: 'Bearer secret', 'idempotency-key': 'secret', 'server-timing': 'duration=3' },
    elapsedSeconds: 2 } as AnswerSample)).toEqual({ operationId: sample.operationId, method: sample.method,
    path: sample.path, status: sample.status, answer: sample.answer, headers: { 'content-type': 'application/json',
      location: '/next', 'retry-after': '2', etag: '"head"', 'cache-control': 'no-store' } });
});
