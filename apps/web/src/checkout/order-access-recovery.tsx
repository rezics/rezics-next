import { useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { readOrder, type OrderPageData } from './order';
import { sameCapturedBenefit } from './benefit';
import type { BuyerCurrentOrigin } from './buyer-current-origin';

type Props = {
  order: OrderPageData;
  locale: string;
  origin: BuyerCurrentOrigin;
  benefitOrigin: BuyerCurrentOrigin | null;
  enabled: boolean;
  setOrder: Dispatch<SetStateAction<OrderPageData>>;
};

function sameReceiptRead(fresh: OrderPageData, order: OrderPageData): boolean {
  return (
    fresh.id === order.id &&
    fresh.offerId === order.offerId &&
    fresh.settlement === 'paid' &&
    fresh.entitlementId === order.entitlementId &&
    order.entitlementId !== null &&
    order.benefit?.kind === 'mapped' &&
    sameCapturedBenefit(fresh.benefit, order.benefit) &&
    fresh.entitlement.kind === 'current'
  );
}

export function OrderAccessRecovery({ order, locale, origin, benefitOrigin, enabled, setOrder }: Props) {
  const [phase, setPhase] = useState<'ready' | 'pending' | 'failed'>('ready');
  const current = () => origin.isCurrent() && benefitOrigin?.isCurrent() === true;

  if (order.settlement !== 'paid' || order.entitlement.kind !== 'unavailable') return null;

  async function retry() {
    if (!enabled || !current() || phase === 'pending') return;
    setPhase('pending');
    try {
      const fresh = await readOrder({ data: { id: order.id, locale } });
      if (!current()) return;
      if (!sameReceiptRead(fresh, order)) {
        setPhase('failed');
        return;
      }
      setOrder((latest) => {
        if (
          !current() ||
          latest.settlement !== 'paid' ||
          latest.entitlement.kind !== 'unavailable' ||
          latest.id !== order.id ||
          latest.offerId !== order.offerId ||
          latest.entitlementId !== order.entitlementId ||
          !sameCapturedBenefit(latest.benefit, order.benefit!)
        )
          return latest;
        return {
          ...latest,
          entitlement: fresh.entitlement,
          canUseBenefit:
            fresh.entitlement.kind === 'current' &&
            fresh.entitlement.active &&
            fresh.canUseBenefit === true &&
            sameCapturedBenefit(fresh.benefit, latest.benefit!),
        };
      });
      setPhase(fresh.entitlement.kind === 'unavailable' ? 'failed' : 'ready');
    } catch {
      if (current()) setPhase('failed');
    }
  }

  return (
    <section className="space-y-2" aria-label={m.order_access_recovery_action()}>
      <Button
        variant="outline"
        size="lg"
        className="w-full sm:w-auto"
        disabled={!enabled || !current() || phase === 'pending'}
        onClick={() => void retry()}
      >
        {m.order_access_recovery_action()}
      </Button>
      {phase === 'pending' ? <p role="status">{m.order_access_recovery_pending()}</p> : null}
      {phase === 'failed' ? <p role="status">{m.order_access_recovery_failed()}</p> : null}
    </section>
  );
}
