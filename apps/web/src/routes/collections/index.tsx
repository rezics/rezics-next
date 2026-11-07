import {
  readPublicCollectionDiscovery,
  renderPublicCollection,
  type PublicCollectionDiscoveryState,
} from '../../search/public-collection-directory';
import {
  parsePublicCollectionDirectoryAddress,
  publicCollectionDirectoryHref,
  type PublicCollectionDirectoryAddress,
} from '../../search/contracts/collection-directory';
import { type MouseEvent, useLayoutEffect, useRef } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { PublicCollectionDiscoveryPage } from '../../library/public-collection-discovery/page';
import { publicCollectionDiscoveryQueryOptions } from '../../library/public-collection-discovery/query';
import {
  collectionWindowHref,
  publicCollectionWindowVisit,
  type Coordinate,
  type Movement,
} from '../../library/public-collection-discovery/window-navigation';

type CollectionRouteSearch = PublicCollectionDirectoryAddress & {
  invalidCursor?: true;
  invalidSelection?: true;
};

function validateCollectionSearch(search: Record<string, unknown>): CollectionRouteSearch {
  const parsed = parsePublicCollectionDirectoryAddress(search);
  if (parsed.state === 'invalid')
    return parsed.field === 'cursor' ? { invalidCursor: true } : { invalidSelection: true };
  return parsed.address;
}

export const Route = createFileRoute('/collections/')({
  staticData: { publicCache: true },
  validateSearch: validateCollectionSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, context }) => {
    if (deps.invalidCursor || deps.invalidSelection) return undefined;
    const locale = getLocale();
    return context.queryClient.ensureQueryData(
      publicCollectionDiscoveryQueryOptions(locale, deps, readPublicCollectionDiscovery),
    );
  },
  head: ({ match }) =>
    pageHead(
      {
        title: m.collection_discovery_heading(),
        description: m.collection_discovery_intro(),
      },
      pageHeadContext(match.pathname),
    ),
  component: () => {
    const address = Route.useSearch();
    const locale = getLocale();
    const router = useRouter();
    const queryClient = useQueryClient();
    const visit = publicCollectionWindowVisit(queryClient, router);
    const heading = useRef<HTMLHeadingElement>(null);
    const retrying = useRef(false);
    const invalidCursor = address.invalidCursor === true;
    const invalidSelection = address.invalidSelection === true;
    const selection = {
      ...(address.presentationKind === undefined ? {} : { presentationKind: address.presentationKind }),
      ...(address.curator === undefined ? {} : { curator: address.curator }),
      ...(address.subject === undefined ? {} : { subject: address.subject }),
      ...(address.order === undefined ? {} : { order: address.order }),
    };
    const query = useQuery({
      ...publicCollectionDiscoveryQueryOptions(
        locale,
        {
          ...selection,
          ...(address.cursor === undefined ? {} : { cursor: address.cursor }),
        },
        readPublicCollectionDiscovery,
      ),
      enabled: !invalidCursor && !invalidSelection,
    });
    const source = query.data;
    const binding =
      source?.status === 'ready' ? JSON.stringify([locale, source.asOf]) : (visit.binding ?? JSON.stringify([locale]));
    const transfer = source ? visit.accept(source, binding, address.cursor ?? null, source.status === 'ready') : false;
    useLayoutEffect(() => {
      visit.mounts++;
      return () => {
        visit.mounts--;
        queueMicrotask(() => {
          if (!visit.mounts && !visit.pending?.loading) visit.retire();
        });
      };
    }, [visit]);
    useLayoutEffect(() => {
      if (transfer && visit.active) heading.current?.focus({ preventScroll: true });
    }, [source, transfer, visit]);
    const state: PublicCollectionDiscoveryState = invalidCursor
      ? { status: 'restart' }
      : invalidSelection
        ? { status: 'invalid-selection' }
        : (query.data ?? { status: 'loading' });
    const { pathname, search, hash } = router.history.location;
    const href = (coordinate: Coordinate) => collectionWindowHref(pathname, search, hash, coordinate);
    const revision = visit.revision;
    const current = () =>
      visit.active &&
      visit.revision === revision &&
      (!source || visit.source?.deref() === source) &&
      !visit.pending?.loading;
    const move = (event: MouseEvent<HTMLAnchorElement>, movement: Movement, coordinate: Coordinate) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!current() || query.isFetching) return;
      const target = href(coordinate);
      if (!visit.start(coordinate, movement, target, event.currentTarget)) return;
      router.history.push(target);
    };
    const onRetry = () => {
      if (!current() || retrying.current || query.isFetching) return;
      retrying.current = true;
      if (visit.pending && !visit.retry()) {
        retrying.current = false;
        return;
      }
      void query.refetch().finally(() => {
        retrying.current = false;
      });
    };
    return (
      <PublicCollectionDiscoveryPage
        renderCollection={renderPublicCollection}
        state={state}
        locale={locale}
        selection={selection}
        onSelect={(next) => router.history.push(publicCollectionDirectoryHref(locale, next))}
        headingRef={heading}
        {...(address.cursor ? { cursor: address.cursor } : {})}
        continuation={invalidCursor || address.cursor !== undefined}
        retrying={query.isFetching}
        onRetry={onRetry}
        navigation={{
          ...(visit.previous === undefined ? {} : { previous: visit.previous }),
          hasPrevious: visit.previous !== undefined,
          pending: !!visit.pending?.loading || query.isFetching,
          href,
          move,
        }}
      />
    );
  },
});
