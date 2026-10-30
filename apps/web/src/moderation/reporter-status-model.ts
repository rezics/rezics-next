/** The adopted own-submission wire DTO; no target content or moderation inspection fields. */
export type ReporterStatus = {
  id: string;
  target: { kind: 'board' | 'thread' | 'post'; id: string };
  revisionId: string | null;
  reason: 'off_topic' | 'inappropriate' | 'spam' | 'illegal' | 'other';
  evidence: string | null;
  reporterId: string;
  createdAt: string;
  resolvedAt: string | null;
  outcome: 'actioned' | 'dismissed' | null;
  targetAvailability: 'available' | 'unavailable';
};

/** Project only the reporter response. A moderator response cannot stand in for it. */
export function reporterStatusResponse(input: unknown): ReporterStatus {
  if (!input || typeof input !== 'object' || !('report' in input) || !input.report || typeof input.report !== 'object')
    throw new Error('Invalid report status response');
  const record = input.report;
  if (
    !('id' in record) ||
    typeof record.id !== 'string' ||
    !('target' in record) ||
    !record.target ||
    typeof record.target !== 'object' ||
    !('kind' in record.target) ||
    (record.target.kind !== 'board' && record.target.kind !== 'thread' && record.target.kind !== 'post') ||
    !('id' in record.target) ||
    typeof record.target.id !== 'string' ||
    !('revisionId' in record) ||
    (record.revisionId !== null && typeof record.revisionId !== 'string') ||
    !('reason' in record) ||
    (record.reason !== 'off_topic' &&
      record.reason !== 'inappropriate' &&
      record.reason !== 'spam' &&
      record.reason !== 'illegal' &&
      record.reason !== 'other') ||
    !('evidence' in record) ||
    (record.evidence !== null && typeof record.evidence !== 'string') ||
    !('reporterId' in record) ||
    typeof record.reporterId !== 'string' ||
    !('createdAt' in record) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !('resolvedAt' in record) ||
    (record.resolvedAt !== null &&
      (typeof record.resolvedAt !== 'string' || !Number.isFinite(Date.parse(record.resolvedAt)))) ||
    !('outcome' in record) ||
    (record.outcome !== null && record.outcome !== 'actioned' && record.outcome !== 'dismissed') ||
    !('targetAvailability' in record) ||
    (record.targetAvailability !== 'available' && record.targetAvailability !== 'unavailable')
  )
    throw new Error('Invalid report status response');
  return {
    id: record.id,
    target: { kind: record.target.kind, id: record.target.id },
    revisionId: record.revisionId,
    reason: record.reason,
    evidence: record.evidence,
    reporterId: record.reporterId,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
    outcome: record.outcome,
    targetAvailability: record.targetAvailability,
  };
}
