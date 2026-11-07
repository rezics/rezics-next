import { defineRateLimit, type RateLimitDeclaration } from './rate-limit.ts';

const composedRates = new WeakMap<object, ReadonlyMap<string, RateLimitDeclaration>>();

const readOnlyAction = /:(?:read|list)(?:_[a-z][a-z_]*)?(?![\s\S])/;

function writeRateFor(method: string, path: string, action: unknown): RateLimitDeclaration | undefined {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return undefined;
  if (typeof action === 'string' && readOnlyAction.test(action)) return undefined;
  if (method === 'POST' && path === '/v1/webhooks/stripe') return defineRateLimit({ family: 'provider', units: 1 });
  if (action === 'subject:batch_write') return defineRateLimit({ family: 'write', units: 'commands' });
  if (action === 'report:create') return defineRateLimit({ family: 'report', units: 1 });
  return defineRateLimit({ family: 'write', units: 1 });
}

/** Composition declarations for mounted owners which predate the shared stage.
 * Route owners may supply their own declaration; unknown writes remain closed unless this overlay names them.
 */
type RateRoute = { method: string; path: string; hooks?: { detail?: unknown } };

export function declareKernelWriteRates(
  app: { routes: readonly RateRoute[] },
  routes: readonly RateRoute[] = app.routes,
): void {
  const rates = new Map(composedRates.get(app));
  for (const route of routes) {
    const detail = route.hooks?.detail as Record<string, unknown> | undefined;
    const existing = detail?.['x-rate-limit'];
    if (existing !== undefined) {
      rates.set(`${route.method} ${route.path}`, existing as RateLimitDeclaration);
      continue;
    }
    const declared = writeRateFor(route.method, route.path, detail?.['x-action']);
    if (!declared) continue;
    if (detail) detail['x-rate-limit'] = declared;
    rates.set(`${route.method} ${route.path}`, declared);
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
