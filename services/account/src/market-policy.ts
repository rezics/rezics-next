/** Registration inputs are declarations, never age or residence assurance.
 * Adult features remain closed for every market at the first launch. */
export const MARKET_POLICY_VERSION = '2026-10-01';
export const EEA_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'IS',
  'LI',
  'NO',
] as const;
export type MarketRule = Readonly<{
  minimumAge: 13 | 14 | 16;
  registration: boolean;
  adultAvailable: false;
}>;
const rule = (minimumAge: MarketRule['minimumAge'], registration = true): MarketRule =>
  Object.freeze({ minimumAge, registration, adultAvailable: false });
export const MARKET_POLICY: Readonly<Record<string, MarketRule>> = Object.freeze({
  ...Object.fromEntries(EEA_COUNTRIES.map((country) => [country, rule(16)])),
  US: rule(13),
  TW: rule(13),
  SG: rule(13),
  JP: rule(13),
  KR: rule(14),
  GB: rule(13),
  CN: rule(16, false),
});
const strictest = rule(16);
export function marketRule(country: string | null | undefined): MarketRule {
  return MARKET_POLICY[country?.toUpperCase() ?? ''] ?? strictest;
}
export type SignupPolicyError =
  | 'birth_month_required'
  | 'invalid_birth_month'
  | 'market_unavailable'
  | 'market_minimum_age'
  | 'policy_acceptance_required';
export class SignupPolicyProblem extends Error {
  constructor(
    readonly reason: SignupPolicyError,
    readonly minimumAge?: number,
  ) {
    super(reason);
  }
}

/** With no day, the birthday is treated as the final day of the month.
 * Eligibility begins at 00:00 UTC on the following month's first day. */
export function admitBirthMonth(value: unknown, country?: string | null, now = new Date()): string {
  if (value === undefined || value === null || value === '')
    throw new SignupPolicyProblem('birth_month_required');
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new SignupPolicyProblem('invalid_birth_month');
  }
  const [year, month] = value.split('-').map(Number) as [number, number];
  const months = (now.getUTCFullYear() - year) * 12 + now.getUTCMonth() + 1 - month;
  if (year < 1900 || months < 0) throw new SignupPolicyProblem('invalid_birth_month');
  const policy = marketRule(country);
  if (!policy.registration) throw new SignupPolicyProblem('market_unavailable');
  if (months <= policy.minimumAge * 12)
    throw new SignupPolicyProblem('market_minimum_age', policy.minimumAge);
  return value;
}
