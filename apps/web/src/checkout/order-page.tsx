import { Exposure } from '../kernel/exposure';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useState } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { OrderPageData, Settlement } from './order';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';

const recheckMs = 2_000;
// The first read is the page loader. Fifteen further reads reach the 16-read cap at 30 seconds.
const recheckLimit = 15;
const openSettlement = new Set<Settlement>(['pending', 'unknown']);

function normalize(value: string): Settlement {
  if (value === 'paid' || value === 'pending' || value === 'failed' || value === 'unknown') return value;
  return 'unknown';
}

export function OrderPage({ order: initial, checkout }: { order: OrderPageData; checkout?: 'canceled' | 'success' }) {
  const [order, setOrder] = useState(initial);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!openSettlement.has(order.settlement)) return;
    let polls = 0;
    let stopped = false;
    const timer = setInterval(() => {
      if (polls >= recheckLimit) {
        clearInterval(timer);
        if (!stopped) setGaveUp(true);
        return;
      }
      polls += 1;
      const attempt = polls;
      void fetch(`/orders/${order.id}/status`, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          if (!response.ok || stopped) return null;
          return (await response.json()) as { settlement?: unknown; offerId?: unknown };
        })
        .then((body) => {
          if (!body || stopped || typeof body.settlement !== 'string' || typeof body.offerId !== 'string') return;
          const settlement = normalize(body.settlement);
          setOrder((current) =>
            current.settlement === settlement && current.offerId === body.offerId
              ? current
              : { ...current, settlement, offerId: body.offerId as string },
          );
          if (!openSettlement.has(settlement) || attempt >= recheckLimit) {
            clearInterval(timer);
            if (openSettlement.has(settlement)) setGaveUp(true);
          }
        })
        .catch(() => {});
    }, recheckMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [order.id, order.settlement]);

  const pending = openSettlement.has(order.settlement);
  const canceled = checkout === 'canceled' && order.settlement !== 'paid';
  const confirming = pending && !canceled;
  const locale = getLocale();
  const heading =
    order.settlement === 'paid'
      ? m.order_paid()
      : canceled
        ? m.order_canceled()
        : gaveUp && pending
          ? m.order_still_processing()
          : pending
            ? m.order_pending()
            : m.order_failed();

  return (
    <article className="max-w-3xl min-w-0 space-y-8 text-foreground">
      <PageHeading className="text-foreground">{heading}</PageHeading>
      {order.settlement === 'paid' ? (
        <section
          aria-labelledby="receipt-heading"
          className="space-y-5 rounded-xl border border-border bg-card p-5 text-card-foreground sm:p-6"
        >
          <h2 id="receipt-heading" className="text-xl font-semibold">
            {m.order_receipt()}
          </h2>
          <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
            <SubjectCover data={order.subject} size="sm" priority />
            <div className="min-w-0 space-y-4">
              <p className="break-words text-lg font-medium">{order.subject.subject.title}</p>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{m.order_reference()}</dt>
                <dd className="break-all font-mono">{order.id}</dd>
                <dt className="text-muted-foreground">{m.order_ordered_at()}</dt>
                <dd>
                  <time>
                    {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(
                      new Date(order.createdAt),
                    )}
                  </time>
                </dd>
              </dl>
            </div>
          </div>
        </section>
      ) : (
        <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start sm:gap-4">
          <SubjectCover data={order.subject} size="sm" priority />
          <p className="min-w-0 break-words pt-1 font-serif text-xl text-foreground">{order.subject.subject.title}</p>
        </div>
      )}
      {confirming && (
        <Alert role="status">
          <AlertDescription className="text-foreground">{m.order_confirming()}</AlertDescription>
        </Alert>
      )}
      {order.settlement === 'failed' && !checkout && (
        <Alert role="status">
          <AlertDescription className="space-y-3 text-foreground">
            <p>{m.order_failed_detail()}</p>
            <a
              href={`/${locale}/offers/${order.offerId}`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_back()}
            </a>
          </AlertDescription>
        </Alert>
      )}
      {order.settlement === 'paid' && (
        <section aria-labelledby="next-step-heading" className="space-y-3">
          <h2 id="next-step-heading" className="text-xl font-semibold">
            {m.order_next_step()}
          </h2>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <a
              href={`/${locale}/library`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_open_library()}
            </a>
            <a
              href={`/${locale}/offers/${order.offerId}`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_back()}
            </a>
          </div>
        </section>
      )}
      {checkout === 'canceled' && (
        <Alert role="status">
          <AlertDescription className="space-y-3 text-foreground">
            <a
              href={`/${locale}/offers/${order.offerId}`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_back()}
            </a>
          </AlertDescription>
        </Alert>
      )}
      {gaveUp && pending && (
        <Exposure operation="order.get">
          <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => window.location.reload()}>
            {m.order_refresh()}
          </Button>
        </Exposure>
      )}
    </article>
  );
}
