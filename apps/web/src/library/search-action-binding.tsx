import { useMemo, type ReactNode } from 'react';
import {
  SearchLibraryActionProvider,
  createSearchLibraryActionHost,
  type SearchFollowTargetProps,
  type SearchLibraryActionHost,
  type SearchLibraryActionPort,
} from '../search/library-action-port';
import { useCollectionOwnerCurrent } from './collection-owner-current';
import { FollowTargetControl } from './follow-target-control';
import { SaveQueryLink } from './save-query';

function LibraryFollowTarget(props: SearchFollowTargetProps) {
  return <FollowTargetControl {...props} />;
}

/**
 * Live Library adapter: native save handoff, current Collection owner observation, and
 * mounted follow admission/intent. Search owns the port; this file retains the commands.
 */
export function createLibrarySearchActionPort(): SearchLibraryActionPort {
  return {
    SaveQuery: SaveQueryLink,
    FollowTarget: LibraryFollowTarget,
    useCollectionOwner: useCollectionOwnerCurrent,
  };
}

export function createLibrarySearchActionHost(): SearchLibraryActionHost {
  return createSearchLibraryActionHost(createLibrarySearchActionPort());
}

const installedHost = createLibrarySearchActionHost();

/** Installed once by the Library application host for Search results and configured Concept pages. */
export function SearchLibraryActionBinding({ children }: { children: ReactNode }) {
  const host = useMemo(() => installedHost, []);
  return <SearchLibraryActionProvider host={host}>{children}</SearchLibraryActionProvider>;
}
