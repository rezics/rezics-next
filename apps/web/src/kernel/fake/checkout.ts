import type { FakeRoute } from '../fake-modules.ts';
import type { KernelRecording } from '../fake.ts';
import { fixedEditionTerms, mappedEntitlement } from './entitlements';
import pending from '../recorded/order-pending.json';
import type { AcquisitionProblem } from '../../checkout/offer-recovery';
import type { OrderMoney } from '../../checkout/order';

// Constructed receipt examples, not retroactive financial authority for the older recordings.
export const receiptStoryMoney: OrderMoney = {
  currency: 'usd',
  unitAmountMinor: 1200,
  taxCode: 'txcd_10302000',
  amountTaxMinor: 96,
  moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
  taxBehavior: 'exclusive',
  recordedCharge: {
    currency: 'usd',
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    amountTotalMinor: 1296,
    amountTaxMinor: 96,
  },
};
let receiptMoney = false;
export function setReceiptMoneyStory(enabled: boolean) {
  receiptMoney = enabled;
}

// Constructed current native 409 bodies, not recordings or an ownership lookup.
export const acquisitionProblems = {
  owned: {
    type: 'https://rezics.com/problems/benefit_already_owned',
    title: 'Benefit Already Owned',
    status: 409,
    code: 'benefit_already_owned',
    retryable: false,
    effect_status: 'not_applied',
    request_id: '0192f3a0-6c1e-7b2a-9d4e-000000000071',
    entitlementId: mappedEntitlement.id,
    orderId: mappedEntitlement.orderId,
  },
  pending: {
    type: 'https://rezics.com/problems/acquisition_pending',
    title: 'Acquisition Pending',
    status: 409,
    code: 'acquisition_pending',
    retryable: false,
    effect_status: 'not_applied',
    request_id: '0192f3a0-6c1e-7b2a-9d4e-000000000072',
    orderId: pending.order.id,
  },
} satisfies Record<string, AcquisitionProblem>;

let mapped = false;
export function setMappedCheckoutStory(enabled: boolean) {
  mapped = enabled;
}

const offerId = /^\/v1\/offers\/([^/]+)$/;
const orderId = /^\/v1\/orders\/([^/]+)$/;

function demoSubjectLabels(recordings: Record<string, KernelRecording>): Record<string, string> | undefined {
  const subject = recordings.subject?.subject;
  if (!subject || typeof subject !== 'object') return;
  const labels = (subject as Record<string, unknown>).labels;
  return labels && typeof labels === 'object' ? (labels as Record<string, string>) : undefined;
}

function localizedSubject(
  recording: Record<string, unknown>,
  locale: string,
  labels: Record<string, string> | undefined,
): Record<string, unknown> | undefined {
  const value = labels?.[locale] ?? labels?.en;
  if (typeof value !== 'string' || !recording.subject || typeof recording.subject !== 'object') return;
  return {
    ...recording,
    subject: { ...(recording.subject as Record<string, unknown>), label: { value, language: locale } },
  };
}

/** Story offers receive the same localized subject label as the subject read for this demo subject. */
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: offerId,
    story: ({ request, recordings, match }) => {
      if (!match) return;
      const id = decodeURIComponent(match[1]!);
      const recording = Object.values(recordings).find((candidate) => {
        const offer = candidate.offer;
        return !!offer && typeof offer === 'object' && (offer as Record<string, unknown>).id === id;
      });
      if (!recording?.offer || typeof recording.offer !== 'object') return;
      const offer = recording.offer as Record<string, unknown>;
      const labels = demoSubjectLabels(recordings);
      const locale = new URL(request.url).searchParams.get('languages') ?? 'en';
      const localized = localizedSubject(offer, locale, labels);
      if (!localized) return;
      return {
        ...recording,
        offer: mapped
          ? {
              ...localized,
              revision: 3,
              contentEdition: fixedEditionTerms,
              moneyUnit: {
                system: 'stripe-api',
                exponent: offer.currency === 'jpy' ? 0 : 2,
                factsVersion: 'stripe-money-v1',
              },
              taxBehavior: 'exclusive',
            }
          : localized,
      };
    },
  },
  {
    method: 'GET',
    path: orderId,
    story: ({ request, recordings, match }) => {
      if (!match) return;
      const id = decodeURIComponent(match[1]!);
      const recording = Object.values(recordings).find((candidate) => {
        const order = candidate.order;
        return !!order && typeof order === 'object' && (order as Record<string, unknown>).id === id;
      });
      if (!recording?.order || typeof recording.order !== 'object') return;
      const labels = demoSubjectLabels(recordings);
      const locale = new URL(request.url).searchParams.get('languages') ?? 'en';
      const localized = localizedSubject(recording.order as Record<string, unknown>, locale, labels);
      if (!localized) return;
      return {
        ...recording,
        order: {
          ...localized,
          ...(mapped ? { contentEdition: fixedEditionTerms } : {}),
          ...(receiptMoney
            ? {
                ...receiptStoryMoney,
                amountTaxMinor: localized.settlement === 'paid' ? receiptStoryMoney.amountTaxMinor : null,
                recordedCharge: localized.settlement === 'paid' ? receiptStoryMoney.recordedCharge : null,
              }
            : {}),
        },
      };
    },
  },
];
