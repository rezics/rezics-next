import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { CreatorOfferDraftNavigation, CreatorOfferDraftState } from './creator-offer-draft-navigation';
import { creatorPreviewGuard, useCreatorCurrentOrigin, useCreatorIntent } from './creator-current-origin';
import { ContentItem } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import {
  manageCreatorOffer,
  type CreatorOffer,
  type CreatorOfferGuard,
  type CreatorOfferMutation,
  type CreatorOfferResult,
  type CreatorOffersData,
  type CreatorOffersPageData,
} from './creator-offers';
import { CreatorPriceField, creatorNotice, parsedPrice } from './creator-offer-editor';
import { recordedMoneyUnit, recordedTaxBehavior } from './money-schema';
import { formatMinorAmount } from './money';

// Only this page's edited rows are retained; untouched rows follow the current read.
const OfferJourney = createContext<{
  retain(offer: CreatorOffer): void;
  release(id: string): void;
  confirmOffer: ((id: string) => Promise<CreatorOffer | null>) | undefined;
}>({ retain() {}, release() {}, confirmOffer: undefined });

function OwnedOfferControls({
  offer,
  data,
  locale,
  guard,
}: {
  offer: CreatorOffer;
  data: CreatorOffersPageData;
  locale: string;
  guard?: CreatorOfferGuard | undefined;
}) {
  if (guard) return <OfferCommands offer={offer} data={data} locale={locale} guard={guard} />;
  return <StandaloneOfferCommands offer={offer} data={data} locale={locale} />;
}

function StandaloneOfferCommands({
  offer,
  data,
  locale,
}: {
  offer: CreatorOffer;
  data: CreatorOffersPageData;
  locale: string;
}) {
  const client = useContext(QueryClientContext);
  return client ? (
    <ObservedOfferCommands offer={offer} data={data} locale={locale} />
  ) : (
    <OfferCommands offer={offer} data={data} locale={locale} guard={creatorPreviewGuard} />
  );
}

function ObservedOfferCommands({
  offer,
  data,
  locale,
}: {
  offer: CreatorOffer;
  data: CreatorOffersPageData;
  locale: string;
}) {
  const current = useCreatorCurrentOrigin(
    'offer.list',
    JSON.stringify([locale, offer.id]),
    offer.contentEdition?.creatorAccountId,
  );
  return <OfferCommands key={current.origin.id} offer={offer} data={data} locale={locale} guard={current.origin} />;
}

type ChangeIntent = {
  observed: CreatorOffer;
  text: string;
  pending: CreatorOfferMutation | null;
  csrfToken?: string | undefined;
  keys: CreatorOffersPageData['keys'][string] | undefined;
  rule: NonNullable<CreatorOffersPageData['schema']>['configuredSaleCurrencies'][number] | undefined;
  result: CreatorOfferResult | null;
};

function OfferCommands({
  offer,
  data,
  locale,
  guard,
}: {
  offer: CreatorOffer;
  data: CreatorOffersPageData;
  locale: string;
  guard: CreatorOfferGuard;
}) {
  const memory = useCreatorIntent<ChangeIntent>(guard, offer.id);
  const sender = useCreatorIntent<(data: CreatorOfferMutation) => Promise<CreatorOfferResult>>(
    guard,
    `${offer.id}-sender`,
  );
  const [resume] = useState(memory.value);
  const { retain, release, confirmOffer } = useContext(OfferJourney);
  // Keep the observed row and original command stable while a write's outcome is uncertain.
  const [draft, setDraft] = useState(resume);
  const observed = draft?.observed ?? offer;
  const [text, setText] = useState(resume?.text ?? '');
  const [result, setResult] = useState<CreatorOfferResult | null>(resume?.result ?? null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [checking, setChecking] = useState(false);
  const reading = useRef(false);
  const [open, setOpen] = useState(false);
  const controlsId = useId();
  const pending = useRef<CreatorOfferMutation | null>(resume?.pending ?? null);
  const submittedCsrf = useRef(resume?.csrfToken);
  const locked = useRef(resume?.result?.kind === 'saved');
  const keys = useRef(resume ? resume.keys : data.keys[observed.id]);
  if (!draft) keys.current = data.keys[offer.id];
  const rule = draft
    ? draft.rule
    : data.schema?.configuredSaleCurrencies.find((row) => row.currency === observed.currency);
  const mounted = useRef({ active: false });
  useLayoutEffect(() => {
    const current = { active: true };
    mounted.current = current;
    return () => {
      current.active = false;
    };
  }, []);
  const isCurrent = () => mounted.current.active && guard.isCurrent();
  const csrf = () => guard.csrfToken();
  const uncertain = result?.kind === 'retry';
  const conflicted = result?.kind === 'conflict';
  const frozen = busy || uncertain || conflicted || (result?.kind === 'saved' && !confirmed);
  const editable = observed.state === 'active' && data.selling && !!csrf() && !!keys.current && guard.isCurrent();
  // Disclosure never hides an edited intent or an operation's recovery/result. Authority
  // withdrawal still belongs to the current-origin boundary that mounts these controls.
  const keepOpen = !!draft || busy || !!pending.current || !!result;
  const expanded = open || keepOpen;
  function keepDraft(next: ChangeIntent) {
    memory.value = next;
    setDraft(next);
    retain(observed);
  }
  async function refreshSaved(review = false) {
    if (!confirmOffer || reading.current || !isCurrent()) return;
    const lifetime = mounted.current;
    reading.current = true;
    setChecking(true);
    try {
      // This read starts after the command result. An older or missing row cannot
      // settle the display, and reading never resubmits the saved command.
      const current = await confirmOffer(observed.id);
      if (!lifetime.active || !guard.isCurrent() || !current || current.revision <= observed.revision) return;
      pending.current = null;
      submittedCsrf.current = undefined;
      keys.current = { reprice: crypto.randomUUID(), delist: crypto.randomUUID() };
      if (review) {
        // Only this explicit review can adopt newer terms; preserve the typed price.
        const next: ChangeIntent = {
          observed: current,
          text,
          pending: null,
          keys: keys.current,
          rule: data.schema?.configuredSaleCurrencies.find((row) => row.currency === current.currency),
          result: null,
        };
        memory.value = next;
        setDraft(next);
        retain(current);
        setResult(null);
        locked.current = false;
        return;
      }
      delete memory.value;
      setDraft(undefined);
      setText('');
      setConfirmed(true);
      locked.current = false;
      release(observed.id);
    } catch {
      // The write is confirmed even when the subsequent availability read fails.
    } finally {
      reading.current = false;
      if (lifetime.active && guard.isCurrent()) setChecking(false);
    }
  }
  async function change(operation: 'reprice' | 'delist') {
    const lifetime = mounted.current;
    const owns = () => lifetime.active && guard.isCurrent();
    const csrfToken = csrf();
    if (!isCurrent() || !csrfToken || locked.current || conflicted || !editable) return;
    if (!pending.current) {
      const key = keys.current?.[operation];
      if (!key) return;
      const amount = parsedPrice(text, rule);
      if (operation === 'reprice' && amount === null) return;
      submittedCsrf.current = csrfToken;
      pending.current =
        operation === 'delist'
          ? { operation, offerId: observed.id, expectedRevision: observed.revision, idempotencyKey: key }
          : {
              operation,
              offerId: observed.id,
              expectedRevision: observed.revision,
              idempotencyKey: key,
              unitAmountMinor: amount!,
            };
      const execute = manageCreatorOffer;
      sender.value = (data) => execute({ data, headers: { 'X-CSRF-Token': csrfToken } });
    }
    keepDraft({
      observed,
      text,
      pending: pending.current,
      csrfToken: submittedCsrf.current,
      keys: keys.current,
      rule,
      result: { kind: 'retry' },
    });
    locked.current = true;
    setConfirmed(false);
    setResult(null);
    setBusy(true);
    let saved = false;
    let conflictedResult = false;
    try {
      const next = await sender.value!(pending.current);
      if (!owns()) return;
      saved = next.kind === 'saved';
      conflictedResult = next.kind === 'conflict';
      setResult(next);
      if (next.kind !== 'retry' && next.kind !== 'saved' && next.kind !== 'conflict') {
        pending.current = null;
        keys.current = { reprice: crypto.randomUUID(), delist: crypto.randomUUID() };
      }
      memory.value = {
        observed,
        text,
        pending: pending.current,
        csrfToken: submittedCsrf.current,
        keys: keys.current,
        rule,
        result: next,
      };
      if (saved) void refreshSaved();
    } catch {
      if (owns()) setResult({ kind: 'retry' });
    } finally {
      if (owns()) {
        locked.current = saved || conflictedResult;
        setBusy(false);
      }
    }
  }
  if (observed.state !== 'active' && !result) return null;
  return (
    <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <Button
        type="button"
        variant="outline"
        aria-expanded={expanded}
        aria-controls={controlsId}
        aria-label={m.creator_offer_controls_manage_offer({ title: observed.title })}
        aria-disabled={keepOpen}
        aria-describedby={keepOpen ? `${controlsId}-retained` : undefined}
        className="h-auto min-h-11 max-w-full whitespace-normal text-start"
        onClick={() => {
          if (!keepOpen) setOpen((value) => !value);
        }}
      >
        {m.creator_offer_controls_manage()}
      </Button>
      <CreatorOfferDraftState
        guard={guard}
        dirty={result?.kind !== 'saved' && text !== ''}
        mayCommit={busy || uncertain}
        discard={() => {
          delete memory.value;
          setDraft(undefined);
          setText('');
          setResult(null);
          release(observed.id);
        }}
      />
      <div id={controlsId} hidden={!expanded} className="min-w-0 space-y-4">
        {keepOpen && (
          <p id={`${controlsId}-retained`} className="text-sm leading-relaxed text-muted-foreground">
            {m.creator_offer_controls_retained()}
          </p>
        )}
        {busy && <p role="status">{m.creator_saving()}</p>}
        {observed.state === 'active' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void change('reprice');
            }}
            className="space-y-4"
          >
            <CreatorPriceField
              rule={rule}
              text={text}
              onChange={(next) => {
                if (isCurrent() && !frozen) {
                  keepDraft({
                    observed,
                    text: next,
                    pending: pending.current,
                    keys: keys.current,
                    rule,
                    result: confirmed ? null : result,
                  });
                  if (confirmed) setResult(null);
                  setText(next);
                }
              }}
              locale={locale}
              disabled={!editable || frozen}
            />
            <p className="text-sm leading-relaxed text-muted-foreground">{m.creator_revision_meaning()}</p>
            {!rule && (
              <p className="text-sm" role="status">
                {m.creator_price_unavailable()}
              </p>
            )}
            {uncertain ? (
              <Button
                type="button"
                onClick={() => {
                  if (pending.current?.operation !== 'create') void change(pending.current?.operation ?? 'reprice');
                }}
                disabled={busy || !editable}
                className="min-h-11"
              >
                {m.creator_retry()}
              </Button>
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  disabled={!editable || frozen || parsedPrice(text, rule) === null}
                  className="min-h-11"
                >
                  {m.creator_reprice()}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!editable || frozen}
                  className="min-h-11"
                  onClick={() => void change('delist')}
                >
                  {m.creator_delist()}
                </Button>
              </div>
            )}
          </form>
        )}
        {result && <p role={result.kind === 'saved' ? 'status' : 'alert'}>{creatorNotice(result.kind)}</p>}
        {(conflicted || (result?.kind === 'saved' && !confirmed)) && confirmOffer && (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={checking}
            onClick={() => void refreshSaved(conflicted)}
          >
            {checking ? m.creator_offers_preparing() : conflicted ? m.offer_review_terms() : m.creator_offers_refresh()}
          </Button>
        )}
      </div>
    </div>
  );
}

export function creatorOffersHref(locale: string, cursor?: string): string {
  return `/${locale}/creator/offers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
}

export function CreatorOffersPage({
  page: suppliedPage,
  data,
  locale,
  cursor,
  offerPageAvailable = true,
  guard,
  onRefresh,
  onConfirm,
  refreshing = false,
}: {
  page?: CreatorOffersData;
  data?: CreatorOffersPageData;
  locale: string;
  cursor?: string;
  offerPageAvailable?: boolean;
  guard?: CreatorOfferGuard | undefined;
  onRefresh?: () => void;
  onConfirm?: (id: string) => Promise<CreatorOffer | null>;
  refreshing?: boolean;
}) {
  const memory = useCreatorIntent<Record<string, CreatorOffer>>(guard ?? creatorPreviewGuard, 'offer-rows');
  const [retained, setRetained] = useState(memory.value ?? {});
  function retain(offer: CreatorOffer) {
    if (!guard?.isCurrent()) return;
    const previous = memory.value ?? retained;
    if (previous[offer.id] === offer) return;
    const next = { ...previous, [offer.id]: offer };
    memory.value = next;
    setRetained(next);
  }
  function release(id: string) {
    if (!guard?.isCurrent()) return;
    const next = { ...(memory.value ?? retained) };
    delete next[id];
    memory.value = next;
    setRetained(next);
  }
  const page = data?.page ?? suppliedPage ?? { kind: 'unavailable' as const };
  const offers =
    page.kind === 'ready'
      ? [
          ...page.offers.map((offer) => retained[offer.id] ?? offer),
          ...Object.values(retained).filter((offer) => !page.offers.some((current) => current.id === offer.id)),
        ]
      : [];
  const href = creatorOffersHref(locale, cursor);
  const notice =
    page.kind === 'denied'
      ? m.creator_offers_denied()
      : page.kind === 'stale'
        ? m.creator_offers_stale()
        : page.kind === 'error'
          ? m.creator_offers_error()
          : page.kind === 'preparing'
            ? m.creator_offers_preparing()
            : page.kind === 'closed' || page.kind === 'rejected'
              ? creatorNotice(page.kind)
              : m.creator_offers_unavailable();
  const restart = page.kind === 'stale' || page.kind === 'error';
  return (
    <CreatorOfferDraftNavigation>
      <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="creator-offers-heading">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PageHeading id="creator-offers-heading">{m.creator_offers_heading()}</PageHeading>
          {page.kind !== 'preparing' &&
            (onRefresh ? (
              <Button variant="outline" className="min-h-11" onClick={onRefresh} disabled={refreshing}>
                {m.creator_offers_refresh()}
              </Button>
            ) : (
              <a href={href} className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}>
                {m.creator_offers_refresh()}
              </a>
            ))}
        </div>
        {data && (
          <a
            href={`/${locale}/creator/offers/new`}
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            {m.creator_new_offer()}
          </a>
        )}
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.creator_offers_intro()}</p>
        {page.kind !== 'ready' ? (
          <div
            className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground"
            role={page.kind === 'preparing' ? 'status' : 'alert'}
          >
            <p>{notice}</p>
            {page.kind !== 'preparing' && (
              <a
                href={restart ? creatorOffersHref(locale) : href}
                className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
              >
                {restart ? m.creator_offers_restart() : m.creator_offers_retry()}
              </a>
            )}
          </div>
        ) : (
          <>
            {offers.length === 0 ? (
              <div role="status" className="space-y-2 rounded-xl border bg-card p-5 text-card-foreground">
                <p className="font-medium">{cursor ? m.creator_offers_page_empty() : m.creator_offers_empty()}</p>
                <p className="text-sm text-muted-foreground">{m.creator_offers_empty_hint()}</p>
              </div>
            ) : (
              <OfferJourney.Provider value={{ retain, release, confirmOffer: onConfirm }}>
                <ul className="space-y-3 rounded-xl border bg-card p-3 text-card-foreground sm:p-5">
                  {offers.map((offer) => (
                    <ContentItem
                      key={offer.id}
                      data-offer-state={offer.state}
                      title={offer.title}
                      headingLevel={2}
                      {...(offer.state === 'active' && offerPageAvailable
                        ? { href: `/${locale}/offers/${offer.id}` }
                        : {})}
                      className="p-3 sm:[&>div]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] [&_h2]:break-words [&_h2]:[overflow-wrap:anywhere]"
                      metadata={
                        <div className="min-w-0 space-y-2">
                          <p className="font-serif text-lg tabular-nums">
                            {formatMinorAmount(
                              locale,
                              offer.currency,
                              offer.unitAmountMinor,
                              recordedMoneyUnit(offer),
                            ) ?? m.creator_offers_amount_unavailable()}{' '}
                            <span className="text-sm">{offer.currency.toUpperCase()}</span>
                          </p>
                          <p>
                            {recordedTaxBehavior(offer) === 'exclusive'
                              ? m.commerce_before_tax()
                              : m.commerce_tax_unknown()}
                          </p>
                          <p className="leading-relaxed">
                            {offer.contentEdition === null ? m.creator_offers_unknown() : m.creator_offers_captured()}
                          </p>
                        </div>
                      }
                      state={
                        <p className="text-sm font-medium">
                          {offer.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted()}
                        </p>
                      }
                      actions={
                        <details className="min-w-0 max-w-sm">
                          <summary className="min-h-11 cursor-pointer content-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                            {m.commerce_full_title()}
                          </summary>
                          <p className="break-words py-2 text-sm [overflow-wrap:anywhere]">{offer.title}</p>
                        </details>
                      }
                      trailing={
                        data && (
                          <div className="w-full min-w-0 max-w-sm">
                            <OwnedOfferControls offer={offer} data={data} locale={locale} guard={guard} />
                          </div>
                        )
                      }
                    />
                  ))}
                </ul>
              </OfferJourney.Provider>
            )}
            <nav aria-label={m.creator_offers_pagination()} className="flex flex-wrap gap-3">
              {cursor && (
                <a
                  href={creatorOffersHref(locale)}
                  className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
                >
                  {m.creator_offers_restart()}
                </a>
              )}
              {page.next && (
                <a
                  href={creatorOffersHref(locale, page.next)}
                  className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
                >
                  {m.creator_offers_next()}
                </a>
              )}
            </nav>
          </>
        )}
      </section>
    </CreatorOfferDraftNavigation>
  );
}
