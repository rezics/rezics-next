import { defineRateLimit } from './rate-limit.ts';

/** Composition declarations for mounted owners which predate the shared stage.
 * Route owners may supply their own declaration; unknown writes remain closed.
 */
const writes = new Set([
  'subject:create',
  'definitions:publish',
  'definitions:activate',
  'offer:create',
  'offer:manage',
  'order:create',
  'payout_statement:mark_paid',
]);
export function declareKernelWriteRates(app: {
  routes: readonly { method: string; path: string; hooks?: { detail?: unknown } }[];
}): void {
  for (const route of app.routes) {
    const detail = route.hooks?.detail as Record<string, unknown> | undefined;
    if (!detail || detail['x-rate-limit'] !== undefined) continue;
    if (route.method === 'POST' && route.path === '/v1/webhooks/stripe') {
      detail['x-rate-limit'] = defineRateLimit({ family: 'provider', units: 1 });
      continue;
    }
    const action = detail['x-action'];
    if (typeof action !== 'string') continue;
    if (action === 'subject:batch_write')
      detail['x-rate-limit'] = defineRateLimit({ family: 'write', units: 'commands' });
    else if (writes.has(action)) detail['x-rate-limit'] = defineRateLimit({ family: 'write', units: 1 });
  }
}
