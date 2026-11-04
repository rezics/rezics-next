import { createFileRoute, useLoaderData, useLocation, useParams, useRouter, useRouterState } from '@tanstack/react-router';
import { readContentEdition } from '../../content-editions/edition-read';
import { ContentEditionPage, type ContentEditionReturnOrigin } from '../../content-editions/edition-view';
import { useBuyerCurrentOrigin } from '../../checkout/buyer-current-origin';
import {
  purchaseReaderOriginFromState,
  purchaseReaderOriginHref,
  purchaseReaderOriginIsCurrent,
  type PurchaseReaderOrigin,
} from '../../checkout/purchase-return';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/editions/$id')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  pendingMs: 0,
  loader: ({ params }) => readContentEdition({ data: { editionId: params.id } }),
  head: ({ match }) =>
    pageHead({ title: m.content_edition_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: () => <ContentEditionPage editionId={Route.useParams().id} page={{ state: 'loading' }} />,
  component: EditionRoute,
});

export function EditionRoute() {
  const editionId = useParams({ from: '/editions/$id' }).id;
  const page = useLoaderData({ from: '/editions/$id' });
  const location = useLocation();
  const router = useRouter();
  const loading = useRouterState({ select: (state) => state.isLoading });
  const locale = getLocale();
  const origin = purchaseReaderOriginFromState(location.state, editionId, locale);
  // Retain current refusals during a reread, but conceal old bytes during fresh authorization.
  return (
    <EditionComposition
      editionId={editionId}
      page={loading && page.state === 'published' ? { state: 'loading' } : page}
      retrying={loading}
      origin={origin}
      onRetry={() => {
        void router.invalidate();
      }}
    />
  );
}

function EditionComposition({
  editionId,
  page,
  retrying,
  origin,
  onRetry,
}: {
  editionId: string;
  page: Parameters<typeof ContentEditionPage>[0]['page'];
  retrying: boolean;
  origin: PurchaseReaderOrigin | undefined;
  onRetry: () => void;
}) {
  if (!origin) return <ContentEditionPage editionId={editionId} page={page} retrying={retrying} onRetry={onRetry} />;
  return (
    <CurrentPurchaseOriginEdition
      editionId={editionId}
      locale={getLocale()}
      page={page}
      retrying={retrying}
      origin={origin}
      onRetry={onRetry}
    />
  );
}

function CurrentPurchaseOriginEdition({
  editionId,
  locale,
  page,
  retrying,
  origin,
  onRetry,
}: {
  editionId: string;
  locale: string;
  page: Parameters<typeof ContentEditionPage>[0]['page'];
  retrying: boolean;
  origin: PurchaseReaderOrigin;
  onRetry: () => void;
}) {
  const current = useBuyerCurrentOrigin(
    origin.kind === 'order' ? 'order.get' : 'entitlement.get',
    JSON.stringify([origin.kind, origin.recordId, origin.editionId, origin.locale, origin.history]),
  );
  const returnOrigin: ContentEditionReturnOrigin | undefined =
    purchaseReaderOriginIsCurrent(origin, editionId, locale, {
      current: current.origin.isCurrent(),
      subject: current.origin.observed.subject,
      readId: current.origin.observed.readId,
    })
      ? { kind: origin.kind, href: purchaseReaderOriginHref(origin) }
      : undefined;
  return (
    <ContentEditionPage
      editionId={editionId}
      page={page}
      retrying={retrying}
      onRetry={onRetry}
      returnOrigin={returnOrigin}
    />
  );
}
