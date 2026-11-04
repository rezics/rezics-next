import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { CreatorOffer } from './creator-offers';
import type { CreatorOfferReading } from './creator-offer-reading';
import { CapturedOfferReferences, CapturedOfferTerms } from './creator-offer-review/captured-terms';
import { ChangedOfferReview } from './creator-offer-review/changed-offer';
import { sameOfferObservation } from './creator-offer-review/observation';
import { formatMinorAmount } from './money';
import { recordedMoneyUnit, recordedTaxBehavior } from './money-schema';

/** Local reading shortcuts move focus within this inspection without changing its address or draft. */
function InspectionContents({ reading }: { reading: CreatorOfferReading }) {
  function focus(part: string) {
    if (!reading.current()) return;
    const target = document.getElementById(`${reading.inspectionId}-${part}`);
    if (target?.isConnected) target.focus();
  }
  return (
    <nav aria-label={m.creator_inspect_contents()} className="flex flex-wrap gap-2 border-t pt-4">
      {reading.status?.kind !== 'same' && (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 whitespace-normal text-start"
          onClick={() => focus('changes')}
        >
          {m.creator_inspect_jump_changes()}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('price')}
      >
        {m.creator_inspect_jump_price()}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('terms')}
      >
        {m.creator_inspect_jump_terms()}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('references')}
      >
        {m.creator_inspect_jump_references()}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('management')}
      >
        {m.creator_inspect_jump_management()}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal text-start"
        onClick={() => focus('reading')}
      >
        {m.creator_inspect_jump_reading()}
      </Button>
    </nav>
  );
}

/** The inspection trigger and original management controls remain connected in the same keyed row. */
export function CreatorOfferInspectionTrigger({
  offer,
  reading,
}: {
  offer: CreatorOffer;
  reading: CreatorOfferReading;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-h-11 max-w-full whitespace-normal text-start"
      aria-label={m.creator_inspect_trigger_label({ title: offer.title, id: offer.id, revision: offer.revision })}
      aria-expanded={reading.selected(offer)}
      aria-controls={reading.inspectionId}
      onClick={(event) => reading.select(offer, event.currentTarget)}
    >
      {m.creator_inspect_open()}
    </Button>
  );
}

export function CreatorOfferInspection({
  reading,
  locale,
  restartHref,
  retained,
  managementAvailable,
  offerPageAvailable,
}: {
  reading: CreatorOfferReading;
  locale: string;
  restartHref: string;
  retained: CreatorOffer | undefined;
  managementAvailable: boolean;
  offerPageAvailable: boolean;
}) {
  const offer = reading.observed;
  const status = reading.status;
  if (!offer || !status || !reading.current()) return null;
  const originalCommand = retained && !sameOfferObservation(retained, offer) ? retained : null;
  // Public navigation is offered only for an unchanged active observation of this received page.
  const publicHref =
    offerPageAvailable && status.kind === 'same' && offer.state === 'active' ? `/${locale}/offers/${offer.id}` : null;
  const canManage = managementAvailable && (retained ?? offer).state === 'active';
  return (
    <section
      id={reading.inspectionId}
      aria-labelledby={`${reading.inspectionId}-heading`}
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
          <p className="text-sm font-medium text-muted-foreground">{m.creator_inspect_heading()}</p>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => reading.close()}>
            {m.creator_inspect_close()}
          </Button>
        </div>
        <h2
          id={`${reading.inspectionId}-heading`}
          ref={reading.heading}
          tabIndex={-1}
          className="break-words text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {offer.title}
        </h2>
        <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2 [&_dt]:font-medium [&_dd]:mt-1">
          <div className="min-w-0 sm:col-span-2">
            <dt>{m.creator_offers_offer_id()}</dt>
            <dd className="break-all">
              <code>{offer.id}</code>
            </dd>
          </div>
          <div>
            <dt>{m.creator_offers_offer_revision()}</dt>
            <dd className="tabular-nums">{offer.revision}</dd>
          </div>
          <div>
            <dt>{m.creator_inspect_status_label()}</dt>
            <dd>{offer.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted()}</dd>
          </div>
        </dl>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.creator_inspect_observation_meaning()}
        </p>
      </header>

      <InspectionContents reading={reading} />

      <ChangedOfferReview
        headingId={`${reading.inspectionId}-changes`}
        observed={offer}
        status={status}
        locale={locale}
        restartHref={restartHref}
        review={reading.reviewCurrent}
      />

      <section className="min-w-0 space-y-3 border-t pt-5" aria-label={m.creator_inspect_price_heading()}>
        <h3
          id={`${reading.inspectionId}-price`}
          tabIndex={-1}
          className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {m.creator_inspect_price_heading()}
        </h3>
        <p className="font-serif text-xl tabular-nums">
          {formatMinorAmount(locale, offer.currency, offer.unitAmountMinor, recordedMoneyUnit(offer)) ??
            m.creator_offers_amount_unavailable()}{' '}
          <span className="text-sm">{offer.currency.toUpperCase()}</span>
        </p>
        <p className="text-sm">
          {recordedTaxBehavior(offer) === 'exclusive' ? m.commerce_before_tax() : m.commerce_tax_unknown()}
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_price_meaning()}</p>
        {!recordedMoneyUnit(offer) && (
          <p className="max-w-prose text-sm leading-relaxed">{m.creator_inspect_unknown_money()}</p>
        )}
      </section>

      <div className="min-w-0 border-t pt-5">
        <CapturedOfferTerms offer={offer} headingId={`${reading.inspectionId}-terms`} />
      </div>
      <CapturedOfferReferences offer={offer} summaryId={`${reading.inspectionId}-references`} />

      <section className="min-w-0 space-y-4 border-t pt-5" aria-label={m.creator_inspect_return_heading()}>
        <h3
          id={`${reading.inspectionId}-management`}
          tabIndex={-1}
          className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {m.creator_inspect_return_heading()}
        </h3>
        {originalCommand ? (
          <div className="min-w-0 space-y-3 rounded-lg border p-4">
            <p className="font-medium">{m.creator_inspect_command_original()}</p>
            <p className="max-w-prose text-sm leading-relaxed">{m.creator_inspect_command_original_meaning()}</p>
            <dl className="min-w-0 space-y-2 text-sm [&_dt]:font-medium [&_dd]:mt-1">
              <div>
                <dt>{m.creator_inspect_title_label()}</dt>
                <dd className="break-words">{originalCommand.title}</dd>
              </div>
              <div>
                <dt>{m.creator_offers_offer_id()}</dt>
                <dd className="break-all">
                  <code>{originalCommand.id}</code>
                </dd>
              </div>
              <div>
                <dt>{m.creator_inspect_command_revision()}</dt>
                <dd>{originalCommand.revision}</dd>
              </div>
            </dl>
            <details className="min-w-0">
              <summary className="min-h-11 cursor-pointer content-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.creator_inspect_command_terms()}
              </summary>
              <div className="min-w-0 space-y-5 py-4">
                <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                  {m.creator_inspect_command_terms_notice()}
                </p>
                <dl className="space-y-3 text-sm [&_dt]:font-medium [&_dd]:mt-1">
                  <div>
                    <dt>{m.creator_inspect_status_label()}</dt>
                    <dd>
                      {originalCommand.state === 'active' ? m.creator_offers_active() : m.creator_offers_delisted()}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.creator_inspect_price_label()}</dt>
                    <dd>
                      {formatMinorAmount(
                        locale,
                        originalCommand.currency,
                        originalCommand.unitAmountMinor,
                        recordedMoneyUnit(originalCommand),
                      ) ?? m.creator_offers_amount_unavailable()}{' '}
                      {originalCommand.currency.toUpperCase()}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.creator_inspect_command_tax()}</dt>
                    <dd>
                      {recordedTaxBehavior(originalCommand) === 'exclusive'
                        ? m.commerce_before_tax()
                        : m.commerce_tax_unknown()}
                    </dd>
                  </div>
                </dl>
                <CapturedOfferTerms offer={originalCommand} />
                <CapturedOfferReferences offer={originalCommand} />
              </div>
            </details>
          </div>
        ) : (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {m.creator_inspect_management_meaning()}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {canManage && (
            <Button
              type="button"
              className="h-auto min-h-11 whitespace-normal text-start"
              onClick={reading.focusManagement}
            >
              {m.creator_inspect_go_management()}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 whitespace-normal text-start"
            onClick={() => reading.close()}
          >
            {m.creator_inspect_back_row()}
          </Button>
        </div>
        {offer.state === 'delisted' && (
          <p className="max-w-prose text-sm leading-relaxed">{m.creator_inspect_delisted_meaning()}</p>
        )}
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.creator_inspect_command_recovery()}
        </p>
      </section>

      <section className="min-w-0 space-y-3 border-t pt-5" aria-label={m.creator_inspect_reading_heading()}>
        <h3
          id={`${reading.inspectionId}-reading`}
          tabIndex={-1}
          className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {m.creator_inspect_reading_heading()}
        </h3>
        <p className="max-w-prose text-sm leading-relaxed">{m.creator_inspect_reading_meaning()}</p>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.creator_inspect_reader_distinction()}
        </p>
        {publicHref && (
          <a
            href={publicHref}
            className={buttonVariants({ variant: 'outline', className: 'h-auto min-h-11 whitespace-normal' })}
          >
            {m.creator_inspect_public_offer()}
          </a>
        )}
        {!publicHref && (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
            {offer.state === 'delisted'
              ? m.creator_inspect_public_delisted()
              : status.kind === 'missing'
                ? m.creator_inspect_public_missing()
                : status.kind === 'changed'
                  ? m.creator_inspect_public_changed()
                  : m.creator_inspect_public_withheld()}
          </p>
        )}
      </section>
    </section>
  );
}
