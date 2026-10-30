import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
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
export type SubjectOffersViewer = { subject: string | null; sessionKey: string | null };
/** Browser-only and bound to the prepared actor/session, including cancellation of late personal responses. */
export function subjectOffersQuery(
  input: SubjectOffersInput,
  viewer: SubjectOffersViewer,
  read: (input: { data: SubjectOffersInput }) => Promise<SubjectOffersData> = readSubjectOffers,
) {
  return queryOptions({
    queryKey: [
      'subject-offers',
      input.subjectId,
      input.locale,
      input.credentialMode,
      viewer.subject,
      viewer.sessionKey,
      input.cursor ?? '',
    ],
    queryFn: async ({ signal }) => {
      const page = await read({ data: input });
      signal.throwIfAborted();
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
  const preparing = page.kind === 'preparing' || (page.kind === 'ready' && page.projectionState === 'preparing');
  return (
    <section className="mt-6 flex min-w-0 flex-col gap-3" aria-label={m.subject_purchase_heading({}, { locale })}>
      <h2 className="text-lg font-semibold">{m.subject_purchase_heading({}, { locale })}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">{m.subject_purchase_discovery({}, { locale })}</p>
      {page.kind === 'pending' || preparing ? (
        <p role="status" className="text-sm text-muted-foreground">
          {page.kind === 'pending'
            ? m.subject_purchase_pending({}, { locale })
            : m.subject_purchase_preparing({}, { locale })}
        </p>
      ) : null}
      {page.kind === 'denied' || page.kind === 'unavailable' || page.kind === 'cursor-error' ? (
        <Alert role="alert">
          <AlertDescription>
            {page.kind === 'denied'
              ? m.subject_purchase_denied({}, { locale })
              : page.kind === 'cursor-error'
                ? m.subject_purchase_cursor_error({}, { locale })
                : m.subject_purchase_unavailable({}, { locale })}
          </AlertDescription>
        </Alert>
      ) : null}
      {page.kind === 'ready' && page.offers.length === 0 && !preparing ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m.subject_purchase_empty({}, { locale })}</EmptyTitle>
            <EmptyDescription>{m.subject_purchase_discovery({}, { locale })}</EmptyDescription>
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
              <ListRow key={offer.id} className="flex min-w-0 flex-col gap-2 p-3">
                <h3 className="break-words font-semibold [overflow-wrap:anywhere]">{offer.title}</h3>
                <p className="text-sm">
                  {price ?? m.subject_purchase_price_unknown({}, { locale })}
                  {price && offer.taxBehavior === 'exclusive' ? ` · ${m.commerce_before_tax({}, { locale })}` : ''}
                </p>
                {benefit.kind === 'mapped' ? (
                  <>
                    <p className="text-sm text-muted-foreground">{m.benefit_fixed_version({}, { locale })}</p>
                    <p className="text-sm text-muted-foreground">{m.benefit_acquisition({}, { locale })}</p>
                    <p className="break-words text-sm [overflow-wrap:anywhere]">
                      {m.benefit_licence({}, { locale })}: {benefit.terms.source.licence}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{m.benefit_terms_unavailable({}, { locale })}</p>
                )}
                <span className="text-sm underline underline-offset-4">
                  {m.subject_purchase_review({}, { locale })}
                </span>
                {href ? (
                  <ListRowLink href={href}>
                    {m.subject_purchase_review_offer({ title: offer.title }, { locale })}
                  </ListRowLink>
                ) : null}
              </ListRow>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {page.kind === 'ready' && page.next && onNext ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onNext(page.next!)}>
            {m.subject_purchase_next({}, { locale })}
          </Button>
        ) : null}
        {onRestart ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onRestart}>
            {m.subject_purchase_restart({}, { locale })}
          </Button>
        ) : null}
        {(page.kind === 'unavailable' || page.kind === 'preparing' || preparing) && onRetry ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>
            {m.subject_purchase_retry({}, { locale })}
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
    [context.subjectId, context.locale, credentialMode, viewer.subject, viewer.sessionKey, cursor],
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
        query.isFetching
          ? { kind: 'pending' }
          : query.isError
            ? { kind: 'unavailable' }
            : (query.data ?? { kind: 'pending' })
      }
      locale={context.locale}
      onNext={setCursor}
      {...(cursor || query.data?.kind === 'cursor-error'
        ? { onRestart: () => (cursor ? setCursor(undefined) : void query.refetch()) }
        : {})}
      onRetry={() => void query.refetch()}
    />
  );
}

/** Public presentation waits for session preparation so a denied actor never gets an anonymous fallback. */
export function SubjectOffersRegion(context: SubjectPurchaseContext) {
  const session = useSession();
  if (session.state === 'unknown') return <SubjectOffersView page={{ kind: 'pending' }} locale={context.locale} />;
  if (session.state === 'unavailable' || (session.state === 'signed-in' && (!session.subject || !session.csrfToken)))
    return <SubjectOffersView page={{ kind: 'unavailable' }} locale={context.locale} />;
  const viewer = { subject: session.subject ?? null, sessionKey: session.csrfToken };
  return (
    <PreparedSubjectOffersRegion
      key={JSON.stringify([context.subjectId, context.locale, session.state, viewer.subject, viewer.sessionKey])}
      context={context}
      viewer={viewer}
      credentialMode={session.state === 'signed-in' ? 'session' : 'anonymous'}
    />
  );
}

/** The shared seam mounts this only after hydration and sign-in. No native bounded owned-benefit batch exists. */
export function SubjectOwnedBenefitsRegion({ locale }: SubjectPurchaseContext) {
  const href = purchaseHref('/entitlements', locale);
  return href ? (
    <div className="mt-4 flex min-w-0 flex-col gap-1 text-sm">
      <a href={href} className="inline-flex min-h-11 items-center underline underline-offset-4">
        {m.subject_purchase_records({}, { locale })}
      </a>
      <p className="max-w-prose text-muted-foreground">{m.subject_purchase_records_hint({}, { locale })}</p>
    </div>
  ) : null;
}
