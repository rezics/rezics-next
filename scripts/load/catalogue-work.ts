import { createHash } from 'node:crypto';
import type { CorpusApi } from './work-profile-corpus.ts';
import type { CatalogueImportInput, CatalogueImportOutcome } from '../../services/main/src/modules/work/catalogue-import.ts';

/** Public catalogue import only. Item keys stay stable across regrouping, retries
 * and restarts; an HTTP 200 with pending/failed items is never a completed corpus. */
export async function seedCatalogueProfileWorks(api: CorpusApi, actingSubject: string,
  items: readonly { key: string; input: CatalogueImportInput }[], signal?: AbortSignal) {
  const result = await api.command<{ items: CatalogueImportOutcome[]; complete: boolean; partial: boolean }>(
    `catalogue-batch:${createHash('sha256').update(JSON.stringify(items.map(item => item.key))).digest('hex')}`, { method: 'POST', path: '/v1/work-imports/bulk', body: { actingSubject, items } }, signal);
  if (!result.complete || result.partial || result.items.length !== items.length
    || result.items.some((row, index) => row.key !== items[index]?.key || row.status !== 'succeeded'
      || row.receipt?.outcome !== 'succeeded' || !row.receipt.work || !row.receipt.mainVersion))
    throw new Error(`Catalogue preparation incomplete: ${JSON.stringify(result.items.map(row => ({ key: row.key, status: row.status })))}`);
  return result.items.map(row => ({ work: row.receipt!.work!, mainVersion: row.receipt!.mainVersion!,
    workRevision: row.receipt!.workRevision!, mainRevision: row.receipt!.mainRevision!, receipt: row.receipt!.receipt }));
}
