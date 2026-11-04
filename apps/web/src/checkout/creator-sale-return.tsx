import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';

type Props = {
  close: () => void;
  returned?: boolean | undefined;
  locale: string;
  cursor?: string | undefined;
  orderId: string;
};

/** The return address carries a native cursor only; the exact sale stays in the current reader. */
export function CreatorSaleReturn({ close, returned, locale, cursor, orderId }: Props) {
  const address = `/${locale}/creator/sales${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
  return (
    <div className="min-w-0 space-y-3 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        {returned ? m.creator_review_returned_hint() : m.creator_review_departure_hint()}
      </p>
      <details className="min-w-0 rounded-lg border p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">
          {m.creator_review_return_context()}
        </summary>
        <div className="min-w-0 space-y-4 pt-3">
          <dl className="min-w-0 space-y-3 text-sm">
            <div className="min-w-0 space-y-1">
              <dt className="text-muted-foreground">{m.creator_review_return_address()}</dt>
              <dd className="min-w-0 select-text font-mono [overflow-wrap:anywhere]">{address}</dd>
            </div>
            <div className="min-w-0 space-y-1">
              <dt className="text-muted-foreground">{m.creator_review_return_locale()}</dt>
              <dd>{locale}</dd>
            </div>
            <div className="min-w-0 space-y-1">
              <dt className="text-muted-foreground">{m.creator_review_return_page()}</dt>
              <dd>{cursor ? m.creator_review_return_continuation() : m.creator_review_return_first_page()}</dd>
            </div>
            <div className="min-w-0 space-y-1">
              <dt className="text-muted-foreground">{m.creator_sales_reference()}</dt>
              <dd className="min-w-0 select-text font-mono [overflow-wrap:anywhere]">{orderId}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{m.creator_review_return_private()}</p>
          <p className="text-sm text-muted-foreground">{m.creator_review_return_fresh()}</p>
        </div>
      </details>
      <Button className="min-h-11 whitespace-normal" variant="outline" onClick={close}>
        {m.creator_sale_close()}
      </Button>
    </div>
  );
}
