import { Elysia, t } from 'elysia';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired } from '../modules/access/admission.ts';
import { AccountAssertionDenied, AccountAssertionUnavailable }
  from '../modules/account/verify-assertion.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { ThemeDenied, ThemeInvalid, ThemePending, ThemeStale, ThemeUnavailable,
  THEME_READ_SCOPE, activateTheme, readTheme, type ThemeActivationIntent } from '../modules/theme/activation.ts';
import { problem } from './problems.ts';
import { writeProblems } from '../api-responses.ts';

const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const agent = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const origin = t.String({ pattern: '^https://[^\\s/?#]{1,500}$', maxLength: 512 });
const capabilities = t.Object({ data: t.Literal('public-only'), secrets: t.Literal(false),
  networkOrigins: t.Array(origin, { maxItems: 16 }), cpuMs: t.Integer({ minimum: 100, maximum: 5000 }),
  memoryMiB: t.Integer({ minimum: 16, maximum: 256 }) }, { additionalProperties: false });
const noStore = { headers: { 'cache-control': 'no-store' } };

export const openApiOperations = {
  '/v1/themes/{theme}/activations': { post: { bearer: true, idempotencyKey: true } },
  '/v1/themes/{theme}': { get: { bearer: true } },
} as const;

const activationFields = { theme: t.String(), revision: t.String(), predecessor: t.Nullable(t.String()),
  approvalGeneration: t.String(), owner: t.String(), dependencyDigest: t.String(), capabilityDigest: t.String(),
  capabilities: t.Object({ data: t.Literal('public-only'), secrets: t.Literal(false), networkOrigins: t.Array(t.String()),
    cpuMs: t.Number(), memoryMiB: t.Number() }), origin: t.String(), runtime: t.Literal('worker-isolated-v1'),
  approvalId: t.String(), approvedBy: t.String(), approvedAt: t.String(), approvalExpiresAt: t.String(),
  graphReceipt: t.String(), graphDataEpoch: t.String(), graphSequence: t.String() };
const activationResult = t.Object({ ...activationFields, profile: t.Literal('theme-activation-result-v1'),
  replayed: t.Boolean(), active: t.Boolean() });
const themeView = t.Object({ ...activationFields, profile: t.Literal('theme-view-v1'),
  state: t.Union([t.Literal('active'), t.Literal('expired')]), active: t.Boolean() });

function headerKey(request: Request, bodyKey: string): Response | undefined {
  const header = request.headers.get('idempotency-key');
  if (!header || header !== bodyKey) return problem(400, 'invalid_idempotency_key', 'Idempotency-Key must match the request key');
  return undefined;
}

function themeError(error: unknown): Response {
  if (error instanceof AccountAssertionDenied) return problem(403, 'theme_approval_denied',
    'The token does not include the required theme permission');
  if (error instanceof AccountAssertionUnavailable) return problem(503, 'theme_unavailable',
    'Theme permissions could not be verified. Try again later.');
  if (error instanceof ThemeInvalid) return problem(400, 'invalid_theme_activation', error.message);
  if (error instanceof ThemeStale) return problem(409, 'stale_theme_activation',
    'The theme changed during approval. Review its current state and submit a new approval.');
  if (error instanceof AdmissionConflict) return problem(409, 'theme_idempotency_conflict',
    'This idempotency key belongs to a different theme request. Use a new key for a new approval.');
  if (error instanceof AdmissionDenied || error instanceof AdmissionExpired || error instanceof ThemeDenied) {
    return problem(403, 'theme_approval_denied', 'The theme owner or approval is not currently eligible.');
  }
  if (error instanceof ThemePending) return problem(503, 'theme_activation_pending',
    'The activation has not finished. Retry with the same Idempotency-Key.');
  if (error instanceof ThemeUnavailable) return problem(503, 'theme_unavailable',
    'The current theme approval state could not be verified. Try again later.');
  return problem(503, 'theme_unavailable', 'Theme approval service is unavailable');
}

export function themeRoutes(work: MainWorkDependencies) {
  const store = work.themes;
  const unavailable = () => problem(503, 'theme_unavailable', 'Theme approval service is unavailable');
  return new Elysia()
    .post('/v1/themes/:theme/activations', {
      params: t.Object({ theme: uuid }),
      body: t.Object({ profile: t.Literal('theme-activation-request-v1'), owner: agent,
        expectedRevision: t.Nullable(uuid), dependencyDigest: digest, origin, capabilities,
        approvalExpiresAt: t.String({ format: 'date-time' }), actingSubject: agent,
        idempotencyKey: t.String({ pattern: '^[A-Za-z0-9:_./-]{1,128}$' }) }, { additionalProperties: false }),
      response: { 200: activationResult, 201: activationResult, ...writeProblems },
    }, async ({ request, params, body }) => {
      if (!store || !work.account || !work.access) return unavailable();
      const keyError = headerKey(request, body.idempotencyKey);
      if (keyError) return keyError;
      try {
        const input: ThemeActivationIntent & { idempotencyKey: string } = {
          theme: params.theme, owner: body.owner, expectedRevision: body.expectedRevision,
          dependencyDigest: body.dependencyDigest, origin: body.origin,
          capabilities: body.capabilities, approvalExpiresAt: body.approvalExpiresAt,
          actingSubject: body.actingSubject, idempotencyKey: body.idempotencyKey,
        };
        const result = await activateTheme(work.environment, store,
          work.account, work.access, request, input);
        return Response.json({ profile: 'theme-activation-result-v1',
          ...result, theme: `https://rezics.com/id/${params.theme}` },
        { status: result.replayed ? 200 : 201, ...noStore });
      } catch (error) { return themeError(error); }
    })
    .get('/v1/themes/:theme', {
      params: t.Object({ theme: uuid }),
      response: { 200: themeView, ...writeProblems },
    }, async ({ request, params }) => {
      if (!store || !work.account) return unavailable();
      try {
        await work.account.verify(request, [THEME_READ_SCOPE]);
        const result = await readTheme(work.environment, store, params.theme);
        if (!result) return problem(404, 'not_found', 'Theme is unavailable');
        return Response.json({ profile: 'theme-view-v1', ...result,
          theme: `https://rezics.com/id/${params.theme}` }, noStore);
      } catch (error) { return themeError(error); }
    });
}
