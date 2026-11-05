import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { CapturedOfferReferences, CapturedOfferTerms } from '../creator-offer-review/captured-terms';
import { formatMinorAmount } from '../money';
import type { SubjectOffer } from '../subject-offers';
import { readableSubjectOffer, type CaptureLabel } from './model';

export function OfferCaptureLabel({ label, locale }: { label: CaptureLabel | undefined; locale: Locale }) {
  return (
    <p className="text-sm font-medium" data-offer-capture-label="">
      {label
        ? m.subject_choice_capture({ edition: label.edition, version: label.version }, { locale })
        : m.subject_choice_capture_unknown({}, { locale })}
    </p>
  );
}

export function OfferObservedRevision({ offer, locale }: { offer: SubjectOffer; locale: Locale }) {
  return <p className="text-sm tabular-nums">{m.subject_choice_revision({ revision: offer.revision }, { locale })}</p>;
}

/** One canonical destination, without a cursor, receipt or consent from this discovery page. */
export function OfferReviewLink({
  offer,
  href,
  locale,
  current,
}: {
  offer: SubjectOffer;
  href: string;
  locale: Locale;
  current: () => boolean;
}) {
  return (
    <a
      href={href}
      className={buttonVariants({ className: 'h-auto min-h-11 max-w-full whitespace-normal text-start' })}
      aria-label={m.subject_choice_review_label(
        { title: offer.title, revision: offer.revision, id: offer.id },
        { locale },
      )}
      onClick={(event) => {
        if (!current()) event.preventDefault();
      }}
    >
      {m.subject_purchase_review({}, { locale })}
    </a>
  );
}

/** Prices stay recorded tuples. This reader never estimates a payable total or multiplies quantity. */
export function OfferRecordedPrice({
  offer,
  locale,
  id,
}: {
  offer: SubjectOffer;
  locale: Locale;
  id?: string | undefined;
}) {
  const price = formatMinorAmount(locale, offer.currency, offer.unitAmountMinor, offer.moneyUnit);
  return (
    <section aria-label={m.subject_choice_price_heading({}, { locale })} className="min-w-0 space-y-3">
      <h3
        id={id ? `${id}-price` : undefined}
        tabIndex={-1}
        className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.subject_choice_price_heading({}, { locale })}
      </h3>
      <p className="break-words text-xl tabular-nums" data-offer-recorded-price="">
        {price ?? m.subject_purchase_price_unknown({}, { locale })}
      </p>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2 [&_dt]:font-medium [&_dd]:mt-1">
        <div>
          <dt>{m.subject_choice_currency({}, { locale })}</dt>
          <dd>{offer.currency.toUpperCase()}</dd>
        </div>
        <div>
          <dt>{m.subject_choice_tax_label({}, { locale })}</dt>
          <dd>
            {offer.taxBehavior === 'exclusive'
              ? m.commerce_before_tax({}, { locale })
              : m.commerce_tax_unknown({}, { locale })}
          </dd>
        </div>
      </dl>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {offer.taxBehavior === 'exclusive'
          ? m.subject_choice_before_tax_meaning({}, { locale })
          : m.subject_choice_tax_unknown_meaning({}, { locale })}
      </p>
      {!price && (
        <p className="max-w-prose text-sm leading-relaxed">{m.subject_choice_money_unknown({}, { locale })}</p>
      )}
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.subject_choice_price_meaning({}, { locale })}
      </p>
    </section>
  );
}

export function OfferTermsReading({
  offer,
  label,
  locale,
  id,
}: {
  offer: SubjectOffer;
  label: CaptureLabel | undefined;
  locale: Locale;
  id?: string | undefined;
}) {
  const readable = readableSubjectOffer(offer);
  return (
    <div className="min-w-0 space-y-6" data-offer-terms="">
      <OfferRecordedPrice offer={offer} locale={locale} id={id} />
      <div className="min-w-0 space-y-3 border-t pt-5">
        <OfferCaptureLabel label={label} locale={locale} />
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_capture_labels_meaning({}, { locale })}
        </p>
        <CapturedOfferTerms
          offer={readable}
          locale={locale}
          origin="public"
          {...(id ? { headingId: `${id}-terms` } : {})}
        />
      </div>
      <div className="min-w-0 space-y-3 border-t pt-5">
        <CapturedOfferReferences offer={readable} locale={locale} {...(id ? { summaryId: `${id}-references` } : {})} />
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_target_meaning({}, { locale })}
        </p>
      </div>
      <details className="min-w-0 rounded-lg border px-4">
        <summary className="min-h-11 cursor-pointer content-center py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.subject_choice_money_references({}, { locale })}
        </summary>
        <dl className="min-w-0 space-y-4 pb-4 text-sm [&_dd]:mt-1 [&_dd]:break-words [&_dd]:[overflow-wrap:anywhere] [&_dt]:font-medium">
          <div>
            <dt>{m.subject_choice_raw_amount({}, { locale })}</dt>
            <dd>
              <code>{offer.unitAmountMinor}</code>
            </dd>
          </div>
          <div>
            <dt>{m.subject_choice_currency({}, { locale })}</dt>
            <dd>
              <code>{offer.currency}</code>
            </dd>
          </div>
          <div>
            <dt>{m.subject_choice_recorded_unit({}, { locale })}</dt>
            <dd>
              {offer.moneyUnit ? (
                <code>{`${offer.moneyUnit.system} · ${offer.moneyUnit.factsVersion} · ${offer.moneyUnit.exponent}`}</code>
              ) : (
                m.subject_choice_unit_unknown({}, { locale })
              )}
            </dd>
          </div>
          <div>
            <dt>{m.subject_choice_raw_tax({}, { locale })}</dt>
            <dd>
              <code>{offer.taxBehavior ?? m.subject_choice_not_recorded({}, { locale })}</code>
            </dd>
          </div>
        </dl>
        <p className="max-w-prose pb-4 text-sm text-muted-foreground">
          {m.subject_choice_raw_money_meaning({}, { locale })}
        </p>
      </details>
    </div>
  );
}
