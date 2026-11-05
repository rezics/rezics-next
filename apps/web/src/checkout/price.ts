// Version nibble 1–8 and RFC 4122 variant, the same shape crypto.randomUUID() produces.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

import { m } from '../paraglide/messages.js';
import { formatMinorAmount } from './money';

export function formatOfferPrice(locale: string, currency: string, unitAmountMinor: number, unit?: unknown): string {
  return formatMinorAmount(locale, currency, unitAmountMinor, unit) ?? m.statements_amount_unavailable();
}
