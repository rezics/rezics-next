import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJUnit, type TestResult } from '../qa/acceptance.ts';
import { outcomeTitle, personas, type Persona, type RowOutcomes } from '../qa/cases/outcome-cells.ts';
import type { Manifest } from './regress.ts';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';

export interface ConfirmedOutcome {
  rowId: string;
  persona: Persona;
  file: string;
  test: string;
  status: 'passed' | 'failed' | 'skipped' | 'missing';
  expectedFailure: boolean;
  reading?: CellReading;
}

export const cellReadings = ['passed', 'failed', 'pending and still failing', 'pending and now passing', 'not run'] as const;
export type CellReading = typeof cellReadings[number];

/** Legacy red pending cases lack the message needed to distinguish an unexpected pass from a timeout. */
export function cellReading(cell: ConfirmedOutcome): CellReading {
  return cell.reading ?? (cell.status === 'missing' || cell.status === 'skipped' ? 'not run'
    : cell.expectedFailure ? cell.status === 'passed' ? 'pending and still failing' : 'not run'
      : cell.status);
}

export function confirmationCounts(record?: ConfirmationRecord): Record<CellReading, number> {
  const counts = Object.fromEntries(cellReadings.map(reading => [reading, 0])) as Record<CellReading, number>;
  for (const cell of record?.outcomes ?? []) counts[cellReading(cell)]++;
  return counts;
}

export function batchTestResults(manifest: Manifest, batch: Manifest['batches'][number]): TestResult[] {
  const results: TestResult[] = [];
  for (const path of new Set(batch.attempts.at(-1)?.artifactPaths ?? [])) {
    const xml = join(path, `${batch.tier.replaceAll('/', '-')}.xml`);
    if (existsSync(xml)) results.push(...parseJUnit(readFileSync(xml, 'utf8'), 'integration', { root: manifest.checkout }));
  }
  return results;
}

export type ConfirmationStop = 'preempted' | 'SIGTERM' | 'SIGINT' | 'aborted';

export interface ConfirmationRecord {
  version: 1;
  runId: string;
  atCommit: string;
  startedAt: string;
  recordedAt: string;
  outcomes: ConfirmedOutcome[];
  stopped?: ConfirmationStop;
}

function writeRecord(path: string, record: ConfirmationRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, path);
}

export function latestConfirmation(stateDir: string): ConfirmationRecord | undefined {
  const path = join(stateDir, 'confirmed.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ConfirmationRecord : undefined;
}

/** Initial batch evidence judges the pinned scope; diagnosis probes cannot turn it green. */
export function confirmationRecord(manifest: Manifest & { stopped?: ConfirmationStop },
  declarations: readonly RowOutcomes[], recordedAt = new Date().toISOString()): ConfirmationRecord {
  const outcomes: ConfirmedOutcome[] = [];
  for (const declaration of declarations) for (const persona of personas) {
    const cell = declaration.cells[persona];
    if (!cell || cell.state === 'notApplicable') continue;
    const file = cell.file!;
    const title = outcomeTitle(declaration, persona);
    const batch = manifest.batches.find(batch => batch.files.includes(file));
    const attempt = batch?.attempts.at(-1);
    const results = batch ? batchTestResults(manifest, batch)
      .filter(test => test.file === file && (test.name === title || test.name.endsWith(` > ${title}`))) : [];
    const status = results.some(test => test.failed) ? 'failed'
      : results.some(test => test.skipped) ? 'skipped'
        : results.length && attempt?.classification !== 'infrastructure' ? 'passed' : 'missing';
    const expectedFailure = cell.state === 'pending';
    const failed = results.filter(test => test.failed);
    const reading: CellReading = status === 'skipped' || status === 'missing' ? 'not run'
      : !expectedFailure ? status
        : status === 'passed' ? 'pending and still failing'
          : failed.length > 0 && failed.every(test => !test.timeout && !test.preparationFailure
            && /test marked with \.failing\(\) did not throw|passed.*(?:marked|expected).*fail|expected.*fail.*(?:passed|pass)|test\.failing.*pass/i.test(test.detail ?? ''))
            ? 'pending and now passing' : 'not run';
    outcomes.push({ rowId: declaration.rowId, persona, file, test: title, status, expectedFailure, reading });
  }
  const record: ConfirmationRecord = { version: 1, runId: manifest.runId, atCommit: manifest.atCommit,
    startedAt: manifest.startedAt, recordedAt, outcomes,
    ...(manifest.stopped ? { stopped: manifest.stopped } : {}) };
  return record;
}

export function confirmationSummary(record?: ConfirmationRecord): string[] {
  const counts = confirmationCounts(record);
  return [...cellReadings.map(reading => `${reading}: ${counts[reading]}`),
    ...(record?.outcomes ?? []).flatMap(cell => {
      const reading = cellReading(cell);
      return reading === 'failed' || reading === 'not run'
        ? [`${cell.rowId} / ${cell.persona}: ${reading} (${cell.file})`] : [];
    })];
}

export function recordConfirmation(stateDir: string, directory: string, manifest: Manifest & { stopped?: ConfirmationStop },
  declarations: readonly RowOutcomes[], recordedAt = new Date().toISOString(), publish = true): ConfirmationRecord {
  const record = confirmationRecord(manifest, declarations, recordedAt);
  writeRecord(join(directory, 'confirmed.json'), record);
  if (!publish) return record;
  mkdirSync(stateDir, { recursive: true });
  // Regression and bounded confirmation may finish concurrently; compare and publish under one lease.
  const lock = join(stateDir, 'confirmed.lock');
  for (let attempt = 0; ; attempt++) {
    const acquired = tryAcquireDirectoryLease(lock);
    if (acquired !== 'held') {
      try {
        const latest = latestConfirmation(stateDir);
        // A slower older run finishing later must not replace the newer pinned run.
        if (!latest || latest.startedAt <= record.startedAt) writeRecord(join(stateDir, 'confirmed.json'), record);
      } finally { acquired.release(); }
      break;
    }
    if (attempt >= 200) throw new Error('Timed out publishing outcome confirmation');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return record;
}

export function confirmedScopeReport(declarations: readonly RowOutcomes[], rowIds: readonly string[],
  record?: ConfirmationRecord, now = Date.now()): string {
  const declared = new Map(declarations.map(row => [row.rowId, row]));
  const isProved = (id: string): boolean => personas.every(persona => {
    const cell = declared.get(id)?.cells[persona];
    return cell?.state === 'proved' || cell?.state === 'notApplicable';
  });
  const failed = new Set(record?.outcomes.filter(cell => cellReading(cell) === 'failed').map(cell => cell.rowId));
  const confirmed = (id: string): boolean => {
    const row = declared.get(id);
    if (!row || !record) return false;
    let applicable = 0;
    for (const persona of personas) {
      const cell = row.cells[persona];
      if (!cell) return false;
      if (cell.state === 'notApplicable') continue;
      applicable++;
      const evidence = record.outcomes.find(item => item.rowId === id && item.persona === persona
        && item.file === cell.file && item.test === outcomeTitle(row, persona));
      if (!evidence || cellReading(evidence) !== 'passed') return false;
    }
    return applicable > 0;
  };
  const lines = record
    ? [`Last confirmation ${record.runId}: ${record.atCommit}; age ${Math.max(0, (now - Date.parse(record.recordedAt)) / 3_600_000).toFixed(1)}h; recorded ${record.recordedAt}`,
      `Declared proved rows seen failing: ${rowIds.filter(id => isProved(id) && failed.has(id)).join(', ') || 'none'}`]
    : ['No confirmation run yet; showing declared figures.'];
  if (record) for (const cell of record.outcomes) {
    const reading = cellReading(cell);
    if (rowIds.includes(cell.rowId) && (reading === 'failed' || reading === 'pending and now passing'))
      lines.push(`  ${cell.rowId} / ${cell.persona}: ${reading} (${cell.file})`);
  }
  for (const vertical of new Set(rowIds.map(id => id.split('/')[0]!))) {
    const rows = rowIds.filter(id => id.startsWith(`${vertical}/`));
    const proved = rows.filter(isProved);
    const passes = rows.filter(confirmed);
    const failures = rows.filter(id => failed.has(id));
    lines.push(`${vertical}: declared proved ${proved.length}/${rows.length}; last run confirmed ${passes.length}; saw fail ${failures.length}`,
      `  declared proved: ${proved.join(', ') || 'none'}`);
    if (record) lines.push(`  confirmed: ${passes.join(', ') || 'none'}`, `  saw fail: ${failures.join(', ') || 'none'}`);
  }
  return lines.join('\n');
}
