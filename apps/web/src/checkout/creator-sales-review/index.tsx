import { useMemo, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { CreatorSale } from '../creator-sales';
import type { CreatorSaleReading } from '../creator-sale-reading';
import { CreatorSalesReviewControls, CreatorSalesPageObservations } from './controls';
import { CreatorSalesComparison, CreatorSalesComparisonSelection } from './comparison';
import { CreatorSalesReviewRows } from './rows';
import { initialReviewCriteria, prepareReceivedPageReview, reviewReceivedSales } from './model';

type Props = {
  sales: readonly CreatorSale[];
  locale: string;
  reading: CreatorSaleReading;
};

/** The parent keys this workspace to the existing reader's supplied source lifetime. */
export function CreatorSalesReview({ sales, locale, reading }: Props) {
  const review = useMemo(() => prepareReceivedPageReview(sales), [sales]);
  const [criteria, setCriteria] = useState(initialReviewCriteria);
  const visible = useMemo(() => reviewReceivedSales(review, criteria), [review, criteria]);
  const visibleIds = useMemo(() => new Set(visible.map((sale) => sale.orderId)), [visible]);
  return (
    <div className="min-w-0 space-y-5">
      <CreatorSalesReviewControls
        review={review}
        criteria={criteria}
        visible={visible.length}
        change={(next) => {
          if (reading.sourceIsCurrent()) setCriteria(next);
        }}
        reset={() => {
          if (reading.sourceIsCurrent()) setCriteria(initialReviewCriteria);
        }}
      />
      <CreatorSalesComparisonSelection reading={reading} visibleIds={visibleIds} />
      {reading.comparisonOpen && <CreatorSalesComparison reading={reading} locale={locale} />}
      {visible.length === 0 ? (
        <div className="space-y-2 rounded-xl border p-5" role="status">
          <p className="font-medium">{m.creator_review_no_matches()}</p>
          <p className="text-sm text-muted-foreground">{m.creator_review_no_matches_hint()}</p>
        </div>
      ) : (
        <CreatorSalesReviewRows sales={visible} locale={locale} reading={reading} />
      )}
      {reading.selectedId && !visibleIds.has(reading.selectedId) && (
        <p className="text-sm text-muted-foreground">{m.creator_review_hidden_inspection()}</p>
      )}
      <CreatorSalesPageObservations review={review} />
    </div>
  );
}
