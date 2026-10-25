import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { loadOrder } from './order.server';
import { UUID } from './price';

export type Settlement = 'failed' | 'paid' | 'pending' | 'unknown';
export type OrderPageData = { id: string; offerId: string; settlement: Settlement };

function validateOrder(input: unknown): { id: string } {
  if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string' || !UUID.test(input.id))
    throw notFound();
  return { id: input.id };
}

export const readOrder = createServerFn({ method: 'GET' })
  .validator(validateOrder)
  .handler(({ data }) => loadOrder(data.id));
