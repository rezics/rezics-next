import { useMemo } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { localizeHref, type Locale } from '../../paraglide/runtime.js';
import { CapturedOfferReferences } from '../creator-offer-review/captured-terms';
import { formatMinorAmount } from '../money';
import type { SubjectOffersPage } from '../subject-offers';
import { SubjectOfferComparison } from './comparison';
import { SubjectOfferInspection } from './inspection';
import { capturedPageLabels, readableSubjectOffer, subjectOfferKey, type CaptureLabel } from './model';
import { useSubjectOfferReading, type SubjectOfferReading } from './reading';
import { SubjectOfferRows } from './rows';
import { OfferCaptureLabel, OfferObservedRevision } from './terms';

/** Selection order is the reader's deliberate order, independent from the unchanged native row order. */
function SelectionSummary({
  reading,
  locale,
  labels,
}: {
  reading: SubjectOfferReading;
  locale: Locale;
  labels: ReadonlyMap<string, CaptureLabel>;
}) {
  if (reading.operands.length === 0) return null;
  return (
    <ol className="grid min-w-0 gap-3 sm:grid-cols-2" aria-label={m.subject_choice_selected_list({}, { locale })}>
      {reading.operands.map(({ offer }, index) => (
        <li key={subjectOfferKey(offer)} className="min-w-0 space-y-3 rounded-lg border p-3 [overflow-wrap:anywhere]">
          <p className="text-sm font-medium text-muted-foreground">
            {m.subject_choice_operand({ position: index + 1 }, { locale })}
          </p>
          <p className="whitespace-pre-wrap break-words font-medium">{offer.title}</p>
          <OfferObservedRevision offer={offer} locale={locale} />
          <OfferCaptureLabel label={labels.get(subjectOfferKey(offer))} locale={locale} />
          <p className="text-sm tabular-nums">
            {formatMinorAmount(locale, offer.currency, offer.unitAmountMinor, offer.moneyUnit) ??
              m.subject_purchase_price_unknown({}, { locale })}
            {offer.taxBehavior === 'exclusive' ? ` · ${m.commerce_before_tax({}, { locale })}` : ''}
          </p>
          <CapturedOfferReferences offer={readableSubjectOffer(offer)} locale={locale} />
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 max-w-full whitespace-normal text-start"
            aria-label={m.subject_choice_inspect_label(
              { title: offer.title, id: offer.id, revision: offer.revision },
              { locale },
            )}
            aria-expanded={reading.inspected(offer)}
            aria-controls={reading.inspected(offer) ? reading.id : undefined}
            onClick={(event) => reading.inspect(offer, event.currentTarget)}
          >
            {m.subject_choice_inspect({}, { locale })}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal text-start"
            aria-label={m.subject_choice_remove_label({ position: index + 1, title: offer.title }, { locale })}
            onClick={() => reading.remove(offer)}
          >
            {m.subject_choice_remove({}, { locale })}
          </Button>
        </li>
      ))}
    </ol>
  );
}

function ChoiceControls({
  reading,
  locale,
  labels,
}: {
  reading: SubjectOfferReading;
  locale: Locale;
  labels: ReadonlyMap<string, CaptureLabel>;
}) {
  const count = reading.operands.length;
  return (
    <section
      aria-label={m.subject_choice_selection_heading({}, { locale })}
      className="min-w-0 space-y-4 rounded-lg border p-4"
    >
      <h3 className="font-semibold">{m.subject_choice_selection_heading({}, { locale })}</h3>
      <p role="status" aria-live="polite" aria-atomic="true" className="text-sm">
        {count === 0
          ? m.subject_choice_selection_none({}, { locale })
          : count === 1
            ? m.subject_choice_selection_one({}, { locale })
            : m.subject_choice_selection_two({}, { locale })}
      </p>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.subject_choice_selection_meaning({}, { locale })}
      </p>
      <SelectionSummary reading={reading} locale={locale} labels={labels} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 whitespace-normal text-start"
          disabled={count !== 2}
          aria-expanded={reading.mode?.kind === 'compare'}
          aria-controls={reading.mode?.kind === 'compare' ? reading.id : undefined}
          onClick={(event) => reading.compare(event.currentTarget)}
        >
          {m.subject_choice_compare({}, { locale })}
        </Button>
        {count > 0 && (
          <Button type="button" variant="outline" className="min-h-11" onClick={reading.clear}>
            {m.subject_choice_clear({}, { locale })}
          </Button>
        )}
      </div>
      {count > 0 && (
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_edit_meaning({}, { locale })}
        </p>
      )}
    </section>
  );
}

/** Mounted only for an actual positive page. Every control below consumes its rows without another read. */
export function SubjectOfferChoice({
  page,
  locale,
  version = 0,
  current,
  origin,
}: {
  page: SubjectOffersPage;
  locale: Locale;
  version?: number | undefined;
  current?: (() => boolean) | undefined;
  origin?: object | undefined;
}) {
  const reading = useSubjectOfferReading({ page, locale, version, current, origin });
  const labels = useMemo(() => capturedPageLabels(page.offers), [page]);
  const destination = (offer: SubjectOffersPage['offers'][number]) =>
    localizeHref(`/offers/${encodeURIComponent(offer.id)}`, { locale });
  return (
    <div className="min-w-0 space-y-5" data-subject-offer-choice="">
      <div className="min-w-0 space-y-2">
        <p className="max-w-prose text-sm leading-relaxed">{m.subject_choice_intro({}, { locale })}</p>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_capture_labels_meaning({}, { locale })}
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_no_access({}, { locale })}
        </p>
      </div>
      <SubjectOfferRows
        offers={page.offers}
        locale={locale}
        labels={labels}
        reading={reading}
        destination={destination}
      />
      <ChoiceControls reading={reading} locale={locale} labels={labels} />
      <SubjectOfferInspection reading={reading} locale={locale} labels={labels} destination={destination} />
      <SubjectOfferComparison reading={reading} locale={locale} labels={labels} destination={destination} />
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {m.subject_choice_current_page({}, { locale })}
      </p>
    </div>
  );
}
