import { useContext, useMemo } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { getLocale } from '../../paraglide/runtime.js';
import { workbenchHistoryWindows } from '../workbench-history/window-history';
import { WorkbenchPage } from './page';
import type { WorkbenchRead } from './read';
import { workbenchSearch, type WorkbenchSearch } from './scope';
import { workbenchQueueWindowHistory } from './window-history';

export function WorkbenchRoutePage({
  page,
  search,
}: {
  page: WorkbenchRead & { navigationKey: string };
  search: WorkbenchSearch;
}) {
  const navigate = useNavigate({ from: '/moderation/workbench' });
  const router = useRouter();
  const client = useContext(QueryClientContext);
  const windowHistory = client ? workbenchQueueWindowHistory(client) : undefined;
  const visitId = useMemo(() => crypto.randomUUID(), [page.navigationKey]);
  const navigation = useMemo(
    () => ({
      visitId,
      isCurrent: () =>
        getLocale() === page.locale &&
        (router.state.location.state.__TSR_key ?? router.state.location.href) === page.navigationKey,
      subscribe: (retire: () => void) => {
        const leave = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if ((toLocation.state.__TSR_key ?? toLocation.href) !== page.navigationKey) {
            if (client)
              workbenchHistoryWindows(client).navigate(
                visitId,
                { pathname: toLocation.pathname, search: toLocation.search as Record<string, unknown> },
                search,
                page,
              );
            windowHistory?.navigate(
              visitId,
              { pathname: toLocation.pathname, search: toLocation.search as Record<string, unknown> },
              search,
              page,
            );
            retire();
          }
        });
        const reload = router.subscribe('onBeforeLoad', retire);
        return () => {
          leave();
          reload();
        };
      },
    }),
    [client, router, page.navigationKey, page.generation, page.locale, page, search, visitId, windowHistory],
  );
  const onSearch = (next: WorkbenchSearch) => void navigate({ search: workbenchSearch(next) });
  return (
    <WorkbenchPage
      key={`${page.generation}:${page.navigationKey}`}
      page={page}
      search={search}
      navigation={navigation}
      onSearch={onSearch}
      onOpenCase={(_item, href) => void router.navigate({ to: href as never })}
      onRetry={() => void router.invalidate({ sync: true })}
      onRefresh={() => router.invalidate({ sync: true })}
    />
  );
}
