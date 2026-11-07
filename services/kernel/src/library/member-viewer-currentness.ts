import { ProblemError } from '../http/problem-error.ts';

type MemberPage = {
  members: readonly unknown[];
};

function sourcePage(page: MemberPage, listFactsAttached: boolean): unknown {
  const source = { ...page } as MemberPage & { viewerFacts?: unknown };
  delete source.viewerFacts;
  return {
    ...source,
    members: source.members.map((member) => {
      if (typeof member !== 'object' || member === null || Array.isArray(member)) return member;
      if (!listFactsAttached) return member;
      const { subject: _subject, facts: _facts, ...row } = member as Record<string, unknown>;
      return row;
    }),
  };
}

/** Refuse a private overlay when the exact admitted member page is no longer current. */
export function assertMemberPageCurrent(
  observed: MemberPage,
  current: unknown,
  options: { listFactsAttached?: boolean } = {},
): asserts current is MemberPage {
  if (typeof current !== 'object' || current === null || !('members' in current) || !Array.isArray(current.members))
    throw new ProblemError('semantic_not_ready');
  if (
    JSON.stringify(sourcePage(observed, options.listFactsAttached ?? false)) !==
    JSON.stringify(sourcePage(current as MemberPage, false))
  )
    throw new ProblemError('stale_cursor');
}
