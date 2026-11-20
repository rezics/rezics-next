import { projectCreditSearch, type CreditSearchIndexProjection } from './credit-search.ts';
import { SearchUnavailableError } from './operation-outcomes.ts';
import type { SubjectSnapshot, SubjectSource } from './source.ts';

/**
 * Index-only input for credit-successor generations. Ordinary readers never call this: creator projections
 * are attached only here, so every document writer receives the same complete-or-incomplete cut per Subject.
 * A producer-supplied `readForIndex` takes precedence; otherwise each visible Subject gets exactly one
 * attempt through the credit port. A missing port yields `unavailable` cuts.
 */
export async function readCreditIndexSnapshot(
  source: SubjectSource,
  partition: number,
  ids: readonly string[],
): Promise<SubjectSnapshot> {
  if (source.readForIndex) return source.readForIndex(partition, ids);
  const snapshot = await source.read(partition, ids);
  const creditSearch = new Map<string, CreditSearchIndexProjection>();
  const creditSource = source.creditSearch;
  for (const subject of snapshot.subjects) {
    if (subject.visibility !== 'visible' || subject.redirect !== null) continue;
    const projection = creditSource?.projectForIndex
      ? await creditSource.projectForIndex(subject.id)
      : await projectCreditSearch(creditSource, subject.id);
    // The credit observation can move in a different home without advancing this
    // Subject's external version. Retry the snapshot before writing that version.
    if (projection.state === 'restart') throw new SearchUnavailableError('Credit index observation changed');
    creditSearch.set(subject.id, projection);
  }
  return { ...snapshot, creditSearch };
}
