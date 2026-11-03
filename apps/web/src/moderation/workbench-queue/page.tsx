import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { csrfHeaders } from '../../threads/composer';
import { actionOnReport } from '../actions';
import { createPrivateReaderLifetime } from '../private-reader-lifetime';
import type { ReportQueueAction } from '../reports-view-action';
import { createWorkbenchSelection, WorkbenchSelectionBoundary } from '../workbench-selection';
import { workbenchReadKey, workbenchWithoutContinuation, type WorkbenchSearch } from './scope';
import type { WorkbenchRead } from './read';
import { WorkbenchView } from './view';

const nativeReportAction: ReportQueueAction = (data) => actionOnReport({ data, headers: csrfHeaders() });

export function WorkbenchPage({
  page,
  search,
  onSearch,
  onRetry,
  onRefresh,
  onAction,
  navigation,
}: {
  page: WorkbenchRead;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
  onAction?: ReportQueueAction;
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
    ? {
        ...page,
        search,
        state: 'denied' as const,
        cases: [],
        reports: [],
        appeals: [],
        selectedTarget: null,
        realms: [],
        boards: [],
        next: null,
        realmsNext: null,
        boardsNext: null,
      }
    : { ...page, search };
  const isCurrent = () => !retired && (!owner || owner.isCurrent());
  const currentRef = useRef(isCurrent);
  currentRef.current = isCurrent;
  const identity = `${view.generation}:${view.readKey}:${search.queue}:${view.state}`;
  const generation = useRef<{ identity: string; controller: ReturnType<typeof createWorkbenchSelection> } | null>(null);
  if (!generation.current || generation.current.identity !== identity) {
    generation.current?.controller.retire();
    generation.current = {
      identity,
      controller: createWorkbenchSelection(view.reports ?? [], search, () => currentRef.current()),
    };
  }
  const controller = generation.current.controller;
  useLayoutEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);
  useEffect(
    () => () => {
      controller.retire();
    },
    [controller],
  );
  const submit: ReportQueueAction = async (command) => {
    if (!isCurrent()) return;
    if (owner && !owner.canCommand()) return { ok: false, state: 'forbidden' };
    return (onAction ?? nativeReportAction)(command);
  };
  return (
    <WorkbenchSelectionBoundary>
      <WorkbenchView
        page={view}
        onSearch={onSearch}
        selection={controller}
        onAction={submit}
        isCurrent={isCurrent}
        onRestart={() => onSearch(workbenchWithoutContinuation(search))}
        {...(onRetry ? { onRetry } : {})}
        {...(onRefresh ? { onRefresh } : {})}
      />
    </WorkbenchSelectionBoundary>
  );
}
