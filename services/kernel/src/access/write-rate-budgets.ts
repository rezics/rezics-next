export const principalClasses = ['anonymous', 'new-account', 'member', 'trusted', 'service'] as const;
export type PrincipalClass = (typeof principalClasses)[number];

export const families = ['write', 'upload', 'report', 'correspondence', 'search', 'provider', 'address'] as const;
export type RateLimitFamily = (typeof families)[number];

export interface Budget {
  maximum: number;
  seconds: number;
}

export type Budgets = Record<PrincipalClass, Record<RateLimitFamily, Budget>>;

const minute = (maximum: number): Budget => Object.freeze({ maximum, seconds: 60 });
const day = (maximum: number): Budget => Object.freeze({ maximum, seconds: 86400 });

function freezeClass(budgets: Record<RateLimitFamily, Budget>): Record<RateLimitFamily, Budget> {
  return Object.freeze(budgets) as Record<RateLimitFamily, Budget>;
}

/** Versioned write policy. Safety intake has independent counters. */
export const RATE_LIMIT_V1: Budgets = Object.freeze({
  anonymous: freezeClass({
    write: minute(10),
    upload: day(1),
    report: day(10),
    correspondence: day(20),
    provider: minute(1000),
    search: minute(30),
    address: minute(30),
  }),
  'new-account': freezeClass({
    write: minute(30),
    upload: day(5),
    report: day(20),
    correspondence: day(40),
    provider: minute(1000),
    search: minute(60),
    address: minute(60),
  }),
  member: freezeClass({
    write: minute(120),
    upload: day(30),
    report: day(50),
    correspondence: day(100),
    provider: minute(1000),
    search: minute(120),
    address: minute(120),
  }),
  trusted: freezeClass({
    write: minute(600),
    upload: day(100),
    report: day(100),
    correspondence: day(300),
    provider: minute(1000),
    search: minute(600),
    address: minute(600),
  }),
  service: freezeClass({
    write: minute(6000),
    upload: day(10000),
    report: day(100),
    correspondence: day(300),
    provider: minute(1000),
    search: minute(6000),
    address: minute(6000),
  }),
}) as Budgets;

/** Apply strict partial startup overrides while keeping each result independent. */
export function rateLimitBudgets(json = '{}'): Budgets {
  const result = structuredClone(RATE_LIMIT_V1);
  const overrides: unknown = JSON.parse(json);

  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Invalid rate limit overrides');
  }

  for (const [principal, entries] of Object.entries(overrides)) {
    if (
      !principalClasses.includes(principal as PrincipalClass) ||
      !entries ||
      typeof entries !== 'object' ||
      Array.isArray(entries)
    ) {
      throw new Error('Invalid rate limit class');
    }

    for (const [family, value] of Object.entries(entries)) {
      if (
        !families.includes(family as RateLimitFamily) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        throw new Error('Invalid rate limit family');
      }

      const budget = value as Budget;
      if (
        Object.keys(budget).some((key) => key !== 'maximum' && key !== 'seconds') ||
        !Number.isSafeInteger(budget.maximum) ||
        budget.maximum < 1 ||
        budget.maximum > 1_000_000 ||
        !Number.isSafeInteger(budget.seconds) ||
        budget.seconds < 1 ||
        budget.seconds > 86400
      ) {
        throw new Error('Invalid rate limit budget');
      }

      result[principal as PrincipalClass][family as RateLimitFamily] = {
        maximum: budget.maximum,
        seconds: budget.seconds,
      };
    }
  }

  return result;
}
