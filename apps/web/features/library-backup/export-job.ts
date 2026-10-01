import { ExportError, type ExportApi, type ExportRow } from './export-api.ts';
import type { ExportProgress, ExportStore } from './export-store.ts';

export const EXPORT_PROFILE = 'rezics-library-export-v1';
/** What one REZICS import accepts (`FILE_IMPORT_COST`): a file over either is saved as several. */
export const IMPORT_FILE_BYTES = 2 * 1024 * 1024;
export const IMPORT_FILE_ROWS = 5_000;
const MARGIN_BYTES = 64 * 1024;

/**
 * Fetches the remaining pages, one at a time, keeping each as it arrives. With a stored position the job
 * resumes there with the same snapshot token; Main answers a changed library or an expired cursor with a
 * conflict, which ends the download so the reader starts a new one.
 */
export async function collectExport(input: { api: ExportApi; store: ExportStore; agent: string;
  onProgress: (progress: ExportProgress) => void; active?: () => boolean }): Promise<ExportProgress> {
  const { api, store, agent, onProgress, active = () => true } = input;
  let progress = await store.progress(agent);
  if (progress) onProgress(progress);
  while (!progress?.done && active()) {
    const page = await api.page(progress ? { cursor: progress.cursor ?? undefined, snapshot: progress.snapshot } : {});
    if (page.profile !== EXPORT_PROFILE) throw new ExportError('unavailable', 'Main sent another export profile');
    if (progress && page.snapshot !== progress.snapshot) throw new ExportError('moved', 'The snapshot changed mid-download');
    progress = { snapshot: page.snapshot, cursor: page.nextCursor, pages: (progress?.pages ?? 0) + 1,
      rows: (progress?.rows ?? 0) + page.rows.length, done: page.nextCursor === null };
    await store.append(agent, progress, page.rows);
    onProgress(progress);
  }
  return progress ?? { snapshot: '', cursor: null, pages: 0, rows: 0, done: false };
}

/** The collected rows, checked against what was counted as each page arrived. */
export async function collectedRows(store: ExportStore, agent: string, progress: ExportProgress): Promise<ExportRow[]> {
  const rows = (await store.pages(agent)).flat();
  if (!progress.done || rows.length !== progress.rows) throw new ExportError('unavailable', 'The collected pages do not match the download');
  return rows;
}

export interface ExportFile { name: string; text: string; rows: number }

/** One `{ profile, rows }` bundle, as the REZICS import reads it; several, in order, when one import could not hold it. */
export function assembleFiles(rows: readonly ExportRow[], day: string): ExportFile[] {
  const encoder = new TextEncoder();
  const groups: ExportRow[][] = [[]];
  let bytes = 0;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length + 1;
    const group = groups.at(-1)!;
    if (group.length && (bytes + size > IMPORT_FILE_BYTES - MARGIN_BYTES || group.length >= IMPORT_FILE_ROWS)) {
      groups.push([]); bytes = 0;
    }
    groups.at(-1)!.push(row); bytes += size;
  }
  return groups.map((group, index) => ({ rows: group.length,
    name: groups.length === 1 ? `rezics-library-${day}.json` : `rezics-library-${day}-part-${index + 1}-of-${groups.length}.json`,
    text: JSON.stringify({ profile: EXPORT_PROFILE, rows: group }) }));
}
