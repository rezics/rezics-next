// Version nibble 1–8 and RFC 4122 variant, the same shape crypto.randomUUID() produces.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function minorUnitDigits(currency: string): number {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return typeof digits === 'number' ? digits : 2;
}

export function formatOfferPrice(locale: string, currency: string, unitAmountMinor: number): string {
  const major = unitAmountMinor / 10 ** minorUnitDigits(currency);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(major);
}
