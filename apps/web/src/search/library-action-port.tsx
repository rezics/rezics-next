import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { SearchLoaderDeps } from './search-params';
import { searchSavedQuerySelection, type SavedQuerySelection } from './saved-query-selection';

export type {
  SavedQueryHandoff,
  SavedQueryInput,
  SavedQueryIssue,
  SavedQuerySelection,
  SavedQuerySource,
} from './saved-query-selection';
export {
  admitSavedQuerySelection,
  createSavedQueryHandoffStore,
  hasSavedQueryInput,
  savedQueryCreateHref,
  savedQuerySeed,
  savedQuerySourceSeed,
  searchSavedQuerySelection,
  takeSavedQueryHandoff,
  writeSavedQueryHandoff,
} from './saved-query-selection';

/** Reader-bound follow origin. Lifetime identity is opaque; the host never inspects it. */
export type SearchFollowOrigin = {
  lifetime: object;
  isCurrent: () => boolean;
};

export type SearchFollowTargetProps = {
  targetId: string;
  origin?: SearchFollowOrigin;
  following?: boolean | null;
  idempotencyKey?: string;
  menuTitle?: string;
  onRemoved?: () => void;
  onRemovalUnsettledChange?: (targetId: string, unsettled: boolean) => void;
  disabled?: boolean;
};

export type SearchSaveQueryProps = {
  id: string;
  selection: SavedQuerySelection;
};

/**
 * Current Collection owner observation as Search consumes it for one-use save handoff.
 * Native session, exposure and operation catalogues stay inside the installed adapter.
 */
export type SearchCollectionOwnerCurrent = {
  subject: string | null;
  admitted: boolean;
  isCurrent: () => boolean;
  isOwnerCurrent: () => boolean;
  credential: () => string | null;
  csrfToken: string;
  generation: number;
  lifetime: string;
};

/**
 * Consumer-owned Library action capability. Search results and configured Concept pages
 * mount save and follow through this port. Adapters and registration live at the Library host.
 */
export type SearchLibraryActionPort = {
  SaveQuery: ComponentType<SearchSaveQueryProps>;
  FollowTarget: ComponentType<SearchFollowTargetProps>;
  useCollectionOwner(address: string, withLabels?: boolean): SearchCollectionOwnerCurrent;
};

/** Explicit host: executed-query selection plus the mounted Library operations. */
export type SearchLibraryActionHost = {
  readonly port: SearchLibraryActionPort;
  selectionFromExecuted(state: SearchLoaderDeps | undefined): SavedQuerySelection;
  SaveQuery: SearchLibraryActionPort['SaveQuery'];
  FollowTarget: SearchLibraryActionPort['FollowTarget'];
  useCollectionOwner: SearchLibraryActionPort['useCollectionOwner'];
};

export function createSearchLibraryActionHost(port: SearchLibraryActionPort): SearchLibraryActionHost {
  return {
    port,
    selectionFromExecuted: searchSavedQuerySelection,
    SaveQuery: port.SaveQuery,
    FollowTarget: port.FollowTarget,
    useCollectionOwner: port.useCollectionOwner,
  };
}

function IsolatedSaveQuery(_props: SearchSaveQueryProps) {
  return null;
}

function IsolatedFollowTarget(_props: SearchFollowTargetProps) {
  return null;
}

function useIsolatedCollectionOwner(_address: string, _withLabels = false): SearchCollectionOwnerCurrent {
  return {
    subject: null,
    admitted: false,
    isCurrent: () => false,
    isOwnerCurrent: () => false,
    credential: () => null,
    csrfToken: '',
    generation: 0,
    lifetime: '',
  };
}

/** Module-local adapter for stories and tests. Live pages bind the Library host. */
export const isolatedSearchLibraryActionPort: SearchLibraryActionPort = {
  SaveQuery: IsolatedSaveQuery,
  FollowTarget: IsolatedFollowTarget,
  useCollectionOwner: useIsolatedCollectionOwner,
};

export const isolatedSearchLibraryActionHost = createSearchLibraryActionHost(isolatedSearchLibraryActionPort);

const SearchLibraryActionContext = createContext<SearchLibraryActionHost>(isolatedSearchLibraryActionHost);

export function SearchLibraryActionProvider({
  host,
  children,
}: {
  host: SearchLibraryActionHost;
  children: ReactNode;
}) {
  return <SearchLibraryActionContext.Provider value={host}>{children}</SearchLibraryActionContext.Provider>;
}

export function useSearchLibraryActionHost(): SearchLibraryActionHost {
  return useContext(SearchLibraryActionContext);
}
