import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJUnit } from '../qa/acceptance.ts';
import { outcomeTitle, personas, type Persona, type RowOutcomes } from '../qa/cases/outcome-cells.ts';
import type { Manifest } from './regress.ts';

export interface ConfirmedOutcome {
  rowId: string;
  persona: Persona;
  file: string;
  test: string;
  status: 'passed' | 'failed' | 'skipped' | 'missing';
  expectedFailure: boolean;
}

export interface ConfirmationRecord {
  version: 1;
  runId: string;
  atCommit: string;
  startedAt: string;
  recordedAt: string;
  outcomes: ConfirmedOutcome[];
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
export function recordConfirmation(stateDir: string, directory: string, manifest: Manifest,
  declarations: readonly RowOutcomes[], recordedAt = new Date().toISOString()): ConfirmationRecord {
  const outcomes: ConfirmedOutcome[] = [];
  for (const declaration of declarations) for (const persona of personas) {
    const cell = declaration.cells[persona];
    if (!cell || cell.state === 'notApplicable') continue;
    const file = cell.file!;
    const title = outcomeTitle(declaration, persona);
    const batch = manifest.batches.find(batch => batch.files.includes(file));
    const attempt = batch?.attempts.at(-1);
    const results = [];
    if (batch && attempt && attempt.classification !== 'infrastructure') {
      for (const path of new Set(attempt.artifactPaths)) {
        const xml = join(path, `${batch.tier.replaceAll('/', '-')}.xml`);
        if (existsSync(xml)) results.push(...parseJUnit(readFileSync(xml, 'utf8'), 'integration', { root: manifest.checkout })
          .filter(test => test.file === file && (test.name === title || test.name.endsWith(` > ${title}`))));
      }
    }
    const status = results.some(test => test.failed) ? 'failed'
      : results.some(test => test.skipped) ? 'skipped' : results.length ? 'passed' : 'missing';
    outcomes.push({ rowId: declaration.rowId, persona, file, test: title, status, expectedFailure: cell.state === 'pending' });
  }
  const record: ConfirmationRecord = { version: 1, runId: manifest.runId, atCommit: manifest.atCommit,
    startedAt: manifest.startedAt, recordedAt, outcomes };
  writeRecord(join(directory, 'confirmed.json'), record);
  const latest = latestConfirmation(stateDir);
  // A slower older run finishing later must not replace the newer pinned run.
  if (!latest || latest.startedAt <= record.startedAt) writeRecord(join(stateDir, 'confirmed.json'), record);
  return record;
}

export function confirmedScopeReport(declarations: readonly RowOutcomes[], rowIds: readonly string[],
  record?: ConfirmationRecord, now = Date.now()): string {
  const declared = new Map(declarations.map(row => [row.rowId, row]));
  const isProved = (id: string): boolean => personas.every(persona => {
    const cell = declared.get(id)?.cells[persona];
    return cell?.state === 'proved' || cell?.state === 'notApplicable';
  });
  const failed = new Set(record?.outcomes.filter(cell => cell.status === 'failed').map(cell => cell.rowId));
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
      if (!evidence || evidence.status !== 'passed' || evidence.expectedFailure) return false;
    }
    return applicable > 0;
  };
  const lines = record
    ? [`Last regression ${record.runId}: ${record.atCommit}; age ${Math.max(0, (now - Date.parse(record.recordedAt)) / 3_600_000).toFixed(1)}h; recorded ${record.recordedAt}`,
      `Declared proved rows seen failing: ${rowIds.filter(id => isProved(id) && failed.has(id)).join(', ') || 'none'}`]
    : ['No regression confirmation run yet; showing declared figures.'];
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
