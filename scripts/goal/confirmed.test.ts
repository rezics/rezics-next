import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { notApplicable, outcomeTitle, personas, proved, rowOutcomes, type RowOutcomes } from '../qa/cases/outcome-cells.ts';
import { confirmedScopeReport, latestConfirmation, recordConfirmation, type ConfirmationRecord } from './confirmed.ts';
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
});

test('scope without a run retains declared figures', () => {
  const row = declaredOutcome('books/pass');
  expect(confirmedScopeReport([row], ['books/pass', 'books/undeclared'])).toBe(
    'No regression confirmation run yet; showing declared figures.\nbooks: declared proved 1/2; last run confirmed 0; saw fail 0\n  declared proved: books/pass');
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
