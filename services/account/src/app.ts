import { Elysia, t } from 'elysia';
import type { Pool } from 'pg';
import type { createAccountAuth } from './auth.ts';
import { currentConsentIntrospection } from './consent-fence.ts';

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
    .mount(auth.handler);
}
