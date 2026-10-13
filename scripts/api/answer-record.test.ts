import { expect, test } from 'bun:test';
import { AnswerRecordValidator, answerPersonas, answerRecord, recordAnswer, redactAnswer,
  type AnswerContract, type AnswerRecord, type AnswerSample } from './answer-record.ts';

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

const contract: AnswerContract = {
  components: { schemas: {
    Page: { type: 'object', additionalProperties: false, required: ['items', 'nextCursor'], properties: {
      items: { type: 'array', items: { oneOf: [
        { type: 'object', required: ['kind', 'title'], properties: { kind: { const: 'book' }, title: { type: 'string' } } },
        { type: 'object', required: ['kind', 'count'], properties: { kind: { const: 'collection' }, count: { type: 'integer' } } },
      ] } }, nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    } },
    Problem: { type: 'object', required: ['code', 'status'], properties: {
      code: { const: 'unsupported_query_shape' }, status: { const: 400 },
    } },
  }, responses: { badQuery: { content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } } } },
  paths: { '/v1/browse': { get: { operationId: 'browse', parameters: [
    { name: 'limit', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 20 } },
  ], responses: {
    '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } },
    '400': { $ref: '#/components/responses/badQuery' },
  } } } },
};
function validRecord(): AnswerRecord {
  const samples: AnswerSample[] = [{ ...sample, answer: { items: [{ kind: 'book', title: 'Seed' },
    { kind: 'collection', count: 2 }], nextCursor: null } }, { ...sample, label: 'refused', path: '/v1/browse?limit=bad',
    status: 400, headers: { 'content-type': 'application/problem+json' }, answer: { code: 'unsupported_query_shape', status: 400 } }];
  return answerRecord('books/browse', Object.fromEntries(answerPersonas.map(persona => [persona, samples])) as AnswerRecord['personas']);
}

test('validates local references, unions, nullable values, numeric wire queries and referenced problem responses', () => {
  const validator = new AnswerRecordValidator(contract);
  const record = validRecord();
  const before = JSON.stringify(record);
  validator.validate(record);
  expect(JSON.stringify(record)).toBe(before);
});

test('names the row, persona, sample and JSON pointer on a changed nested field', () => {
  const record = validRecord();
  record.personas.member[0]!.answer = { items: [{ kind: 'book', title: 3 }], nextCursor: null };
  expect(() => new AnswerRecordValidator(contract).validate(record)).toThrow(/row books\/browse, persona member, sample populated, \/personas\/member\/0\/answer\/items\/0/);
});

test('rejects missing operations, wrong method/path, undeclared statuses, query bounds and invalid problems', () => {
  for (const [field, value] of [['operationId', 'renamed'], ['method', 'POST'], ['path', '/v1/missing'],
    ['status', 202], ['path', '/v1/browse?limit=21'], ['path', '/v1/browse?limit=no'], ['path', '/v1/browse']] as const) {
    const record = validRecord();
    Object.assign(record.personas.visitor[0]!, { [field]: value });
    expect(() => new AnswerRecordValidator(contract).validate(record)).toThrow('persona visitor, sample populated');
  }
  const record = validRecord();
  record.personas.operator[1]!.answer = { code: 'invented', status: 400 };
  expect(() => new AnswerRecordValidator(contract).validate(record)).toThrow('/answer/code');
});

test('rejects incomplete or non-application envelopes and credentials in checked-in records', () => {
  for (const change of [{ version: 2 }, { setupSeconds: 1 }, { fingerprint: 'not-a-proof' }, { personas: {} }])
    expect(() => new AnswerRecordValidator(contract).validate({ ...validRecord(), ...change })).toThrow('row books/browse');
  const record = validRecord();
  record.personas.owner[0]!.headers['set-cookie'] = 'secret';
  expect(() => new AnswerRecordValidator(contract).validate(record)).toThrow('persona owner');
  delete record.personas.owner[0]!.headers['set-cookie'];
  record.personas.owner[0]!.body = { idempotencyKey: 'secret' };
  expect(() => new AnswerRecordValidator(contract).validate(record)).toThrow('Record contains credentials');
});
