import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { catalogueReportsClient, type SubjectReportPost } from '../moderation/catalogue-reports-client';

export type ReportDraft = Omit<SubjectReportPost, 'target'> & {
  target: SubjectReportPost['target'];
  idempotencyKey: string;
};
export type ReportResult =
  | { ok: true; reportId: string }
  | { ok: false; reason: 'closed' | 'forbidden' | 'invalid' | 'rate-limited' | 'unavailable'; retryAfter?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateReport(input: unknown): ReportDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid report');
  const data = input as Record<string, unknown>;
  const target = data.target as Record<string, unknown> | undefined;
  if (
    !target ||
    (target.kind !== 'thread' && target.kind !== 'post' && target.kind !== 'subject') ||
    typeof target.id !== 'string' ||
    !uuid.test(target.id) ||
    typeof data.idempotencyKey !== 'string' ||
    !key.test(data.idempotencyKey) ||
    typeof data.botToken !== 'string' ||
    !data.botToken ||
    data.botToken.length > 2048 ||
    typeof data.reason !== 'string' ||
    !['off_topic', 'inappropriate', 'spam', 'illegal', 'other'].includes(data.reason) ||
    (data.revisionId !== undefined && (typeof data.revisionId !== 'string' || !uuid.test(data.revisionId))) ||
    (data.evidence !== undefined && (typeof data.evidence !== 'string' || data.evidence.length > 4096)) ||
    ((data.reason === 'illegal' || data.reason === 'other') &&
      (typeof data.evidence !== 'string' || !data.evidence.trim()))
  )
    throw new Error('Invalid report');
  return {
    target: { kind: target.kind, id: target.id },
    reason: data.reason as ReportDraft['reason'],
    botToken: data.botToken,
    idempotencyKey: data.idempotencyKey,
    ...(data.revisionId === undefined ? {} : { revisionId: data.revisionId as string }),
    ...(data.evidence === undefined ? {} : { evidence: data.evidence as string }),
  };
}

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
