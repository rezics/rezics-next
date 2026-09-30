export const principalClasses = ['anonymous', 'new-account', 'member', 'trusted', 'service'] as const;
export type PrincipalClass = typeof principalClasses[number];
export const families = ['write', 'upload', 'report', 'correspondence', 'search'] as const;
export type RateLimitFamily = typeof families[number];
export interface Budget { maximum: number; seconds: number }
export type Budgets = Record<PrincipalClass, Record<RateLimitFamily, Budget>>;

const minute = (maximum: number): Budget => ({ maximum, seconds: 60 });
const day = (maximum: number): Budget => ({ maximum, seconds: 86400 });

/** Deployment policy, not capacity/backpressure. Safety intake has independent
 * counters so spending an ordinary write budget cannot close it. */
export const RATE_LIMIT_V1: Budgets = {
  anonymous: { write: minute(10), upload: day(1), report: day(10), correspondence: day(20), search: minute(30) },
  'new-account': { write: minute(30), upload: day(5), report: day(20), correspondence: day(40), search: minute(60) },
  member: { write: minute(120), upload: day(30), report: day(50), correspondence: day(100), search: minute(120) },
  trusted: { write: minute(600), upload: day(100), report: day(100), correspondence: day(300), search: minute(600) },
  service: { write: minute(6000), upload: day(10000), report: day(100), correspondence: day(300), search: minute(6000) },
};

/** Partial overrides remain a complete, versioned table. Reject typos and
 * unbounded/zero values at startup rather than quietly disabling a family. */
export function rateLimitBudgets(json = '{}'): Budgets {
  const result = structuredClone(RATE_LIMIT_V1);
  const overrides: unknown = JSON.parse(json);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid rate limit overrides');
  for (const [principal, entries] of Object.entries(overrides)) {
    if (!principalClasses.includes(principal as PrincipalClass) || !entries || typeof entries !== 'object'
      || Array.isArray(entries)) throw new Error('Invalid rate limit class');
    for (const [family, value] of Object.entries(entries)) {
      if (!families.includes(family as RateLimitFamily) || !value || typeof value !== 'object'
        || Array.isArray(value)) throw new Error('Invalid rate limit family');
      const budget = value as Budget;
      if (Object.keys(budget).some(key => key !== 'maximum' && key !== 'seconds')
        || !Number.isSafeInteger(budget.maximum) || budget.maximum < 1 || budget.maximum > 1_000_000
        || !Number.isSafeInteger(budget.seconds) || budget.seconds < 1 || budget.seconds > 86400) {
        throw new Error('Invalid rate limit budget');
      }
      result[principal as PrincipalClass][family as RateLimitFamily] = budget;
    }
  }
  return result;
}

/** Every mutation defaults to write. Family rules match whole path segments;
 * future routes inherit protection without a route-specific allowlist. */
export function rateLimitFamily(method: string, path: string): RateLimitFamily | null {
  const search = /^\/v1\/(?:queries|private-queries|search)(?:\/|$)/.test(path);
  if (method === 'OPTIONS') return null;
  if (search) return 'search';
  if (method === 'GET' || method === 'HEAD') return null;
  if (/^\/v1\/media\/uploads(?:\/|$)/.test(path)) return 'upload';
  if (/^\/v1\/(?:public-reports|reports|appeals)\/[^/]+\/(?:correspondence|messages|replies)(?:\/|$)/.test(path)) return 'correspondence';
  if (/^\/v1\/(?:public-reports|reports|appeals|rights\/complaints)(?:\/|$)/.test(path)) return 'report';
  if (/^\/v1\/(?:cases|safety-cases|case-correspondence)(?:\/|$)/.test(path)) return 'correspondence';
  return 'write';
}
