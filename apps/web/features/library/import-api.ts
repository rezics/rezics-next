import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import type { ImportedBook } from './import-csv.ts';
import { ReaderImportBudgetError } from './import-match.ts';

export type ImportIssue = 'state-unavailable' | 'status-changed' | 'status-failed' | 'rating-needs-choice'
  | 'rating-changed' | 'rating-failed' | 'review-needs-rating' | 'review-changed' | 'review-failed' | 'shelf-failed';
export interface ImportRowResult { work: string; applied: string[]; issues: ImportIssue[] }
export interface ReviewedBatchRow { work: string; status: ImportedBook['status'];
  startedOn: string | null; finishedOn: string | null; rating: number | null; hasRating: boolean;
  review: string | null; reviewVisibility: 'private' | 'public'; shelves: string[];
  conflictChoice?: 'keep' | 'replace' }
export interface ImportBatchProgress { items: Array<{ index: number; result: ImportRowResult }>;
  total: number; pending: boolean }
export const REVIEWED_IMPORT_MAX_ROWS = 500;

async function stableKey(parts: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `library-import:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 40)}`;
}

/** Retry the same idempotent intent after Main's short-window admission.
 * Retry-After accepts seconds or an HTTP date; an absent value waits one second. */
async function waitForAdmission(response: { response: Response }): Promise<void> {
  const value = response.response.headers.get('retry-after');
  const seconds = value && /^\d+$/.test(value) ? Number(value) : undefined;
  const date = value && seconds === undefined ? Date.parse(value) : NaN;
  const delay = seconds !== undefined ? seconds * 1000
    : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/** One reviewed intent is sent to Main. Main resumes at most eight rows per
 * response and retains each row result; the browser only polls the same intent. */
export async function submitReviewedBatch(agent: string, context: string | null, language: string,
  existingShelves: readonly { name: string; id: string }[], rows: ReviewedBatchRow[],
  onProgress: (progress: ImportBatchProgress) => void = () => {},
  main: () => MainClient = browserMainApi): Promise<ImportBatchProgress> {
  const body = { actingSubject: agent, context, language,
    existingShelves: existingShelves.map(shelf => ({ name: shelf.name, id: shelf.id })), rows };
  const idempotencyKey = await stableKey(['reviewed-batch', body]);
  let last = -1, stalled = 0;
  const limit = Math.ceil(rows.length / 8) + 12;
  for (let attempt = 0; attempt < limit; attempt++) {
    const answer = await main().v1.me['library-import'].batches.post(body,
      { headers: { 'idempotency-key': idempotencyKey } });
    if (answer.status === 429) { await waitForAdmission(answer); continue; }
    if (!answer.data) throw new Error('Library import is unavailable');
    const progress = answer.data as ImportBatchProgress;
    onProgress(progress);
    if (!progress.pending) return progress;
    if (progress.items.length === last && ++stalled >= 5) break;
    if (progress.items.length !== last) stalled = 0;
    last = progress.items.length;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Library import is still in progress');
}

/** Main owns the source path and returns the same Work to all readers. */
export async function adoptOpenLibraryBook(agent: string, workId: string, locale: string,
  main: () => MainClient = browserMainApi): Promise<string> {
  const idempotencyKey = await stableKey([agent, 'open-library', workId]);
  for (let attempt = 0; attempt < 8; attempt++) {
    const written = await main().v1.me['library-import']['open-library'].adoptions.post({
      actingSubject: agent, workId, titleLanguage: locale }, { headers: { 'idempotency-key': idempotencyKey } });
    if (written.data && 'work' in written.data) return written.data.work;
    if (written.status === 429 && (written.error?.value as { code?: string } | undefined)?.code
      === 'reader_import_adoption_budget') throw new ReaderImportBudgetError('adoption');
    if (written.status === 429) { await waitForAdmission(written); continue; }
    if (written.status !== 202) throw new Error('Could not add Open Library Work');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Open Library Work is still being added');
}
