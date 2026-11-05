import type { SubjectReportPost } from '../moderation/catalogue-reports-client';

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
