import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { SubjectOffer } from '../subject-offers';
import { subjectOfferKey, suppliedOfferDifferences, type CaptureLabel, type SuppliedDifference } from './model';
import type { SubjectOfferReading } from './reading';
import type { OfferDestination } from './rows';
import { OfferObservedRevision, OfferReviewLink, OfferTermsReading } from './terms';

function DifferenceFact({ label, value, locale }: { label: string; value: SuppliedDifference; locale: Locale }) {
  return (
    <div className="min-w-0 space-y-1 rounded-lg border p-3">
      <dt className="font-medium">{label}</dt>
      <dd className="text-sm text-muted-foreground">
        {value === 'same'
          ? m.subject_choice_same({}, { locale })
          : value === 'different'
            ? m.subject_choice_different({}, { locale })
            : m.subject_choice_unknown_difference({}, { locale })}
      </dd>
    </div>
  );
}

/** Relation labels describe supplied facts; they do not collapse separate offers or recommend a winner. */
function SuppliedDifferences({ first, second, locale }: { first: SubjectOffer; second: SubjectOffer; locale: Locale }) {
  const differences = suppliedOfferDifferences(first, second);
  const [showMatches, setShowMatches] = useState(true);
  const filterId = useId();
  return (
    <section aria-label={m.subject_choice_differences({}, { locale })} className="min-w-0 space-y-4">
      <h3 className="text-lg font-semibold">{m.subject_choice_differences({}, { locale })}</h3>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.subject_choice_differences_meaning({}, { locale })}
      </p>
      <div className="space-y-2">
        <label htmlFor={filterId} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
          <input
            id={filterId}
            type="checkbox"
            checked={showMatches}
            onChange={(event) => setShowMatches(event.currentTarget.checked)}
            className="size-5 shrink-0 accent-primary"
          />
          {m.subject_choice_show_matches({}, { locale })}
        </label>
        <p className="max-w-prose text-sm text-muted-foreground">{m.subject_choice_filter_meaning({}, { locale })}</p>
      </div>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(showMatches || differences.identity !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_identity({}, { locale })}
            value={differences.identity}
            locale={locale}
          />
        )}
        {(showMatches || differences.title !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_title_label({}, { locale })}
            value={differences.title}
            locale={locale}
          />
        )}
        {(showMatches || differences.target !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_target_label({}, { locale })}
            value={differences.target}
            locale={locale}
          />
        )}
        {(showMatches || differences.edition !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_edition_label({}, { locale })}
            value={differences.edition}
            locale={locale}
          />
        )}
        {(showMatches || differences.version !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_version_label({}, { locale })}
            value={differences.version}
            locale={locale}
          />
        )}
        {(showMatches || differences.digest !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_digest_label({}, { locale })}
            value={differences.digest}
            locale={locale}
          />
        )}
        {(showMatches || differences.licence !== 'same') && (
          <DifferenceFact label={m.benefit_licence({}, { locale })} value={differences.licence} locale={locale} />
        )}
        {(showMatches || differences.acquisition !== 'same') && (
          <DifferenceFact
            label={m.benefit_acquisition_label({}, { locale })}
            value={differences.acquisition}
            locale={locale}
          />
        )}
        {(showMatches || differences.quantity !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_quantity_label({}, { locale })}
            value={differences.quantity}
            locale={locale}
          />
        )}
        {(showMatches || differences.price !== 'same') && (
          <DifferenceFact
            label={m.subject_choice_price_heading({}, { locale })}
            value={differences.price}
            locale={locale}
          />
        )}
        {(showMatches || differences.tax !== 'same') && (
          <DifferenceFact label={m.subject_choice_tax_label({}, { locale })} value={differences.tax} locale={locale} />
        )}
      </dl>
      <p className="max-w-prose text-sm leading-relaxed">
        {differences.edition === 'unknown'
          ? m.subject_choice_unknown_editions({}, { locale })
          : differences.edition === 'same'
            ? m.subject_choice_same_edition({}, { locale })
            : m.subject_choice_different_editions({}, { locale })}
      </p>
      <details className="min-w-0 rounded-lg border px-4">
        <summary className="min-h-11 cursor-pointer content-center py-3 font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {m.subject_choice_differences_meaning({}, { locale })}
        </summary>
        <ul className="list-disc space-y-3 pb-4 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li>{m.subject_choice_identity_difference({}, { locale })}</li>
          <li>{m.subject_choice_version_difference({}, { locale })}</li>
          <li>{m.subject_choice_digest_difference({}, { locale })}</li>
          <li>{m.subject_choice_licence_difference({}, { locale })}</li>
        </ul>
      </details>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.subject_choice_compare_money({}, { locale })}
      </p>
    </section>
  );
}

function ComparisonOperand({
  offer,
  position,
  locale,
  labels,
  reading,
  destination,
}: {
  offer: SubjectOffer;
  position: 1 | 2;
  locale: Locale;
  labels: ReadonlyMap<string, CaptureLabel>;
  reading: SubjectOfferReading;
  destination: OfferDestination;
}) {
  const titleId = `${reading.id}-operand-${position}`;
  return (
    <article
      aria-labelledby={titleId}
      className="min-w-0 space-y-5 rounded-xl border p-4 [overflow-wrap:anywhere]"
      data-offer-comparison-operand={position}
    >
      <header className="min-w-0 space-y-3">
        <p className="text-sm font-medium text-muted-foreground">
          {m.subject_choice_operand({ position }, { locale })}
        </p>
        <h3 id={titleId} className="whitespace-pre-wrap break-words text-xl font-semibold">
          {offer.title}
        </h3>
        <OfferObservedRevision offer={offer} locale={locale} />
        <p className="max-w-prose text-sm text-muted-foreground">{m.subject_choice_seller_title({}, { locale })}</p>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 whitespace-normal text-start"
          aria-label={m.subject_choice_remove_label({ position, title: offer.title }, { locale })}
          onClick={() => reading.remove(offer)}
        >
          {m.subject_choice_remove({}, { locale })}
        </Button>
      </header>
      <OfferTermsReading offer={offer} label={labels.get(subjectOfferKey(offer))} locale={locale} />
      <footer className="space-y-3 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 whitespace-normal text-start"
          onClick={() => reading.returnToRow(offer)}
        >
          {m.subject_choice_return({}, { locale })}
        </Button>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_review_meaning({}, { locale })}
        </p>
        <OfferReviewLink offer={offer} href={destination(offer)} locale={locale} current={reading.current} />
      </footer>
    </article>
  );
}

export function SubjectOfferComparison({
  reading,
  locale,
  labels,
  destination,
}: {
  reading: SubjectOfferReading;
  locale: Locale;
  labels: ReadonlyMap<string, CaptureLabel>;
  destination: OfferDestination;
}) {
  const [first, second] = reading.operands;
  if (reading.mode?.kind !== 'compare' || !first || !second || !reading.current()) return null;
  return (
    <section
      id={reading.id}
      aria-labelledby={`${reading.id}-heading`}
      data-offer-comparison=""
      className="min-w-0 space-y-6 rounded-xl border bg-card p-4 text-card-foreground sm:p-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          reading.close();
        }
      }}
    >
      <header className="min-w-0 space-y-4">
        <h2
          id={`${reading.id}-heading`}
          ref={reading.heading}
          tabIndex={-1}
          className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {m.subject_choice_compare_heading({}, { locale })}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed">{m.subject_choice_compare_intro({}, { locale })}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={reading.close}>
            {m.subject_choice_edit({}, { locale })}
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={reading.clear}>
            {m.subject_choice_clear({}, { locale })}
          </Button>
        </div>
      </header>
      <SuppliedDifferences first={first.offer} second={second.offer} locale={locale} />
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.subject_choice_column_order({}, { locale })}
      </p>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
        <ComparisonOperand
          offer={first.offer}
          position={1}
          locale={locale}
          labels={labels}
          reading={reading}
          destination={destination}
        />
        <ComparisonOperand
          offer={second.offer}
          position={2}
          locale={locale}
          labels={labels}
          reading={reading}
          destination={destination}
        />
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.subject_choice_current_page({}, { locale })}
      </p>
    </section>
  );
}
