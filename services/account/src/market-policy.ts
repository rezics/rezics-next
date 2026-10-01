/** Registration and birthday inputs are declarations, never age or residence assurance. */
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
  adultAvailable: boolean;
}>;
const rule = (minimumAge: MarketRule['minimumAge'], registration = true, adultAvailable = true): MarketRule =>
  Object.freeze({ minimumAge, registration, adultAvailable });
export const MARKET_POLICY: Readonly<Record<string, MarketRule>> = Object.freeze({
  ...Object.fromEntries(EEA_COUNTRIES.map((country) => [country, rule(16)])),
  US: rule(13),
  TW: rule(13),
  SG: rule(13),
  JP: rule(13),
  KR: rule(14, true, false),
  GB: rule(13, true, false),
  CN: rule(16, false, false),
});
const strictest = rule(16, true, false);
export function marketRule(country: string | null | undefined): MarketRule {
  return MARKET_POLICY[country?.toUpperCase() ?? ''] ?? strictest;
}
export type SignupPolicyError =
  | 'minimum_age_confirmation_required'
  | 'market_unavailable'
  | 'policy_acceptance_required';
export class SignupPolicyProblem extends Error {
  constructor(
    readonly reason: SignupPolicyError,
    readonly minimumAge?: number,
  ) {
    super(reason);
  }
}

export function admitRegistration(value: unknown, country?: string | null): void {
  const policy = marketRule(country);
  if (!policy.registration) throw new SignupPolicyProblem('market_unavailable');
  if (value !== true) throw new SignupPolicyProblem('minimum_age_confirmation_required', policy.minimumAge);
}
