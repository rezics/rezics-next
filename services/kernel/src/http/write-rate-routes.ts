import { defineRateLimit, type RateLimitDeclaration } from './rate-limit.ts';

const composedRates = new WeakMap<object, ReadonlyMap<string, RateLimitDeclaration>>();

/** Composition declarations for mounted owners which predate the shared stage.
 * Route owners may supply their own declaration; unknown writes remain closed.
 */
const writes = new Set([
  'subject:create',
  'definitions:publish',
  'definitions:activate',
  'presentation:publish',
  'presentation:activate',
  'offer:create',
  'offer:manage',
  'order:create',
  'payout_statement:mark_paid',
  'recent_search:write',
]);
export function declareKernelWriteRates(app: {
  routes: readonly { method: string; path: string; hooks?: { detail?: unknown } }[];
}): void {
  const rates = new Map(composedRates.get(app));
  for (const route of app.routes) {
    const detail = route.hooks?.detail as Record<string, unknown> | undefined;
    if (!detail || detail['x-rate-limit'] !== undefined) continue;
    if (route.method === 'POST' && route.path === '/v1/webhooks/stripe') {
      detail['x-rate-limit'] = defineRateLimit({ family: 'provider', units: 1 });
      rates.set(`${route.method} ${route.path}`, detail['x-rate-limit'] as RateLimitDeclaration);
      continue;
    }
    const action = detail['x-action'];
    if (typeof action !== 'string') continue;
    if (action === 'subject:batch_write')
      detail['x-rate-limit'] = defineRateLimit({ family: 'write', units: 'commands' });
    else if (writes.has(action)) detail['x-rate-limit'] = defineRateLimit({ family: 'write', units: 1 });
    if (detail['x-rate-limit'] !== undefined)
      rates.set(`${route.method} ${route.path}`, detail['x-rate-limit'] as RateLimitDeclaration);
  }
  // Do not rely on mutations of Elysia's composed hook views surviving compilation.
  composedRates.set(app, rates);
}

/** Exact mounted identity only; consulted during catalogue construction, never per request. */
export function kernelWriteRateFor(
  app: object,
  route: { method: string; path: string },
): RateLimitDeclaration | undefined {
  return composedRates.get(app)?.get(`${route.method} ${route.path}`);
}
