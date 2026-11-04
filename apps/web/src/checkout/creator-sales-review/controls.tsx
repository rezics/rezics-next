import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { creatorSaleSettlementLabel } from '../creator-sale-inspection';
import {
  CREATOR_SALE_SEARCH_LIMIT,
  reviewIsFiltered,
  settlementStates,
  type ReceivedPageReview,
  type ReviewCriteria,
} from './model';

const fieldClass = 'min-h-11 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm';

type Props = {
  review: ReceivedPageReview;
  criteria: ReviewCriteria;
  visible: number;
  change: (criteria: ReviewCriteria) => void;
  reset: () => void;
  current: boolean;
};

/** Native form controls keep phone and keyboard reading within the existing page. */
export function CreatorSalesReviewControls({ review, criteria, visible, change, reset, current }: Props) {
  const filtered = reviewIsFiltered(criteria);
  return (
    <section aria-labelledby="creator-sales-review-heading" className="min-w-0 space-y-4 rounded-xl border p-4 sm:p-5">
      <div className="space-y-2">
        <h2 id="creator-sales-review-heading" tabIndex={-1} className="text-lg font-semibold">
          {m.creator_review_heading()}
        </h2>
        <p id="creator-sales-review-scope" className="max-w-prose text-sm text-muted-foreground">
          {m.creator_review_scope()}
        </p>
      </div>
      <fieldset disabled={!current} aria-describedby="creator-sales-review-scope" className="min-w-0 space-y-4">
        <legend className="sr-only">{m.creator_review_filters()}</legend>
        <div className="space-y-2">
          <label htmlFor="creator-sales-review-text" className="block text-sm font-medium">
            {m.creator_review_search()}
          </label>
          <input
            id="creator-sales-review-text"
            type="search"
            autoComplete="off"
            maxLength={CREATOR_SALE_SEARCH_LIMIT}
            value={criteria.text}
            onChange={(event) => change({ ...criteria, text: event.currentTarget.value })}
            className={fieldClass}
            aria-describedby="creator-sales-review-search-hint"
          />
          <p id="creator-sales-review-search-hint" className="text-sm text-muted-foreground">
            {m.creator_review_search_hint()}
          </p>
        </div>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <label htmlFor="creator-sales-review-work" className="block text-sm font-medium">
              {m.creator_sale_work_reference()}
            </label>
            <select
              id="creator-sales-review-work"
              value={criteria.work}
              onChange={(event) => change({ ...criteria, work: event.currentTarget.value })}
              className={fieldClass}
            >
              <option value="">{m.creator_review_all_works()}</option>
              {review.works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.id} ({work.count})
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 space-y-2">
            <label htmlFor="creator-sales-review-offer" className="block text-sm font-medium">
              {m.creator_sale_offer_reference()}
            </label>
            <select
              id="creator-sales-review-offer"
              value={criteria.offer}
              onChange={(event) => change({ ...criteria, offer: event.currentTarget.value })}
              className={fieldClass}
              aria-describedby="creator-sales-review-offer-hint"
            >
              <option value="">{m.creator_review_all_offers()}</option>
              {review.offers.map((offer) => (
                <option key={offer.id} value={offer.id}>
                  {offer.id} ({offer.count})
                </option>
              ))}
            </select>
            <p id="creator-sales-review-offer-hint" className="text-sm text-muted-foreground">
              {m.creator_review_offer_hint()}
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <label htmlFor="creator-sales-review-settlement" className="block text-sm font-medium">
            {m.creator_sale_settlement()}
          </label>
          <select
            id="creator-sales-review-settlement"
            value={criteria.settlement}
            onChange={(event) => {
              const value = event.currentTarget.value;
              const settlement = value === 'all' ? 'all' : settlementStates.find((state) => state === value);
              if (settlement) change({ ...criteria, settlement });
            }}
            className={fieldClass}
          >
            <option value="all">{m.creator_review_all_settlements()}</option>
            {settlementStates.map((state) => (
              <option key={state} value={state}>
                {creatorSaleSettlementLabel(state)} ({review.settlements[state]})
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          className="min-h-11 whitespace-normal"
          disabled={!filtered || !current}
          onClick={reset}
        >
          {m.creator_review_reset()}
        </Button>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm">
          {m.creator_review_count({ visible, received: review.sales.length })}
        </p>
      </div>
      {filtered && (
        <div className="min-w-0 space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium">{m.creator_review_active_filters()}</h3>
          <dl className="min-w-0 space-y-3 text-sm">
            {criteria.text.trim() && (
              <div className="min-w-0 space-y-1">
                <dt className="text-muted-foreground">{m.creator_review_search()}</dt>
                <dd className="select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{criteria.text}</dd>
              </div>
            )}
            {criteria.work && (
              <div className="min-w-0 space-y-1">
                <dt className="text-muted-foreground">{m.creator_sale_work_reference()}</dt>
                <dd className="select-text font-mono [overflow-wrap:anywhere]">{criteria.work}</dd>
              </div>
            )}
            {criteria.offer && (
              <div className="min-w-0 space-y-1">
                <dt className="text-muted-foreground">{m.creator_sale_offer_reference()}</dt>
                <dd className="select-text font-mono [overflow-wrap:anywhere]">{criteria.offer}</dd>
              </div>
            )}
            {criteria.settlement !== 'all' && (
              <div className="space-y-1">
                <dt className="text-muted-foreground">{m.creator_sale_settlement()}</dt>
                <dd>{creatorSaleSettlementLabel(criteria.settlement)}</dd>
              </div>
            )}
          </dl>
          <p className="text-sm text-muted-foreground">{m.creator_review_filters_together()}</p>
        </div>
      )}
      <p className="text-sm text-muted-foreground">{m.creator_review_count_hint()}</p>
    </section>
  );
}

export function CreatorSalesPageObservations({ review }: { review: ReceivedPageReview }) {
  return (
    <details className="min-w-0 rounded-xl border p-4 sm:p-5">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.creator_review_observations()}</summary>
      <div className="min-w-0 space-y-5 pt-4">
        <p className="max-w-prose text-sm text-muted-foreground">{m.creator_review_observations_hint()}</p>
        <section className="space-y-3" aria-labelledby="creator-review-status-counts">
          <h3 id="creator-review-status-counts" className="font-medium">
            {m.creator_sale_settlement()}
          </h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            {settlementStates.map((state) => (
              <div key={state}>
                <dt className="text-sm text-muted-foreground">{creatorSaleSettlementLabel(state)}</dt>
                <dd>{m.creator_review_records({ count: review.settlements[state] })}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="space-y-3 border-t pt-4" aria-labelledby="creator-review-currencies">
          <h3 id="creator-review-currencies" className="font-medium">
            {m.creator_review_currencies()}
          </h3>
          <ul className="space-y-4">
            {review.currencies.map((currency) => (
              <li key={currency.currency} className="space-y-2">
                <p className="font-medium">
                  {currency.currency} · {m.creator_review_records({ count: currency.count })}
                </p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {currency.units.map((unit) => (
                    <li key={`${unit.system}:${unit.exponent}:${unit.factsVersion}`}>
                      {m.creator_review_unit_observation({ count: unit.count, digits: unit.exponent })}
                      <span className="block font-mono [overflow-wrap:anywhere]">
                        {unit.system} · {unit.factsVersion}
                      </span>
                    </li>
                  ))}
                  {currency.unknownUnits > 0 && (
                    <li>{m.creator_review_unknown_units({ count: currency.unknownUnits })}</li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{m.creator_review_currency_hint()}</p>
        </section>
        <section className="space-y-3 border-t pt-4" aria-labelledby="creator-review-offer-observations">
          <h3 id="creator-review-offer-observations" className="font-medium">
            {m.creator_review_offer_observations()}
          </h3>
          <ul className="space-y-4">
            {review.offers.map((offer) => (
              <li key={offer.id} className="space-y-1">
                <p className="font-mono text-sm [overflow-wrap:anywhere]">{offer.id}</p>
                <p className="text-sm">{m.creator_review_records({ count: offer.count })}</p>
                <ul className="space-y-1">
                  {offer.titles.map((title) => (
                    <li key={title} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {title}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{m.creator_review_captured_titles()}</p>
        </section>
      </div>
    </details>
  );
}
