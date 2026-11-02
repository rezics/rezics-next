import type { Order, RecordedOrderCharge, RecordedOrderPresentment } from './model.ts';
import { recordedMoneyUnit } from './money.ts';

/** Each input is the retained interpretation of one exact order/Session/context key. */
function evidence(serialized: string | null) {
  if (serialized === null) return null;
  const value = JSON.parse(serialized) as {
    moneyUnit?: unknown;
    amounts?: Record<string, unknown>;
  } | null;
  if (!value || typeof value.amounts !== 'object' || value.amounts === null) return null;
  const moneyUnit = recordedMoneyUnit(value.moneyUnit);
  return moneyUnit ? { moneyUnit, amounts: value.amounts } : null;
}

function positiveAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** No provider calls, current currency facts, offer reads or FX/tax inference. */
export function orderReceiptMoney(order: Order, integration: string | null, presentment: string | null) {
  let recordedCharge: RecordedOrderCharge | null = null;
  let recordedPresentment: RecordedOrderPresentment | null = null;
  if (order.settlement !== 'paid') return { recordedCharge, recordedPresentment };
  const charge = evidence(integration);
  if (charge) {
    const { amounts, moneyUnit } = charge;
    const total = amounts.amount_total;
    const tax = amounts['total_details.amount_tax'];
    if (
      amounts.currency === order.currency &&
      amounts.amount_subtotal === order.unitAmountMinor &&
      positiveAmount(total) &&
      (tax === null || (typeof tax === 'number' && Number.isSafeInteger(tax) && tax >= 0)) &&
      (order.amountTaxMinor == null || order.amountTaxMinor === tax)
    ) {
      recordedCharge = {
        currency: order.currency,
        moneyUnit,
        amountTotalMinor: total,
        amountTaxMinor: tax,
      };
    }
  }
  const local = evidence(presentment);
  if (local) {
    const currency = local.amounts.presentment_currency;
    const total = local.amounts.presentment_amount;
    if (typeof currency === 'string' && /^[a-z]{3}$/.test(currency) && positiveAmount(total)) {
      recordedPresentment = {
        currency,
        moneyUnit: local.moneyUnit,
        amountTotalMinor: total,
      };
    }
  }
  return { recordedCharge, recordedPresentment };
}
