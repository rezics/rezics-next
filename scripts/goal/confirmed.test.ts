import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { notApplicable, outcomeTitle, pending, personas, proved, rowOutcomes, type RowOutcomes } from '../qa/cases/outcome-cells.ts';
import { cellReading, confirmationCounts, confirmedScopeReport, latestConfirmation, recordConfirmation, type ConfirmationRecord } from './confirmed.ts';
import type { Manifest } from './regress.ts';

export function declaredOutcome(rowId: string): RowOutcomes {
  return rowOutcomes(rowId, Object.fromEntries(personas.map(persona => [persona,
    persona === 'visitor' ? proved('gets the outcome') : notApplicable('No distinct action')])));
}

test('scope names a declared proof that failed before vertical figures, and includes commit and age', () => {
  const rows = [declaredOutcome('books/pass'), declaredOutcome('books/fail'), declaredOutcome('games/missing')];
  const record: ConfirmationRecord = { version: 1, runId: 'fixture', atCommit: 'pinned-commit',
    startedAt: '2026-10-13T00:00:00Z', recordedAt: '2026-10-13T01:00:00Z',
    outcomes: rows.map((row, index) => ({ rowId: row.rowId, persona: 'visitor', file: row.cells.visitor?.state === 'proved' ? row.cells.visitor.file! : '',
      test: outcomeTitle(row, 'visitor'), status: index === 0 ? 'passed' : index === 1 ? 'failed' : 'missing', expectedFailure: false })) };
  const report = confirmedScopeReport(rows, rows.map(row => row.rowId), record, Date.parse('2026-10-13T03:00:00Z'));
  expect(report).toContain('pinned-commit; age 2.0h');
  expect(report.split('\n')[1]).toBe('Declared proved rows seen failing: books/fail');
  expect(report).toContain('books: declared proved 2/2; last run confirmed 1; saw fail 1');
  expect(report).toContain('games: declared proved 1/1; last run confirmed 0; saw fail 0');
  for (const status of ['skipped', 'missing'] as const) {
    record.outcomes[0]!.status = status;
    expect(confirmedScopeReport(rows, ['books/pass'], record)).toContain('last run confirmed 0');
  }
  record.outcomes[0]!.status = 'passed'; record.outcomes[0]!.expectedFailure = true;
  expect(confirmedScopeReport(rows, ['books/pass'], record)).toContain('last run confirmed 0');
  record.outcomes[0]!.status = 'failed';
  expect(cellReading(record.outcomes[0]!)).toBe('not run');
});

test('scope without a run retains declared figures', () => {
  const row = declaredOutcome('books/pass');
  expect(confirmedScopeReport([row], ['books/pass', 'books/undeclared'])).toBe(
    'No confirmation run yet; showing declared figures.\nbooks: declared proved 1/2; last run confirmed 0; saw fail 0\n  declared proved: books/pass');
});

test('cell evidence has five readings, with pending timeouts and preparation failures left unconfirmed', () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync('.temp/readings-');
  try {
    const cases = [
      ['pass', proved('gets the outcome'), ''],
      ['fail', proved('gets the outcome'), '<failure message="assertion failed"/>'],
      ['still', pending('gets the outcome'), ''],
      ['now', pending('gets the outcome'), '<failure message="test marked with .failing() did not throw"/>'],
      ['skip', proved('gets the outcome'), '<skipped/>'],
      ['timeout', pending('gets the outcome'), '<failure type="TimeoutError" message="test timed out"/>'],
      ['preparation', pending('gets the outcome'), '<failure type="JourneyPreparationError" message="fixture refused"/>'],
    ] as const;
    const rows = cases.map(([id, cell]) => rowOutcomes(`books/${id}`, { visitor: cell }));
    const manifest = { runId: 'readings', atCommit: 'main', startedAt: new Date().toISOString(), checkout: directory,
      batches: [{ tier: 'integration', files: rows.map(row => row.cells.visitor!.state === 'notApplicable' ? '' : row.cells.visitor!.file!),
        attempts: [{ artifactPaths: [directory] }] }] } as Manifest;
    writeFileSync(join(directory, 'integration.xml'), `<testsuite>${rows.map((row, index) =>
      `<testcase name="${outcomeTitle(row, 'visitor')}" file="tests/qa/integration/outcomes/${row.rowId}.test.ts">${cases[index]![2]}</testcase>`).join('')}</testsuite>`);
    const record = recordConfirmation(directory, join(directory, 'run'), manifest, rows);
    expect(record.outcomes.map(cellReading)).toEqual(['passed', 'failed', 'pending and still failing', 'pending and now passing', 'not run', 'not run', 'not run']);
    expect(confirmationCounts(record)).toEqual({ passed: 1, failed: 1, 'pending and still failing': 1, 'pending and now passing': 1, 'not run': 3 });
    const report = confirmedScopeReport(rows, rows.map(row => row.rowId), record);
    expect(report).toContain('books/fail / visitor: failed (tests/qa/integration/outcomes/books/fail.test.ts)');
    expect(report).toContain('books/now / visitor: pending and now passing (tests/qa/integration/outcomes/books/now.test.ts)');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing and infrastructure evidence cannot confirm cells, and an older run cannot replace the latest', () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync('.temp/confirmed-');
  try {
    const row = declaredOutcome('books/pass');
    const manifest = { runId: 'newer', atCommit: 'new', startedAt: '2026-10-13T02:00:00Z', checkout: directory,
      batches: [{ tier: 'integration', files: [row.cells.visitor?.state === 'proved' ? row.cells.visitor.file! : ''],
        attempts: [{ classification: 'infrastructure', artifactPaths: [directory] }] }] } as Manifest;
    writeFileSync(join(directory, 'integration.xml'), `<testsuite><testcase name="${outcomeTitle(row, 'visitor')}" file="tests/qa/integration/outcomes/books/pass.test.ts"/></testsuite>`);
    const record = recordConfirmation(directory, join(directory, 'newer'), manifest, [row]);
    expect(record.outcomes[0]!.status).toBe('missing');
    expect(JSON.parse(readFileSync(join(directory, 'newer/confirmed.json'), 'utf8'))).toEqual(record);
    manifest.runId = 'older'; manifest.startedAt = '2026-10-13T01:00:00Z';
    recordConfirmation(directory, join(directory, 'older'), manifest, [row]);
    expect(latestConfirmation(directory)?.runId).toBe('newer');
    expect(latestConfirmation(join(directory, 'absent'))).toBeUndefined();
    // A broken batch cannot certify a pass, but its completed assertion still says what failed.
    writeFileSync(join(directory, 'integration.xml'), `<testsuite><testcase name="${outcomeTitle(row, 'visitor')}" file="tests/qa/integration/outcomes/books/pass.test.ts"><failure message="outcome failed"/></testcase></testsuite>`);
    const failed = recordConfirmation(directory, join(directory, 'older'), manifest, [row]);
    expect(failed.outcomes[0]!.status).toBe('failed');
    expect(confirmedScopeReport([row], [row.rowId], failed)).toContain('Declared proved rows seen failing: books/pass');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a private confirmation keeps run evidence without creating or replacing the main judge', () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync('.temp/private-confirmed-');
  try {
    const row = declaredOutcome('books/pass');
    const manifest = { runId: 'wave', atCommit: 'wave', startedAt: '2026-10-13T02:00:00Z', checkout: directory,
      batches: [] } as unknown as Manifest;
    const privateRecord = recordConfirmation(directory, join(directory, 'wave'), manifest, [row], undefined, false);
    expect(latestConfirmation(directory)).toBeUndefined();
    expect(latestConfirmation(join(directory, 'wave'))).toEqual(privateRecord);
    manifest.runId = 'main'; manifest.atCommit = 'main';
    recordConfirmation(directory, join(directory, 'main'), manifest, [row]);
    const judge = readFileSync(join(directory, 'confirmed.json'), 'utf8');
    manifest.runId = 'wave'; manifest.atCommit = 'wave';
    recordConfirmation(directory, join(directory, 'wave'), manifest, [row], undefined, false);
    expect(readFileSync(join(directory, 'confirmed.json'), 'utf8')).toBe(judge);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
