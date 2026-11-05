import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { loadOrderPage } from './order.server';
import { UUID } from './price';
import type { SubjectCoverData } from './subject-cover';
import type { CapturedBenefit } from './benefit';
import type { KernelClient } from '@rezics/client';

type NativeOrder = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['orders']>['get']>>['data']>['order'];
export type OrderMoney = Pick<
  NativeOrder,
  'currency' | 'unitAmountMinor' | 'taxCode' | 'amountTaxMinor' | 'moneyUnit' | 'taxBehavior' | 'recordedCharge'
> & {
  /** Absent on historical responses; never inferred from integration money. */
  recordedPresentment?: {
    currency: string;
    moneyUnit: NonNullable<NativeOrder['moneyUnit']>;
    amountTotalMinor: number;
  } | null;
};

export type Settlement = 'failed' | 'paid' | 'pending' | 'unknown';
export type CurrentEntitlement = { kind: 'current'; active: boolean } | { kind: 'none' | 'unavailable' | 'refresh' };
export type OrderPageData = {
  id: string;
  offerId: string;
  title: string;
  settlement: Settlement;
  entitlementId: string | null;
  entitlement: CurrentEntitlement;
  /** Creation time is present in the order read; it is not a payment-settlement time. */
  createdAt: string;
  subject: SubjectCoverData;
  benefit?: CapturedBenefit;
  /** Missing legacy display data remains unknown; the default BFF always supplies the native money fields. */
  money?: OrderMoney;
  /** Current associated native entitlement covers this exact captured benefit. Final use reauthorizes in Content. */
  canUseBenefit?: boolean;
  creatorName?: string | undefined;
  /** Exact current native viewer-action decision on the signed-in account. */
  canReconcile?: boolean;
};

function validateOrder(input: unknown): { id: string; locale: string } {
  if (
    !input ||
    typeof input !== 'object' ||
    !('id' in input) ||
    typeof input.id !== 'string' ||
    !UUID.test(input.id) ||
    !('locale' in input) ||
    typeof input.locale !== 'string' ||
    input.locale.length > 35
  )
    throw notFound();
  return { id: input.id, locale: input.locale };
}

export const readOrder = createServerFn({ method: 'GET' })
  .validator(validateOrder)
  .handler(({ data }) => loadOrderPage(data.id, data.locale));
