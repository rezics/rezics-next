import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OutcomeRecorder } from '../../tests/qa/support/outcome-test.ts';
import { proved, rowOutcomes } from '../qa/cases/outcome-cells.ts';
import { jsonSchema2020Tuples } from './generate.ts';
import { AnswerRecordValidator, answerPersonas, answerRecord, recordAnswer, redactAnswer,
  type AnswerContract, type AnswerRecord, type AnswerSample } from './answer-record.ts';

const sample: AnswerSample = { label: 'populated', operationId: 'browse', method: 'GET',
  path: '/v1/browse?limit=10&cursor=opaque%2Bcursor', status: 200, headers: { etag: '"head"' },
  answer: { id: 'https://rezics.com/id/123', at: '2026-10-13T12:34:56.000Z', nextCursor: 'opaque+cursor' } };

test('records labelled answers without measurements or rewriting API data', () => {
  const personas = Object.fromEntries(answerPersonas.map(persona => [persona, [sample]])) as AnswerRecord['personas'];
  const record = answerRecord('books/browse', personas);
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

test('generated nullable enums and constants preserve the authored null answer under JSON Schema validation', () => {
  const response = { type: 'object', required: ['status', 'policy'], properties: {
    status: { type: ['string', 'null'], enum: ['ongoing', 'completed'], nullable: true },
    policy: { type: ['string', 'null'], const: 'no-referrer', nullable: true },
  } };
  const tree = { paths: { '/v1/browse': { get: { operationId: 'browse', responses: {
    '200': { content: { 'application/json': { schema: response } } },
  } } } } };
  const generated = jsonSchema2020Tuples(tree) as AnswerContract;
  const validator = new AnswerRecordValidator(generated);
  const record = answerRecord('books/browse', Object.fromEntries(answerPersonas.map(persona => [persona,
    [{ ...sample, answer: { status: null, policy: null } }],
  ])) as AnswerRecord['personas']);
  validator.validate(record);
  record.personas.visitor[0]!.answer = { status: 'ongoing', policy: 'no-referrer' };
  validator.validate(record);
  record.personas.visitor[0]!.answer = { status: 'invented', policy: null };
  expect(() => validator.validate(record)).toThrow('/answer/status');
  expect(response.properties.status.enum).toEqual(['ongoing', 'completed']);
  expect(jsonSchema2020Tuples({ example: response })).toEqual({ example: response });
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

const declaration = rowOutcomes('books/browse', Object.fromEntries(answerPersonas.map(persona => [persona, proved('reads')] )));
function scratch() {
  mkdirSync('.temp/answer-record-tests', { recursive: true });
  return mkdtempSync(resolve('.temp/answer-record-tests/run-'));
}
const session = { main: async () => Response.json({ items: [], nextCursor: null }, {
  headers: { 'set-cookie': 'secret', 'server-timing': 'duration=3' },
}) };

test('the harness publishes once only after all six proofs pass, preserving the response for assertions', async () => {
  const directory = scratch();
  try {
    const recorder = new OutcomeRecorder(declaration, { directory, contract });
    for (const persona of answerPersonas) {
      await recorder.prove(persona, async () => {
        const response = await recorder.session(persona, session)('empty', 'GET', '/v1/browse?limit=10');
        expect(await response.json()).toEqual({ items: [], nextCursor: null });
      });
      if (persona !== 'operator') { await recorder.publish(); expect(existsSync(join(directory, 'books/browse.json'))).toBe(false); }
    }
    await recorder.publish();
    const file = join(directory, 'books/browse.json');
    const recorded = readFileSync(file, 'utf8');
    await recorder.publish();
    expect(readFileSync(file, 'utf8')).toBe(recorded);
    expect(recorded).not.toMatch(/secret|server-timing|elapsedSeconds|setupSeconds/);
    const validator = new AnswerRecordValidator(contract);
    validator.validate(JSON.parse(recorded));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed persona proof or an invalid sample publishes nothing', async () => {
  for (const invalidSample of [false, true]) {
    const directory = scratch();
    try {
      const recorder = new OutcomeRecorder(declaration, { directory, contract });
      for (const persona of answerPersonas) {
        const proof = recorder.prove(persona, async () => {
          await recorder.session(persona, session)('empty', 'GET', `/v1/browse?limit=${invalidSample ? 99 : 10}`);
          if (!invalidSample && persona === 'member') throw new Error('proof failed');
        });
        if (!invalidSample && persona === 'member') await expect(proof).rejects.toThrow('proof failed');
        else await proof;
      }
      if (invalidSample) await expect(recorder.publish()).rejects.toThrow('persona visitor, sample empty');
      else await recorder.publish();
      expect(existsSync(join(directory, 'books/browse.json'))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('setup calls cannot enter a persona outcome record', async () => {
  const directory = scratch();
  try {
    const recorder = new OutcomeRecorder(declaration, { directory, contract });
    await expect(recorder.session('owner', session)('setup', 'GET', '/v1/browse?limit=10'))
      .rejects.toThrow('active persona proof');
    for (const persona of answerPersonas) await recorder.prove(persona, async () => {
      await recorder.session(persona, session)('empty', 'GET', '/v1/browse?limit=10');
    });
    await recorder.publish();
    expect(existsSync(join(directory, 'books/browse.json'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('recording is off by default, and output cannot escape .temp or overwrite an existing record', async () => {
  const off = new OutcomeRecorder(declaration, { directory: '' });
  expect(await off.session('visitor', session)('unused', 'GET', '/not-a-contract-operation')).toBeInstanceOf(Response);
  await off.publish();
  for (const directory of ['tests/qa/fixtures', '.temp', '/tmp/answer-record'])
    expect(() => new OutcomeRecorder(declaration, { directory, contract })).toThrow('under .temp/');
  const directory = scratch();
  try {
    symlinkSync('/tmp', join(directory, 'escape'));
    expect(() => new OutcomeRecorder(declaration, { directory: join(directory, 'escape', 'records'), contract }))
      .toThrow('symlink escapes');
    const recorder = new OutcomeRecorder(declaration, { directory, contract });
    for (const persona of answerPersonas) await recorder.prove(persona, async () => {
      await recorder.session(persona, session)('empty', 'GET', '/v1/browse?limit=10');
    });
    await recorder.publish();
    const again = new OutcomeRecorder(declaration, { directory, contract });
    for (const persona of answerPersonas) await again.prove(persona, async () => {
      await again.session(persona, session)('empty', 'GET', '/v1/browse?limit=10');
    });
    await expect(again.publish()).rejects.toThrow('EEXIST');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a failed or timed out registered persona test cannot publish a record', async () => {
  const directory = scratch();
  try {
    for (const timeout of [false, true]) {
      const output = join(directory, timeout ? 'timeout' : 'failure');
      const file = join(directory, timeout ? 'timeout.test.ts' : 'failure.test.ts');
      writeFileSync(file, `import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { outcomeTest, OutcomeRecorder } from ${JSON.stringify(resolve('tests/qa/support/outcome-test.ts'))};
const declaration = ${JSON.stringify(declaration)};
const recorder = new OutcomeRecorder(declaration, { directory: ${JSON.stringify(output)}, contract: ${JSON.stringify(contract)} });
setDefaultTimeout(20);
afterAll(() => recorder.publish());
for (const persona of ${JSON.stringify(answerPersonas)}) outcomeTest(declaration, persona, async () => {
  await recorder.session(persona, { main: async () => Response.json({ items: [], nextCursor: null }) })('empty', 'GET', '/v1/browse?limit=10');
  if (persona === 'visitor') ${timeout ? 'await Bun.sleep(50)' : 'expect(false).toBe(true)'};
}, recorder);
test('wait for a late timed-out proof', () => Bun.sleep(70), 200);
`);
      const child = Bun.spawn(['bun', 'test', file], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, CLAUDECODE: '1' } });
      expect(await child.exited).not.toBe(0);
      expect(existsSync(join(output, 'books/browse.json'))).toBe(false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
