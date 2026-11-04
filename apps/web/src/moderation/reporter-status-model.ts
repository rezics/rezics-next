import type { Kernel } from '@rezics/client';

type NativeReport = Kernel['~Routes']['v1']['reports'][':id']['get']['response'][200]['report'];
/** Narrow the installed reporter branch; inspection is a different native response. */
export type ReporterStatus = Extract<NativeReport, { targetAvailability: 'available' | 'unavailable' }> & {
  reporterId: string;
  reason: 'off_topic' | 'inappropriate' | 'spam' | 'illegal' | 'other';
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identity = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);

/** Project only the reporter response. A moderator response cannot stand in for it. */
export function reporterStatusResponse(input: unknown): ReporterStatus {
  if (
    !input ||
    typeof input !== 'object' ||
    'inspection' in input ||
    !('report' in input) ||
    !input.report ||
    typeof input.report !== 'object'
  )
    throw new Error('Invalid report status response');
  const record = input.report;
  if (
    'partition' in record ||
    'transactionId' in record ||
    !('id' in record) ||
    !identity(record.id) ||
    !('target' in record) ||
    !record.target ||
    typeof record.target !== 'object' ||
    !('kind' in record.target) ||
    (record.target.kind !== 'board' &&
      record.target.kind !== 'thread' &&
      record.target.kind !== 'post' &&
      record.target.kind !== 'subject' &&
      record.target.kind !== 'space' &&
      record.target.kind !== 'realm') ||
    !('id' in record.target) ||
    !identity(record.target.id) ||
    !('revisionId' in record) ||
    (record.revisionId !== null && !identity(record.revisionId)) ||
    !('reason' in record) ||
    (record.reason !== 'off_topic' &&
      record.reason !== 'inappropriate' &&
      record.reason !== 'spam' &&
      record.reason !== 'illegal' &&
      record.reason !== 'other') ||
    !('evidence' in record) ||
    (record.evidence !== null && (typeof record.evidence !== 'string' || record.evidence.length > 4096)) ||
    !('reporterId' in record) ||
    !identity(record.reporterId) ||
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
