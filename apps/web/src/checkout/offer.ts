import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { loadOffer } from './offer.server';
import { UUID } from './price';
import type { SubjectCoverData } from './subject-cover';
import type { CapturedBenefit } from './benefit';

export type OfferPageData = {
  id: string;
  revision: number;
  /** Seller title, separate from the native immutable benefit terms. */
  title: string;
  currency: string;
  unitAmountMinor: number;
  state: 'active' | 'delisted';
  price: string;
  taxBehavior?: 'exclusive' | null;
  moneyUnit?: import('./money-schema').StripeMoneyUnit | null;
  idempotencyKey: string;
  subject: SubjectCoverData;
  benefit?: CapturedBenefit;
  creatorName?: string | undefined;
};

function validateOffer(input: unknown): { id: string; locale: string } {
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

export const readOffer = createServerFn({ method: 'GET' })
  .validator(validateOffer)
  .handler(({ data }) => loadOffer(data.id, data.locale));
