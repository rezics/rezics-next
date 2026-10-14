import { spawnSync } from 'node:child_process';
import { beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AnswerRecordValidator, answerPersonas, answerRecordViolations, type AnswerContract, type AnswerRecord } from './answer-record.ts';
import { buildMainOpenApi } from './generate.ts';
import { answerContractDebts, answerContractDebtWitnesses, assertAnswerContractDebts, matchesAnswerContractDebt } from '../../tests/qa/support/answer-contract-debts.ts';

const root = resolve(import.meta.dir, '../..');
let contract: AnswerContract;
let contractSource: string;
beforeAll(async () => { contractSource = await buildMainOpenApi(); contract = JSON.parse(contractSource) as AnswerContract; }, 60_000);

test('the contract used by proof processes is the freshly generated declared contract', () => {
  expect(readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8') === contractSource,
    'Generated proof contract is stale; run task gen').toBe(true);
});

test('every debt still matches a response violation against the fresh contract', () => {
  const validator = new AnswerRecordValidator(contract);
  const violations = [...new Bun.Glob('tests/qa/fixtures/outcomes/**/*.json').scanSync({ cwd: root })].flatMap(file => {
    const record = JSON.parse(readFileSync(join(root, file), 'utf8')) as AnswerRecord;
    return answerPersonas.flatMap(persona => record.personas[persona].flatMap(sample =>
      answerContractDebts.some(debt => debt.operationId === sample.operationId && debt.status === sample.status)
        ? validator.responseViolations(sample) : []));
  });
  violations.push(...answerContractDebtWitnesses.flatMap(sample => validator.responseViolations(sample)));
  assertAnswerContractDebts(violations);
  expect(violations.filter(violation => !matchesAnswerContractDebt(violation))).toEqual([]);
}, 30_000);

test('every checked-in outcome answer record validates against the contract generated from this tree', () => {
  expect(answerRecordViolations(root, contract)).toEqual([]);
}, 30_000);

test('the inventory guard catches a renamed operation and a changed answer field in a fixture record', () => {
  // An isolated copy exercises the inventory reader as well as the schema validator.
  const relative = 'tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
  const original = JSON.parse(readFileSync(join(root, relative), 'utf8')) as AnswerRecord;
  mkdirSync(join(root, '.temp/answer-record-guard'), { recursive: true });
  const scratch = mkdtempSync(join(root, '.temp/answer-record-guard/run-'));
  expect(spawnSync('git', ['init', '-q', scratch]).status).toBe(0);
  const file = join(scratch, relative);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(original));
    expect(answerRecordViolations(scratch, contract)).toEqual([]);
    const renamed = structuredClone(original);
    renamed.personas.visitor[0]!.operationId += 'Renamed';
    writeFileSync(file, JSON.stringify(renamed));
    expect(answerRecordViolations(scratch, contract)[0]).toContain('/operationId');
    const changed = structuredClone(original);
    const sample = changed.personas.member.find(sample => sample.label === 'search-no-match')!;
    (sample.answer as { items: unknown }).items = 'schema drift';
    writeFileSync(file, JSON.stringify(changed));
    const failure = answerRecordViolations(scratch, contract)[0]!;
    expect(failure).toContain('row books/catalogue-browse-and-search-in-its-zone, persona member, sample search-no-match');
    expect(failure).toContain('/answer/items');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30_000);
