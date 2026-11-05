import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { OfferReadingContents } from './contents';
import { subjectOfferKey, type CaptureLabel } from './model';
import type { SubjectOfferReading } from './reading';
import type { OfferDestination } from './rows';
import { OfferObservedRevision, OfferReviewLink, OfferTermsReading } from './terms';

export function SubjectOfferInspection({
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
  const mode = reading.mode;
  if (mode?.kind !== 'inspect' || !reading.current()) return null;
  const { offer, trigger } = mode.operand;
  const chosen = reading.chosen(offer);
  const full = reading.operands.length === 2 && !chosen;
  return (
    <section
      id={reading.id}
      data-offer-inspection=""
      aria-labelledby={`${reading.id}-heading`}
      className="min-w-0 space-y-6 rounded-xl border bg-card p-4 text-card-foreground [overflow-wrap:anywhere] sm:p-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          reading.close();
        }
      }}
    >
      <header className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-sm font-medium text-muted-foreground">
            {m.subject_choice_inspect_heading({}, { locale })}
          </p>
          <Button type="button" variant="outline" className="min-h-11" onClick={reading.close}>
            {m.subject_choice_close({}, { locale })}
          </Button>
        </div>
        <h2
          id={`${reading.id}-heading`}
          ref={reading.heading}
          tabIndex={-1}
          className="whitespace-pre-wrap break-words text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {offer.title}
        </h2>
        <OfferObservedRevision offer={offer} locale={locale} />
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_seller_title({}, { locale })}
        </p>
        <p className="max-w-prose text-sm leading-relaxed">{m.subject_choice_observation({}, { locale })}</p>
      </header>
      <OfferReadingContents reading={reading} locale={locale} />
      <OfferTermsReading offer={offer} label={labels.get(subjectOfferKey(offer))} locale={locale} id={reading.id} />
      <section aria-label={m.subject_choice_next_heading({}, { locale })} className="min-w-0 space-y-4 border-t pt-5">
        <h3
          id={`${reading.id}-next`}
          tabIndex={-1}
          className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {m.subject_choice_next_heading({}, { locale })}
        </h3>
        <p className="max-w-prose text-sm leading-relaxed">{m.subject_choice_next_meaning({}, { locale })}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal text-start"
            aria-pressed={chosen}
            disabled={full}
            onClick={() => reading.toggle(offer, trigger)}
          >
            {chosen ? m.subject_choice_remove({}, { locale }) : m.subject_choice_add({}, { locale })}
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={reading.close}>
            {m.subject_choice_return({}, { locale })}
          </Button>
          <OfferReviewLink offer={offer} href={destination(offer)} locale={locale} current={reading.current} />
        </div>
        {full && <p className="max-w-prose text-sm text-muted-foreground">{m.subject_choice_full({}, { locale })}</p>}
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.subject_choice_review_meaning({}, { locale })}
        </p>
      </section>
    </section>
  );
}
