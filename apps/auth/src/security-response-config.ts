import { createServerOnlyFn } from '@tanstack/react-start';
import { securityResponseByteBudgets, securityScopeLimit } from '@rezics/auth-contract';

export type SecurityInventoryView = 'clients' | 'consents';

export const securityInventoryResponseByteBudget = (
  view: SecurityInventoryView,
  configuration: unknown,
): number | null => {
  let scopeLimit: number;
  if (configuration === 'native-no-catalogue') scopeLimit = securityScopeLimit();
  else if (typeof configuration === 'string') {
    const match = /^catalogue:([1-9]\d*)$/.exec(configuration);
    if (!match) return null;
    scopeLimit = Number(match[1]);
    if (!Number.isSafeInteger(scopeLimit) || scopeLimit < 3) return null;
  } else return null;

  try {
    const budgets = securityResponseByteBudgets(scopeLimit, 20);
    const budget = budgets[view];
    return Number.isSafeInteger(budget) && budget > 0 ? budget : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
};

export const serverSecurityInventoryResponseByteBudget = createServerOnlyFn(async (view: SecurityInventoryView) => {
  const { env } = await import('cloudflare:workers');
  return securityInventoryResponseByteBudget(view, env.AUTH_SECURITY_SCOPE_CONFIGURATION);
});
