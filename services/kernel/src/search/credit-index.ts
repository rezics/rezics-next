import { projectCreditSearch, type CreditSearchProjection } from './credit-search.ts';
import type { SubjectSnapshot, SubjectSource } from './source.ts';

/**
 * Index-only input for credit-successor generations. Ordinary readers never call this: creator projections
 * are attached only here, so every document writer receives the same complete-or-incomplete cut per Subject.
 * A producer-supplied `readForIndex` takes precedence; otherwise each visible Subject gets exactly one
 * `projectCreditSearch` result through the `creditSearch` port. A missing port yields `unavailable` cuts.
 */
export async function readCreditIndexSnapshot(
  source: SubjectSource,
  partition: number,
  ids: readonly string[],
): Promise<SubjectSnapshot> {
  if (source.readForIndex) return source.readForIndex(partition, ids);
  const snapshot = await source.read(partition, ids);
  const creditSearch = new Map<string, CreditSearchProjection>();
  for (const subject of snapshot.subjects) {
    if (subject.visibility !== 'visible' || subject.redirect !== null) continue;
    creditSearch.set(subject.id, await projectCreditSearch(source.creditSearch, subject.id));
  }
  return { ...snapshot, creditSearch };
}
