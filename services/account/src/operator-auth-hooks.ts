import { randomUUID } from 'node:crypto';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import type { Pool } from 'pg';
import { bootstrapOperators, operatorRole, rolePermits, writeAudit } from './operators.ts';
import { requireStepUp } from './methods.ts';
import { decodeJwt } from 'jose';

const mutationPaths = new Set(['/oauth2/create-client', '/admin/oauth2/create-client',
  '/oauth2/update-client', '/admin/oauth2/update-client', '/oauth2/delete-client', '/oauth2/client/rotate-secret']);
const clientMetadataPaths = new Set(['/oauth2/register', '/oauth2/create-client', '/admin/oauth2/create-client',
  '/oauth2/update-client', '/admin/oauth2/update-client']);
interface AuditContext { actorId: string; action: string; targetId: string; reason: string;
  before: unknown; requestId: string; requested?: { name: string } }

async function clientSummary(pool: Pool, clientId: string) {
  const result = await pool.query(`SELECT "clientId", name, disabled, scopes, "grantTypes", "skipConsent"
    FROM "oauthClient" WHERE "clientId" = $1`, [clientId]);
  return result.rows[0] ?? null;
}

/** Better Auth owns its multi-statement client writes. Persist an audit intent
 * before calling it and append the outcome afterwards. A lost connection can
 * leave an attempted record, explicitly distinguishable from success; no
 * secret or bearer credential is copied into this journal. */
export function operatorAuthHooks(pool: Pool, bootstrapIds: ReadonlySet<string>) {
  return {
    before: createAuthMiddleware(async ctx => {
      if (clientMetadataPaths.has(ctx.path)) {
        const body = ctx.body as { update?: Record<string, unknown>; backchannel_logout_uri?: unknown } | undefined;
        const metadata = ctx.path.endsWith('/update-client') ? body?.update : body;
        // A public hostname can resolve to a private destination. The pinned
        // provider checks URL syntax, but cannot pin DNS at logout dispatch.
        if (metadata?.backchannel_logout_uri !== undefined) {
          throw new APIError('BAD_REQUEST', { error: 'invalid_client_metadata',
            error_description: 'Backchannel logout is unavailable; omit backchannel_logout_uri' });
        }
      }
      // Reject outstanding provider email-change JWTs, including its legacy
      // one-step form. Decoding here grants no authority; valid ordinary email
      // verification still goes through the provider's signature validation.
      if (ctx.path === '/verify-email') {
        let payload;
        try { payload = decodeJwt(String(ctx.query?.token ?? '')); }
        catch { throw new APIError('BAD_REQUEST', { code: 'INVALID_TOKEN', message: 'Invalid token' }); }
        if (payload.updateTo !== undefined || payload.requestType !== undefined) {
          throw new APIError('BAD_REQUEST', { code: 'INVALID_TOKEN', message: 'Invalid token' });
        }
      }
      if (!mutationPaths.has(ctx.path) && !(ctx.path.startsWith('/admin/oauth2/resources') && ctx.method !== 'GET')) return;
      await bootstrapOperators(pool, bootstrapIds);
      const session = await getSessionFromCtx(ctx);
      if (!session) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHENTICATED', message: 'Sign in to continue' });
      const role = await operatorRole(pool, session.user.id);
      if (!role || !rolePermits(role, 'clients:manage')) throw new APIError('FORBIDDEN', { code: 'FORBIDDEN', message: 'Operator permission required' });
      try { await requireStepUp(pool, session); }
      catch { throw new APIError('FORBIDDEN', { code: 'STEP_UP_REQUIRED', message: 'Sign in again to continue' }); }
      const reason = ctx.headers?.get('x-account-reason')?.trim() ?? (ctx.request ? '' : 'Server-side OAuth client administration');
      if (reason.length < 3 || reason.length > 1000) throw new APIError('BAD_REQUEST', { code: 'REASON_REQUIRED', message: 'Provide x-account-reason' });
      const body = ctx.body as { client_id?: unknown; client_name?: unknown } | undefined;
      const targetId = typeof body?.client_id === 'string' ? body.client_id : 'new-client';
      const audit: AuditContext = { actorId: session.user.id, action: ctx.path, targetId, reason,
        before: await clientSummary(pool, targetId), requestId: randomUUID(),
        ...(targetId === 'new-client' && typeof body?.client_name === 'string' ? { requested: { name: body.client_name } } : {}) };
      (ctx.context as typeof ctx.context & { operatorAudit?: AuditContext }).operatorAudit = audit;
      await writeAudit(pool, { ...audit, after: audit.requested ?? null, outcome: 'attempted' });
    }),
    after: createAuthMiddleware(async ctx => {
      const audit = (ctx.context as typeof ctx.context & { operatorAudit?: AuditContext }).operatorAudit;
      if (!audit) return;
      const output = ctx.context.returned as { client_id?: unknown } | undefined;
      const targetId = typeof output?.client_id === 'string' ? output.client_id : audit.targetId;
      await writeAudit(pool, { ...audit, targetId, after: await clientSummary(pool, targetId) ?? audit.requested ?? null,
        outcome: ctx.context.returned instanceof APIError ? 'failed' : 'succeeded' });
    }),
  };
}
