import { beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { answerRecordViolations, type AnswerContract, type AnswerRecord } from './answer-record.ts';
import { buildMainOpenApi } from './generate.ts';

const root = resolve(import.meta.dir, '../..');
let contract: AnswerContract;
beforeAll(async () => { contract = JSON.parse(await buildMainOpenApi()) as AnswerContract; }, 60_000);

test('every checked-in outcome answer record validates against the contract generated from this tree', () => {
  expect(answerRecordViolations(root, contract)).toEqual([]);
});

test('the inventory guard catches a renamed operation and a changed answer field in a fixture record', () => {
  // An isolated copy exercises the inventory reader as well as the schema validator.
  const relative = 'tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
  const original = JSON.parse(readFileSync(join(root, relative), 'utf8')) as AnswerRecord;
  mkdirSync(join(root, '.temp/answer-record-guard'), { recursive: true });
  const scratch = mkdtempSync(join(root, '.temp/answer-record-guard/run-'));
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
});
