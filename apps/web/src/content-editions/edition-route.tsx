import { useLoaderData, useLocation, useParams, useRouter, useRouterState } from '@tanstack/react-router';
import { ContentEditionPage, type ContentEditionReturnOrigin } from './edition-view';
import {
  useBuyerCurrentOrigin,
  purchaseReaderOriginFromState,
  purchaseReaderOriginHref,
  purchaseReaderOriginIsCurrent,
  type PurchaseReaderOrigin,
} from '../checkout/reader-origin';
import { getLocale } from '../paraglide/runtime.js';

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
  const returnOrigin: ContentEditionReturnOrigin | undefined = purchaseReaderOriginIsCurrent(
    origin,
    editionId,
    locale,
    {
      current: current.origin.isCurrent(),
      subject: current.origin.observed.subject,
      readId: current.origin.observed.readId,
    },
  )
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
