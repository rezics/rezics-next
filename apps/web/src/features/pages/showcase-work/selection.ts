import type { PageContinuation } from '@rezics/composition';
import type { SubjectPageData } from '../subject';
import { profileRelationWindows, type ProfileRelationWindow } from '../views';

/** The exact region being received, including its current opaque native cursor. */
export type WorkFranchiseSelection = Pick<ProfileRelationWindow, 'node' | 'property' | 'direction' | 'cursor'>;

/**
 * Select from the acknowledged pages.read envelope, never from a separate relation request.
 * Failed and withheld windows remain selected; an absent or different region has no replacement.
 */
export function selectWorkFranchiseRegion(page: SubjectPageData, selection: WorkFranchiseSelection) {
  const window = profileRelationWindows(page, { includeAliases: true }).find(
    (window) =>
      window.node === selection.node &&
      window.property === selection.property &&
      window.direction === selection.direction &&
      window.cursor === selection.cursor,
  );
  // A continued response cannot be borrowed by an alias or another independently planned node.
  if (!window || (page.continuation && page.continuation.node !== selection.node)) return;
  return {
    page,
    window,
    continuation:
      window.status === 200 && window.valid && window.next !== undefined
        ? ({ node: window.node, cursor: window.next } satisfies PageContinuation)
        : undefined,
  };
}
