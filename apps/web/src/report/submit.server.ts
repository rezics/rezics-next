import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { catalogueReportsClient } from '../moderation/catalogue-reports-client';
import type { ReportDraft, ReportResult } from './draft';

export type { ReportDraft, ReportResult } from './draft';
export { validateReport } from './draft';

export async function submitReport(
  request: Request,
  env: Partial<SessionEnv>,
  data: ReportDraft,
  client: KernelClient,
): Promise<ReportResult> {
  await prepareSession(request, env);
  const authorization = viewerCredential(request);
  const { idempotencyKey, ...body } = data;
  try {
    const result = await catalogueReportsClient(client).reports.post(body, {
      headers: { 'idempotency-key': JSON.stringify(idempotencyKey), ...(authorization ? { authorization } : {}) },
    });
    if (!result.error) return { ok: true, reportId: result.data.reportId };
    if (isPlatformClosedProblem(result.status, result.error.value)) return { ok: false, reason: 'closed' };
    if (result.status === 401 || result.status === 403) return { ok: false, reason: 'forbidden' };
    if (result.status === 422 || result.status === 400) return { ok: false, reason: 'invalid' };
    if (result.status === 429) {
      const raw = new Headers(result.headers).get('retry-after');
      const wait = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - Date.now()) / 1000 : 1;
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfter: Number.isFinite(wait) ? Math.max(1, Math.ceil(wait)) : 1,
      };
    }
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
  }
  return { ok: false, reason: 'unavailable' };
}
