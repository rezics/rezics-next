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
  const heading =
    order.settlement === 'paid'
      ? m.order_paid()
      : gaveUp && pending
        ? m.order_still_processing()
        : pending
          ? m.order_pending()
          : m.order_failed();

  return (
    <article className="max-w-xl min-w-0 space-y-6 text-foreground">
      <PageHeading className="text-foreground">{heading}</PageHeading>
      <div className="flex min-w-0 items-start gap-4">
        <SubjectCover data={order.subject} size="sm" priority />
        <p className="min-w-0 pt-1 font-serif text-xl text-foreground">{order.title}</p>
      </div>
      {checkout === 'canceled' && (
        <Alert role="status">
          <AlertDescription className="space-y-3 text-foreground">
            <p role="note">{m.order_canceled()}</p>
            <Exposure operation="offer.get">
              <a
                href={`/${getLocale()}/offers/${order.offerId}`}
                className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
              >
                {m.order_back()}
              </a>
            </Exposure>
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
