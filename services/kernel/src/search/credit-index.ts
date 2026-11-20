import { projectCreditSearch, type CreditSearchIndexProjection } from './credit-search.ts';
import { SearchUnavailableError } from './operation-outcomes.ts';
import type { SubjectSnapshot, SubjectSource } from './source.ts';

/**
 * Index-only input for credit-successor generations. Ordinary readers never call this: creator projections
 * are attached only here, so every document writer receives the same complete-or-incomplete cut per Subject.
 * A producer-supplied `readForIndex` takes precedence. Otherwise use the native empty proof where available
 * and the ordinary credit projection for the remaining visible Subjects.
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
  const visible = snapshot.subjects.filter((subject) => subject.visibility === 'visible' && subject.redirect === null);
  const empty = await creditSource?.projectEmptyForIndex?.(
    partition,
    visible.map(({ id }) => id),
  );
  for (const { id } of visible) {
    const projection =
      empty?.get(id) ??
      (creditSource?.projectForIndex
        ? await creditSource.projectForIndex(id)
        : await projectCreditSearch(creditSource, id));
    // The credit observation can move in a different home without advancing this
    // Subject's external version. Retry the snapshot before writing that version.
    if (projection.state === 'restart') throw new SearchUnavailableError('Credit index observation changed');
    creditSearch.set(id, projection);
  }
  return { ...snapshot, creditSearch };
}
