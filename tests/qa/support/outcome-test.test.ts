import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadOutcomes } from '../../../scripts/qa/cases/outcomes.ts';
import { OutcomeRecorder, outcomeTest } from './outcome-test.ts';
import { notApplicable, proved, rowOutcomes } from '../../../scripts/qa/cases/outcome-cells.ts';
import { AnswerRecordValidator, answerPersonas, type AnswerContract, type AnswerRecord, type AnswerSample } from '../../../scripts/api/answer-record.ts';
import { assertAnswerContractDebts, matchesAnswerContractDebt } from './answer-contract-debts.ts';

test('binary capture retains only a verified repository asset descriptor and validates the declared media type', async () => {
  const source = 'tests/fixtures/recipes/original-tomato-method.wav';
  const bytes = readFileSync(resolve(root, source));
  const directory = mkdtempSync(resolve(root, '.temp/binary-answer-'));
  const declaration = rowOutcomes('recipes/instructions-in-any-form', Object.fromEntries(answerPersonas.map(persona => [persona, proved('reads exact bytes')])));
  const contract: AnswerContract = { paths: { '/v1/recording/bytes': { get: { operationId: 'recording-bytes', responses: {
    200: { content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } } },
  } } } } };
  const recorder = new OutcomeRecorder(declaration, { root, directory, contract, binarySources: [source] });
  try {
    for (const persona of answerPersonas) await recorder.prove(persona, async () => {
      const response = await recorder.session(persona, { main: async () => new Response(bytes, { headers: { 'content-type': 'audio/wav' } }) })(
        'recording-bytes', 'GET', '/v1/recording/bytes');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
    });
    await recorder.publish();
    const record = JSON.parse(readFileSync(resolve(directory, 'recipes/instructions-in-any-form.json'), 'utf8')) as AnswerRecord;
    expect(record.personas.visitor[0]).toMatchObject({ answer: null, binary: { source,
      byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } });
    expect(new AnswerRecordValidator(contract).validate(record)).toEqual(record);
    expect(new AnswerRecordValidator({ paths: { '/v1/recording/bytes': { get: { operationId: 'recording-bytes', responses: {
      200: { content: { 'application/json': { schema: {} } } },
    } } } } }).responseViolations(record.personas.visitor[0]!)).not.toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const root = resolve(import.meta.dir, '../../..');
const declarationsModule = join(root, 'scripts/qa/cases/outcome-cells.ts');
const helperModule = join(import.meta.dir, 'outcome-test.ts');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(state: 'proved' | 'pending', passing: boolean) {
  const directory = mkdtempSync(join(root, '.temp/outcome-test-'));
  directories.push(directory);
  const declaration = join(directory, 'scripts/qa/cases/outcomes/books/read-a-book.ts');
  const file = join(directory, 'tests/qa/integration/outcomes/books/read-a-book.test.ts');
  mkdirSync(dirname(declaration), { recursive: true });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    declaration,
    `import { rowOutcomes, ${state} } from ${JSON.stringify(declarationsModule)};
export default rowOutcomes('books/read-a-book', { visitor: ${state}('a visitor reads the book') });`,
  );
  writeFileSync(
    file,
    `import { expect } from 'bun:test';
import declaration from ${JSON.stringify(declaration)};
import { outcomeTest } from ${JSON.stringify(helperModule)};
outcomeTest(declaration, 'visitor', async () => { await Promise.resolve(); expect(${passing}).toBe(true); });`,
  );
  return { directory, file };
}

test('outcomeTest throws at load for missing and not-applicable cells', () => {
  const declaration = rowOutcomes('books/read-a-book', {
    operator: notApplicable('No operator action'),
  });
  expect(() => outcomeTest(declaration, 'visitor', () => {})).toThrow(
    'No outcome test for books/read-a-book / visitor',
  );
  expect(() => outcomeTest(declaration, 'operator', () => {})).toThrow(
    'No outcome test for books/read-a-book / operator',
  );
});

test('proved outcomes run normally; pending outcomes go red when they start passing', async () => {
  for (const state of ['proved', 'pending'] as const) {
    for (const passing of [false, true]) {
      const data = fixture(state, passing);
      const loaded = await loadOutcomes({
        root: data.directory,
        registry: [{ kind: 'books', capability: 'Read a book' }],
      });
      expect(loaded.get('books/read-a-book')?.cells.visitor?.state).toBe(state);
      const result = spawnSync(process.execPath, ['test', data.file], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(state === 'proved' ? (passing ? 0 : 1) : passing ? 1 : 0);
    }
  }
}, 30_000);

test('pending assertion mode reports real process failure and preserves the pending declaration', async () => {
  for (const passing of [false, true]) {
    const data = fixture('pending', passing);
    const declarationFile = join(data.directory, 'scripts/qa/cases/outcomes/books/read-a-book.ts');
    writeFileSync(data.file, `import { expect } from 'bun:test';
import declaration from ${JSON.stringify(declarationFile)};
import { outcomeTest } from ${JSON.stringify(helperModule)};
outcomeTest(declaration, 'visitor', async () => { expect(${passing}).toBe(true); }, undefined, { pending: 'assert' });`);
    const loaded = await loadOutcomes({ root: data.directory,
      registry: [{ kind: 'books', capability: 'Read a book' }] });
    expect(loaded.get('books/read-a-book')?.cells.visitor?.state).toBe('pending');
    const result = spawnSync(process.execPath, ['test', data.file], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, CLAUDECODE: '1' },
    });
    expect(result.status, result.stdout + result.stderr).toBe(passing ? 0 : 1);
  }
});

const contract: AnswerContract = { paths: { '/v1/example': { get: {
  operationId: 'example', parameters: [{ name: 'requiredQuery', in: 'query', required: true, schema: { type: 'string' } }],
  responses: {
    '200': { content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['title', 'nested'], properties: {
        title: { type: 'string' }, nested: { type: 'object', additionalProperties: false,
          required: ['count'], properties: { count: { type: 'number' } } },
      },
    } } } },
    '400': { content: { 'application/json': { schema: { type: 'object', required: ['code'],
      properties: { code: { type: 'string' } } } } } },
    '204': {},
  },
} } } };
const declaration = rowOutcomes('books/read-a-book', { member: proved('reads') });
const conforming = { title: 'Title', nested: { count: 1 } };
const debt = { operationId: 'example', status: 200, path: '/answer/title', date: '2026-10-14' };
function responseSample(answer: unknown = conforming, status = 200): AnswerSample {
  return { label: 'read', operationId: 'example', method: 'GET', path: '/v1/example', status, answer,
    headers: { 'content-type': 'application/json' } };
}
function proof(answer: unknown, status = 200, options: ConstructorParameters<typeof OutcomeRecorder>[1] = {}) {
  const recorder = new OutcomeRecorder(declaration, { directory: '', contract, ...options });
  const request = recorder.session('member', { main: async () => Response.json(answer, { status }) });
  return recorder.prove('member', async () => { await request('read', 'GET', '/v1/example'); });
}

test('normal proofs check conforming answers and leave requests and returned bodies alone', async () => {
  const recorder = new OutcomeRecorder(declaration, { directory: '', contract });
  await recorder.prepare();
  await recorder.prove('member', async () => {
    const response = await recorder.session('member', { main: async () => Response.json(conforming) })(
      'read', 'GET', '/v1/example', { invalidRequest: true },
    );
    expect(await response.json()).toEqual(conforming);
  });
  await recorder.publish();
});

test('each invalid answer fails its persona proof immediately with the full context', async () => {
  for (const [answer, status, path, expected, received] of [
    [{ ...conforming, title: 4 }, 200, '/answer/title', 'string', 'number'],
    [{ ...conforming, extra: true }, 200, '/answer/extra', 'absent (closed schema)', 'boolean'],
    [conforming, 202, '/status', 'declared status', 'number'],
    [{ ...conforming, nested: { count: 'one' } }, 200, '/answer/nested/count', 'number', 'string'],
    [{ code: 5 }, 400, '/answer/code', 'string', 'number'],
  ] as const) {
    try { await proof(answer, status); throw new Error('Expected a contract violation'); }
    catch (error) {
      const message = (error as Error).message;
      for (const fact of ['row books/read-a-book', 'persona member', 'sample read', 'operation example',
        `status ${status}`, path, `expected ${expected}`, `received ${received}`]) expect(message).toContain(fact);
    }
  }
});

test('a caught sample violation still fails that persona, without poisoning other personas', async () => {
  const recorder = new OutcomeRecorder(declaration, { directory: '', contract });
  await expect(recorder.prove('member', async () => {
    try {
      await recorder.session('member', { main: async () => Response.json({ ...conforming, title: 4 }) })(
        'read', 'GET', '/v1/example',
      );
    } catch { /* A refusal helper may catch a request; it cannot hide a broken answer. */ }
  })).rejects.toThrow('/answer/title');
  await recorder.prove('visitor', async () => {
    await recorder.session('visitor', { main: async () => Response.json(conforming) })('read', 'GET', '/v1/example');
  });
});

test('an unparseable answer still reports its persona and operation context', async () => {
  const recorder = new OutcomeRecorder(declaration, { directory: '', contract });
  await expect(recorder.prove('member', async () => {
    await recorder.session('member', { main: async () => new Response('broken JSON', { status: 200 }) })(
      'read', 'GET', '/v1/example',
    );
  })).rejects.toThrow('row books/read-a-book, persona member, sample read, operation example, status 200, /answer: expected JSON, received string');
});

test('a debt silences exactly its operation, status and member, including in a recording', async () => {
  await proof({ ...conforming, title: 4 }, 200, { debts: [debt] });
  await expect(proof({ title: 4, nested: { count: 'one' } }, 200, { debts: [debt] }))
    .rejects.toThrow('/answer/nested/count');
  await expect(proof({ ...conforming, title: 4 }, 200, { debts: [{ ...debt, status: 400 }] }))
    .rejects.toThrow('/answer/title');
  await expect(proof({ ...conforming, title: 4 }, 200, { debts: [{ ...debt, operationId: 'other' }] }))
    .rejects.toThrow('/answer/title');
  const validator = new AnswerRecordValidator(contract);
  const violation = validator.responseViolations(responseSample({ ...conforming, nested: { count: 'one' } }))[0]!;
  expect(matchesAnswerContractDebt(violation, [{ ...debt, path: '/answer/nested' }])).toBe(false);

  const directory = mkdtempSync(join(root, '.temp/outcome-debt-'));
  directories.push(directory);
  const recordedDeclaration = rowOutcomes('books/read-a-book', Object.fromEntries(answerPersonas.map(persona => [persona, proved('reads')])));
  const recorder = new OutcomeRecorder(recordedDeclaration, { directory, contract, debts: [debt] });
  for (const persona of answerPersonas) await recorder.prove(persona, async () => {
    await recorder.session(persona, { main: async () => Response.json({ ...conforming, title: 4 }) })(
      'read', 'GET', '/v1/example?requiredQuery=present',
    );
  });
  await recorder.publish();
  const record = JSON.parse(readFileSync(join(directory, 'books/read-a-book.json'), 'utf8')) as AnswerRecord;
  expect(record.personas.member[0]!.answer).toEqual({ ...conforming, title: 4 });
});

test('closed schemas identify each extra member, with escaped JSON pointers', () => {
  const validator = new AnswerRecordValidator(contract);
  const violations = validator.responseViolations(responseSample({ ...conforming, 'a/b~c': true, other: 1 }));
  expect(violations.some(violation => violation.path === '/answer/a~1b~0c' && violation.expected === 'absent (closed schema)')).toBe(true);
  expect(violations.some(violation => violation.path === '/answer/other')).toBe(true);
  expect(violations.filter(violation => !matchesAnswerContractDebt(violation, [{ ...debt, path: '/answer/a~1b~0c' }]))
    .every(violation => violation.path === '/answer/other')).toBe(true);
});

test('debts cannot hide later violations behind the validator diagnostic limit', async () => {
  const extras = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`extra${index}`, true]));
  const debts = Array.from({ length: 11 }, (_, index) => ({ ...debt, path: `/answer/extra${index}` }));
  await expect(proof({ ...conforming, ...extras }, 200, { debts })).rejects.toThrow('/answer/extra11');
});

test('bodyless answers, undeclared operations and missing members are checked without request validation', () => {
  const validator = new AnswerRecordValidator(contract);
  expect(validator.responseViolations(responseSample(null, 204))).toEqual([]);
  expect(validator.responseViolations(responseSample({}, 204))[0]).toMatchObject({ path: '/answer', expected: 'null', received: 'object' });
  expect(validator.responseViolations({ ...responseSample(), operationId: 'renamed' })[0]?.path).toBe('/operationId');
  expect(validator.responseViolations(responseSample({ nested: { count: 1 } }))[0]).toMatchObject({ path: '/answer/title', expected: 'string', received: 'undefined' });
});

test('a repaired or unobserved debt fails; any matching violation keeps the exact entry', () => {
  const validator = new AnswerRecordValidator(contract);
  const violations = validator.responseViolations(responseSample({ ...conforming, title: 4 }));
  expect(() => assertAnswerContractDebts(violations, [debt])).not.toThrow();
  expect(() => assertAnswerContractDebts([], [debt])).toThrow('Stale answer contract debts: example, status 200, /answer/title');
  expect(() => assertAnswerContractDebts(violations, [{ ...debt, path: '/answer/nested' }])).toThrow('Stale answer contract debts');
});

test('registered normal and pending outcome tests both validate their samples without recording', () => {
  for (const state of ['proved', 'pending'] as const) {
    const data = fixture(state, true);
    writeFileSync(data.file, `import { outcomeTest, OutcomeRecorder } from ${JSON.stringify(helperModule)};
import declaration from ${JSON.stringify(join(data.directory, 'scripts/qa/cases/outcomes/books/read-a-book.ts'))};
const recorder = new OutcomeRecorder(declaration, { directory: '', contract: ${JSON.stringify(contract)} });
outcomeTest(declaration, 'visitor', async () => {
  await recorder.session('visitor', { main: async () => Response.json({ title: 4, nested: { count: 1 } }) })('read', 'GET', '/v1/example');
}, recorder);`);
    const result = spawnSync(process.execPath, ['test', data.file], {
      cwd: root, encoding: 'utf8', timeout: 10_000, env: { ...process.env, CLAUDECODE: '1' },
    });
    expect(result.status, result.stdout + result.stderr).toBe(state === 'proved' ? 1 : 0);
  }
});
