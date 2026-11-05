import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { CreatorOffer } from '../creator-offers';
import type { OfferDifference, OfferReviewStatus } from './observation';
import { formatMinorAmount } from '../money';
import { recordedMoneyUnit, recordedTaxBehavior } from '../money-schema';
import { CapturedOfferReferences } from './captured-terms';
import { sameOfferObservation } from './observation';

function differenceLabel(value: OfferDifference): string {
  switch (value) {
    case 'revision':
      return m.creator_inspect_change_revision();
    case 'title':
      return m.creator_inspect_change_title();
    case 'state':
      return m.creator_inspect_change_state();
    case 'price':
      return m.creator_inspect_change_price();
    case 'tax':
      return m.creator_inspect_change_tax();
    case 'mapping':
      return m.creator_inspect_change_mapping();
    case 'edition':
      return m.creator_inspect_change_edition();
    case 'version':
      return m.creator_inspect_change_version();
    case 'licence':
      return m.creator_inspect_change_licence();
    case 'reference':
      return m.creator_inspect_change_reference();
    case 'delivery':
      return m.creator_inspect_change_delivery();
    case 'acquisition':
      return m.creator_inspect_change_acquisition();
    case 'quantity':
      return m.creator_inspect_change_quantity();
    case 'subject':
      return m.creator_inspect_change_subject();
    case 'creator':
      return m.creator_inspect_change_creator();
  }
}

/** Both sides are owned-list observations; comparison does not become command authority. */
function OfferObservationSummary({ offer, locale }: { offer: CreatorOffer; locale: string }) {
  const terms = offer.contentEdition;
  return (
    <dl className="min-w-0 space-y-3 text-sm [&_dt]:font-medium [&_dd]:mt-1 [&_dd]:break-words [&_dd]:[overflow-wrap:anywhere]">
      <div>
        <dt>{m.creator_inspect_title_label()}</dt>
        <dd>{offer.title}</dd>
      </div>
      <div>
        <dt>{m.creator_offers_offer_revision()}</dt>
        <dd className="tabular-nums">{offer.revision}</dd>
      </div>
      <div>
        <dt>{m.creator_inspect_status_label()}</dt>
        <dd>{offer.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted()}</dd>
      </div>
      <div>
        <dt>{m.creator_inspect_price_label()}</dt>
        <dd>
          {formatMinorAmount(locale, offer.currency, offer.unitAmountMinor, recordedMoneyUnit(offer)) ??
            m.creator_offers_amount_unavailable()}{' '}
          {offer.currency.toUpperCase()}
          <p className="mt-1 text-muted-foreground">
            {recordedTaxBehavior(offer) === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
          </p>
        </dd>
      </div>
      <div>
        <dt>{m.creator_inspect_mapping_label()}</dt>
        <dd>{terms === null ? m.creator_offers_unknown() : m.creator_offers_captured()}</dd>
      </div>
      {terms && (
        <>
          <div>
            <dt>{m.creator_inspect_licence_label()}</dt>
            <dd>{terms.source.licence}</dd>
          </div>
          <div>
            <dt>{m.creator_inspect_quantity_label()}</dt>
            <dd>{terms.quantity}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

/** A retained row is a command's original observation, even when current rows move or disappear. */
export function RetainedOfferObservation({
  observed,
  received,
  locale,
}: {
  observed: CreatorOffer;
  received: CreatorOffer | undefined;
  locale: string;
}) {
  if (received && sameOfferObservation(observed, received)) return null;
  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border p-3 text-sm leading-relaxed"
      aria-label={m.creator_inspect_row_retained()}
    >
      <p className="font-medium">{m.creator_inspect_row_retained()}</p>
      <p>
        {received ? m.creator_inspect_row_received({ revision: received.revision }) : m.creator_inspect_row_missing()}
      </p>
      <p className="text-muted-foreground">{m.creator_inspect_row_review()}</p>
      {received && (
        <details className="min-w-0">
          <summary className="min-h-11 cursor-pointer content-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.creator_inspect_row_current_summary()}
          </summary>
          <div className="min-w-0 space-y-3 py-3">
            <OfferObservationSummary offer={received} locale={locale} />
            <p className="text-muted-foreground">{m.creator_inspect_row_current_notice()}</p>
          </div>
        </details>
      )}
    </section>
  );
}

export function ChangedOfferReview({
  observed,
  status,
  locale,
  restartHref,
  review,
  headingId,
}: {
  observed: CreatorOffer;
  status: OfferReviewStatus;
  locale: string;
  restartHref: string;
  review(): void;
  headingId: string;
}) {
  if (status.kind === 'same') return null;
  if (status.kind === 'missing') {
    return (
      <section className="min-w-0 space-y-3 rounded-lg border p-4" aria-label={m.creator_inspect_missing_heading()}>
        <h3 id={headingId} tabIndex={-1} className="font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          {m.creator_inspect_missing_heading()}
        </h3>
        <p role="status" className="max-w-prose text-sm leading-relaxed">
          {m.creator_inspect_missing_meaning()}
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.creator_inspect_missing_command()}
        </p>
        <a href={restartHref} className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}>
          {m.creator_offers_restart()}
        </a>
      </section>
    );
  }
  return (
    <section className="min-w-0 space-y-4 rounded-lg border p-4" aria-label={m.creator_inspect_changed_heading()}>
      <div className="space-y-2">
        <h3 id={headingId} tabIndex={-1} className="font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          {m.creator_inspect_changed_heading()}
        </h3>
        <p role="status" className="max-w-prose text-sm leading-relaxed">
          {m.creator_inspect_changed_meaning()}
        </p>
      </div>
      <ul className="list-disc space-y-1 ps-5 text-sm" aria-label={m.creator_inspect_changes_label()}>
        {status.differences.map((difference) => (
          <li key={difference}>{differenceLabel(difference)}</li>
        ))}
      </ul>
      <details className="min-w-0">
        <summary className="min-h-11 cursor-pointer content-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.creator_inspect_compare_heading()}
        </summary>
        <div className="grid min-w-0 gap-6 py-4 sm:grid-cols-2">
          <section className="min-w-0 space-y-3" aria-label={m.creator_inspect_observed_heading()}>
            <h4 className="font-semibold">{m.creator_inspect_observed_heading()}</h4>
            <OfferObservationSummary offer={observed} locale={locale} />
            <CapturedOfferReferences offer={observed} />
          </section>
          <section className="min-w-0 space-y-3" aria-label={m.creator_inspect_received_heading()}>
            <h4 className="font-semibold">{m.creator_inspect_received_heading()}</h4>
            <OfferObservationSummary offer={status.current} locale={locale} />
            <CapturedOfferReferences offer={status.current} />
          </section>
        </div>
      </details>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.creator_inspect_review_command_notice()}
      </p>
      <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal text-start" onClick={review}>
        {m.creator_inspect_review_received()}
      </Button>
    </section>
  );
}
