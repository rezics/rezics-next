import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import type { createAccountAuth } from './auth.ts';
import { currentConsentIntrospection } from './consent-fence.ts';
import { guardedAuthorizationCodeExchange } from './oauth-code-guard.ts';

export function createAccountApp(auth: ReturnType<typeof createAccountAuth>, pool: Pool) {
  return new Elysia()
    .get('/health/live', { response: t.Object({ status: t.Literal('ok') }) },
      () => ({ status: 'ok' as const }))
    .get('/health/ready', {
      response: {
        200: t.Object({ status: t.Literal('ready') }),
        503: t.Object({ status: t.Literal('unavailable') }),
      },
    }, async ({ status }) => {
      try {
        await pool.query('SELECT 1');
        return { status: 'ready' as const };
      } catch {
        return status(503, { status: 'unavailable' as const });
      }
    })
    .post('/api/auth/oauth2/introspect', async ({ request }) =>
      currentConsentIntrospection(pool, await auth.handler(request.clone())))
    // The pinned provider lets update-consent widen scopes without the
    // authorization/consent round trip. This first profile admits edits only
    // through that explicit round trip, which advances the durable generation.
    .post('/api/auth/oauth2/update-consent', () =>
      Response.json({ error: 'unsupported_consent_update' }, { status: 403 }))
    .post('/api/auth/oauth2/token', ({ request }) =>
      guardedAuthorizationCodeExchange(pool, request, () => auth.handler(request)))
    // A product must bind and consume state at its callback. Require the input
    // here as well so an authorization request cannot omit that CSRF binding.
    .get('/api/auth/oauth2/authorize', ({ request }) => {
      const states = new URL(request.url).searchParams.getAll('state');
      if (states.length !== 1 || !states[0]) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      return auth.handler(request);
    })
    .mount(auth.handler);
}
