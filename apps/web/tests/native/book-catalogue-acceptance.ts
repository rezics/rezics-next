import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class BookColdSearchTimeoutError extends Error {}

export type BookScopeVerdict = { outcome: 'unreached' | 'running' | 'passed' } | { outcome: 'failed'; failure: string };

export type BookCatalogueVerdicts = {
  coldSearch: BookScopeVerdict;
  ui: BookScopeVerdict;
  setupFailure?: string;
};

export function bookFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function writeBookCatalogueVerdicts(path: string, verdicts: BookCatalogueVerdicts): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.pending`;
  await writeFile(pending, JSON.stringify(verdicts, null, 2) + '\n', { mode: 0o600 });
  await rename(pending, path);
  const scope = (verdict: BookScopeVerdict) =>
    verdict.outcome === 'failed' ? { ...verdict, failure: verdict.failure.slice(0, 24_000) } : verdict;
  console.info(
    'book-catalogue-journey-verdict',
    JSON.stringify({
      coldSearch: scope(verdicts.coldSearch),
      ui: scope(verdicts.ui),
      ...(verdicts.setupFailure === undefined ? {} : { setupFailure: verdicts.setupFailure.slice(0, 24_000) }),
    }),
  );
}

export async function completeBookCatalogueAcceptance(
  coldFailure: unknown | undefined,
  browser: () => Promise<void>,
  recordUi: (verdict: BookScopeVerdict) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = coldFailure === undefined ? [] : [coldFailure];
  let verdict: BookScopeVerdict = { outcome: 'passed' };
  try {
    await browser();
  } catch (error) {
    failures.push(error);
    verdict = { outcome: 'failed', failure: bookFailure(error) };
  }
  try {
    await recordUi(verdict);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Required Book catalogue acceptance failed');
}
