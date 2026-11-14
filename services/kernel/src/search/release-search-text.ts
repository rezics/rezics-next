import type { IndexedSubject, RelationFacetMatch } from './source.ts';
import type { TextNode } from './text.ts';

export type ReleaseSearchTextMatcher = Readonly<{
  matchesText(subject: IndexedSubject, query: TextNode): Promise<RelationFacetMatch>;
}>;

/** A text check for one request, already bound to its admitted query and physical analyzer. */
export type ReleaseSearchCurrentText = (subject: IndexedSubject) => Promise<boolean>;

/** Preserve Search's readiness outcome when current native text cannot decide the query. */
export function bindReleaseSearchText(
  matcher: ReleaseSearchTextMatcher | undefined,
  query: TextNode | undefined,
  notProven: () => never,
): ReleaseSearchCurrentText | undefined {
  if (!matcher || !query) return undefined;
  return async (subject) => {
    const result = await matcher.matchesText(subject, query);
    if (result === 'not_proven') return notProven();
    return result;
  };
}

export type ReleaseSearchGroupCandidate = Readonly<{ kind: 'work' | 'release'; id: string }>;
export type ReleaseSearchGroupPage = Readonly<{
  keys: ReleaseSearchGroupCandidate[];
  after: string;
  exhausted: boolean;
}>;

/** Name order is established by native current-name traversal, then checked against current work text. */
export async function filterReleaseSearchNameGroups(
  page: ReleaseSearchGroupPage,
  readCurrent: (ids: readonly string[]) => Promise<ReadonlyMap<string, IndexedSubject>>,
  workTypes: ReadonlySet<string>,
  matchesText: ReleaseSearchCurrentText,
): Promise<ReleaseSearchGroupPage> {
  const workIds = [...new Set(page.keys.flatMap((candidate) => (candidate.kind === 'work' ? [candidate.id] : [])))];
  if (!workIds.length) return page;

  const current = await readCurrent(workIds);
  const matching = new Set<string>();
  for (const id of workIds) {
    const subject = current.get(id);
    if (
      subject &&
      subject.visibility === 'visible' &&
      subject.redirect === null &&
      workTypes.has(subject.type) &&
      (await matchesText(subject))
    )
      matching.add(id);
  }
  return {
    ...page,
    keys: page.keys.filter((candidate) => candidate.kind !== 'work' || matching.has(candidate.id)),
  };
}
