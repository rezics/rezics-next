import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import type { SubjectPurchaseContext } from '../features/pages/subject-slots';
import { m } from '../paraglide/messages.js';
import { localizeHref, locales } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { capturedBenefit } from './benefit';
import { formatMinorAmount } from './money';
import { readSubjectOffers, type SubjectOffersData, type SubjectOffersInput } from './subject-offers';

export function purchaseHref(path: string, locale: string): string | null {
  const language = locales.find((candidate) => candidate === locale);
  return language ? localizeHref(path, { locale: language }) : null;
}
export type SubjectOffersViewer = {
  subject: string | null;
  sessionKey: string | null;
  readScope?: string;
  readEpoch?: number;
  current?: () => boolean;
};

/** Cache events retire a read even when React batches an account change away and back. */
function useSubjectOffersReadBoundary() {
  const client = useQueryClient();
  const scope = useId();
  const boundary = useMemo(() => {
    let epoch = 0;
    return {
      snapshot: () => epoch,
      subscribe: (changed: () => void) =>
        client.getQueryCache().subscribe((event) => {
          const key = event.query.queryKey;
          if (
            (event.type !== 'updated' && event.type !== 'removed') ||
            !((key.length === 1 && key[0] === 'session') || (key[0] === 'exposure' && key[1] === 'viewer'))
          )
            return;
          epoch += 1;
          // Cancel before notifying React: late reads cannot enter this mount's cache again.
          const queryKey = ['subject-offers', scope];
          void client.cancelQueries({ queryKey });
          client.removeQueries({ queryKey });
          changed();
        }),
    };
  }, [client, scope]);
  const epoch = useSyncExternalStore(boundary.subscribe, boundary.snapshot, () => 0);
  const current = useCallback(() => boundary.snapshot() === epoch, [boundary, epoch]);
  return { scope, epoch, current };
}
/** Browser-only and bound to the prepared actor/session, including cancellation of late personal responses. */
export function subjectOffersQuery(
  input: SubjectOffersInput,
  viewer: SubjectOffersViewer,
  read: (input: { data: SubjectOffersInput }) => Promise<SubjectOffersData> = readSubjectOffers,
) {
  return queryOptions({
    queryKey: [
      'subject-offers',
      viewer.readScope ?? null,
      viewer.readEpoch ?? 0,
      input.subjectId,
      input.locale,
      input.credentialMode,
      viewer.subject,
      viewer.sessionKey,
      input.cursor ?? '',
    ],
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      if (viewer.current && !viewer.current()) throw new Error('Subject offers read retired');
      const page = await read({ data: input });
      signal.throwIfAborted();
      if (viewer.current && !viewer.current()) throw new Error('Subject offers read retired');
      return page;
    },
    enabled: typeof window !== 'undefined',
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function SubjectOffersView({
  page,
  locale,
  onNext,
  onRestart,
  onRetry,
}: {
  page: SubjectOffersData | { kind: 'pending' };
  locale: string;
  onNext?: (cursor: string) => void;
  onRestart?: () => void;
  onRetry?: () => void;
}) {
  const language = locales.find((candidate) => candidate === locale);
  if (!language) return null;
  const preparing = page.kind === 'preparing' || (page.kind === 'ready' && page.projectionState === 'preparing');
  return (
    <section
      className="mt-6 flex min-w-0 flex-col gap-3"
      aria-label={m.subject_purchase_heading({}, { locale: language })}
    >
      <h2 className="text-lg font-semibold">{m.subject_purchase_heading({}, { locale: language })}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        {m.subject_purchase_discovery({}, { locale: language })}
      </p>
      {page.kind === 'pending' || preparing ? (
        <p role="status" className="text-sm text-muted-foreground">
          {page.kind === 'pending'
            ? m.subject_purchase_pending({}, { locale: language })
            : m.subject_purchase_preparing({}, { locale: language })}
        </p>
      ) : null}
      {page.kind === 'denied' || page.kind === 'unavailable' || page.kind === 'cursor-error' ? (
        <Alert role="alert">
          <AlertDescription>
            {page.kind === 'denied'
              ? m.subject_purchase_denied({}, { locale: language })
              : page.kind === 'cursor-error'
                ? m.subject_purchase_cursor_error({}, { locale: language })
                : m.subject_purchase_unavailable({}, { locale: language })}
          </AlertDescription>
        </Alert>
      ) : null}
      {page.kind === 'ready' && page.offers.length === 0 && !preparing ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.subject_purchase_empty({}, { locale: language })}</EmptyTitle>
            <EmptyDescription>{m.subject_purchase_discovery({}, { locale: language })}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {page.kind === 'ready' && page.offers.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-3">
          {page.offers.map((offer) => {
            const benefit = capturedBenefit(offer.contentEdition, offer.targetSubjectId);
            const price = formatMinorAmount(locale, offer.currency, offer.unitAmountMinor, offer.moneyUnit);
            const href = purchaseHref(`/offers/${encodeURIComponent(offer.id)}`, locale);
            return (
              <ContentItem
                key={offer.id}
                title={offer.title}
                headingLevel={3}
                {...(href ? { href } : {})}
                primaryLinkLabel={m.subject_purchase_review_offer({ title: offer.title }, { locale: language })}
                className="p-3 [&_h3]:break-words [&_h3]:[overflow-wrap:anywhere]"
                metadata={
                  <div className="min-w-0 space-y-2">
                    <p className="text-sm tabular-nums">
                      {price ?? m.subject_purchase_price_unknown({}, { locale: language })}
                      {price && offer.taxBehavior === 'exclusive'
                        ? ` · ${m.commerce_before_tax({}, { locale: language })}`
                        : ''}
                    </p>
                    {benefit.kind === 'mapped' ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {m.benefit_fixed_version({}, { locale: language })}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {m.benefit_acquisition({}, { locale: language })}
                        </p>
                        <p className="break-words text-sm [overflow-wrap:anywhere]">
                          {m.benefit_licence({}, { locale: language })}: {benefit.terms.source.licence}
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {m.benefit_terms_unavailable({}, { locale: language })}
                      </p>
                    )}
                  </div>
                }
                preview={
                  <span className="text-sm underline underline-offset-4">
                    {m.subject_purchase_review({}, { locale: language })}
                  </span>
                }
                state={<p className="text-sm font-medium">{m.creator_offers_active({}, { locale: language })}</p>}
                actions={
                  <details className="min-w-0 max-w-sm">
                    <summary className="min-h-11 cursor-pointer content-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {m.commerce_full_title({}, { locale: language })}
                    </summary>
                    <p className="break-words py-2 text-sm [overflow-wrap:anywhere]">{offer.title}</p>
                  </details>
                }
              />
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {page.kind === 'ready' && page.next && onNext ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onNext(page.next!)}>
            {m.subject_purchase_next({}, { locale: language })}
          </Button>
        ) : null}
        {onRestart ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onRestart}>
            {m.subject_purchase_restart({}, { locale: language })}
          </Button>
        ) : null}
        {(page.kind === 'unavailable' || page.kind === 'preparing' || preparing) && onRetry ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
            {m.subject_purchase_retry({}, { locale: language })}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function PreparedSubjectOffersRegion({
  context,
  viewer,
  credentialMode,
}: {
  context: SubjectPurchaseContext;
  viewer: SubjectOffersViewer;
  credentialMode: SubjectOffersInput['credentialMode'];
}) {
  const [cursor, setCursor] = useState<string>();
  const client = useQueryClient();
  const options = useMemo(
    () =>
      subjectOffersQuery(
        {
          subjectId: context.subjectId,
          locale: context.locale,
          credentialMode,
          ...(cursor ? { cursor } : {}),
        },
        viewer,
      ),
    [context.subjectId, context.locale, credentialMode, viewer, cursor],
  );
  const query = useQuery(options);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: options.queryKey, exact: true });
      client.removeQueries({ queryKey: options.queryKey, exact: true });
    },
    [client, options],
  );
  return (
    <SubjectOffersView
      page={
        !viewer.current?.() || query.isFetching
          ? { kind: 'pending' }
          : query.isError
            ? { kind: 'unavailable' }
            : (query.data ?? { kind: 'pending' })
      }
      locale={context.locale}
      onNext={(next) => {
        if (viewer.current?.()) setCursor(next);
      }}
      {...(cursor || query.data?.kind === 'cursor-error'
        ? {
            onRestart: () => {
              if (viewer.current?.()) {
                if (cursor) setCursor(undefined);
                else void query.refetch();
              }
            },
          }
        : {})}
      onRetry={() => {
        if (viewer.current?.()) void query.refetch();
      }}
    />
  );
}

/** Public presentation waits for session preparation so a denied actor never gets an anonymous fallback. */
export function SubjectOffersRegion(context: SubjectPurchaseContext) {
  const session = useSession();
  const { scope, epoch, current } = useSubjectOffersReadBoundary();
  const viewer = useMemo(
    () => ({
      subject: session.subject ?? null,
      sessionKey: session.csrfToken,
      readScope: scope,
      readEpoch: epoch,
      current,
    }),
    [session.subject, session.csrfToken, scope, epoch, current],
  );
  if (session.state === 'unknown') return <SubjectOffersView page={{ kind: 'pending' }} locale={context.locale} />;
  if (session.state === 'unavailable' || (session.state === 'signed-in' && !session.subject))
    return <SubjectOffersView page={{ kind: 'unavailable' }} locale={context.locale} />;
  return (
    <PreparedSubjectOffersRegion
      key={JSON.stringify([context.subjectId, context.locale, session.state, viewer.subject, viewer.sessionKey, epoch])}
      context={context}
      viewer={viewer}
      credentialMode={session.state === 'signed-in' ? 'session' : 'anonymous'}
    />
  );
}

/** The shared seam mounts this only after hydration and sign-in. No native bounded owned-benefit batch exists. */
export function SubjectOwnedBenefitsRegion({ locale }: SubjectPurchaseContext) {
  const language = locales.find((candidate) => candidate === locale);
  if (!language) return null;
  const href = purchaseHref('/entitlements', locale);
  return href ? (
    <div className="mt-4 flex min-w-0 flex-col gap-1 text-sm">
      <a href={href} className="inline-flex min-h-11 items-center underline underline-offset-4">
        {m.subject_purchase_records({}, { locale: language })}
      </a>
      <p className="max-w-prose text-muted-foreground">{m.subject_purchase_records_hint({}, { locale: language })}</p>
    </div>
  ) : null;
}
