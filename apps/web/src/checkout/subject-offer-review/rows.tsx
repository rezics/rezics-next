import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { capturedBenefit } from '../benefit';
import { formatMinorAmount } from '../money';
import type { SubjectOffer } from '../subject-offers';
import { subjectOfferKey, type CaptureLabel } from './model';
import type { SubjectOfferReading } from './reading';
import { OfferCaptureLabel, OfferObservedRevision } from './terms';

export type OfferDestination = (offer: SubjectOffer) => string;

export function SubjectOfferRows({
  offers,
  locale,
  labels,
  reading,
  destination,
}: {
  offers: readonly SubjectOffer[];
  locale: Locale;
  labels: ReadonlyMap<string, CaptureLabel>;
  reading: SubjectOfferReading;
  destination: OfferDestination;
}) {
  return (
    <ul className="flex min-w-0 flex-col gap-3" aria-label={m.subject_choice_rows({}, { locale })}>
      {offers.map((offer) => {
        const benefit = capturedBenefit(offer.contentEdition, offer.targetSubjectId);
        const price = formatMinorAmount(locale, offer.currency, offer.unitAmountMinor, offer.moneyUnit);
        const chosen = reading.chosen(offer);
        const full = reading.operands.length === 2 && !chosen;
        return (
          <ContentItem
            key={subjectOfferKey(offer)}
            title={offer.title}
            headingLevel={3}
            href={destination(offer)}
            primaryLinkLabel={m.subject_purchase_review_offer({ title: offer.title }, { locale })}
            onClick={(event) => {
              if (!reading.current()) event.preventDefault();
            }}
            className="p-3 [&_h3]:break-words [&_h3]:[overflow-wrap:anywhere]"
            metadata={
              <div className="min-w-0 space-y-2">
                <p className="text-sm tabular-nums">
                  {price ?? m.subject_purchase_price_unknown({}, { locale })}
                  {price && offer.taxBehavior === 'exclusive' ? ` · ${m.commerce_before_tax({}, { locale })}` : ''}
                </p>
                <OfferObservedRevision offer={offer} locale={locale} />
                <OfferCaptureLabel label={labels.get(subjectOfferKey(offer))} locale={locale} />
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
              </div>
            }
            preview={
              <span className="text-sm underline underline-offset-4">{m.subject_purchase_review({}, { locale })}</span>
            }
            state={
              <p className="text-sm font-medium">
                {chosen ? m.subject_choice_selected({}, { locale }) : m.subject_choice_supplied({}, { locale })}
              </p>
            }
            actions={
              <div className="flex min-w-0 max-w-md flex-col gap-2">
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
                  className="h-auto min-h-11 max-w-full whitespace-normal text-start"
                  aria-label={m.subject_choice_toggle_label(
                    { title: offer.title, id: offer.id, revision: offer.revision },
                    { locale },
                  )}
                  aria-pressed={chosen}
                  disabled={full}
                  onClick={(event) => reading.toggle(offer, event.currentTarget)}
                >
                  {chosen ? m.subject_choice_remove({}, { locale }) : m.subject_choice_add({}, { locale })}
                </Button>
                {full && (
                  <p className="max-w-prose text-sm text-muted-foreground">{m.subject_choice_full({}, { locale })}</p>
                )}
                <details className="min-w-0">
                  <summary className="min-h-11 cursor-pointer content-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    {m.commerce_full_title({}, { locale })}
                  </summary>
                  <p className="break-words py-2 text-sm [overflow-wrap:anywhere]">{offer.title}</p>
                </details>
              </div>
            }
          />
        );
      })}
    </ul>
  );
}
