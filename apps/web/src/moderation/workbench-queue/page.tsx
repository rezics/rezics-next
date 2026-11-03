import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { createPrivateReaderLifetime } from '../private-reader-lifetime';
import { workbenchReadKey, type WorkbenchSearch } from './scope';
import type { WorkbenchRead } from './read';
import { WorkbenchView } from './view';

export function WorkbenchPage({
  page,
  search,
  onSearch,
  onRetry,
  navigation,
}: {
  page: WorkbenchRead;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: () => void;
  navigation?: { isCurrent: () => boolean; subscribe: (retire: () => void) => () => void };
}) {
  const client = useContext(QueryClientContext);
  const owner = useMemo(() => {
    if (typeof window === 'undefined' || !client) return undefined;
    return createPrivateReaderLifetime(client, page, workbenchReadKey(search), navigation);
  }, [client, page, search, navigation]);
  const version = useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.snapshot ?? (() => 0), () => 0);
  useEffect(() => () => owner?.retire(), [owner]);
  const retired = Boolean(owner && !owner.healthy()) && version >= 0;
  const view = retired
    ? { ...page, search, state: 'denied' as const, cases: [], realms: [], boards: [], next: null, realmsNext: null, boardsNext: null }
    : { ...page, search };
  return <WorkbenchView page={view} onSearch={onSearch} {...(onRetry ? { onRetry } : {})} />;
}
