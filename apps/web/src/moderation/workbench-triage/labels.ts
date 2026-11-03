import { m } from '../../paraglide/messages.js';
import { workbenchReadKey, type WorkbenchSearch } from '../workbench-queue/scope';
import type { WorkbenchCase } from '../workbench-queue/read';

export type WorkbenchTriagePresence = 'present' | 'absent' | 'unavailable';
export type WorkbenchTriageFieldKind = 'text' | 'time' | 'code';
export type WorkbenchTriageField = {
  key: string;
  label: string;
  value: string;
  kind: WorkbenchTriageFieldKind;
  presence: WorkbenchTriagePresence;
  iso?: string;
};

export function workbenchTriageIdentity(page: {
  search: WorkbenchSearch;
  readKey?: string;
  generation?: string;
}): string {
  return `${page.readKey ?? workbenchReadKey(page.search)}\n${page.generation ?? ''}`;
}

export function workbenchTriageType(kind: WorkbenchCase['kind']): string {
  return kind === 'appeal' ? m.moderation_workbench_triage_appeal() : m.moderation_workbench_triage_report();
}

export function workbenchTriageTargetKind(kind: WorkbenchCase['target']['kind']): string {
  if (kind === 'post') return m.reporter_status_post();
  if (kind === 'thread') return m.reporter_status_thread();
  if (kind === 'board') return m.reporter_status_board();
  return m.moderation_workbench_triage_target_subject();
}

export function workbenchTriageReason(reason: string | null): { value: string; presence: WorkbenchTriagePresence } {
  if (reason === null || reason.trim() === '')
    return { value: m.moderation_workbench_triage_reason_unavailable(), presence: 'unavailable' };
  switch (reason) {
    case 'spam':
      return { value: m.report_spam(), presence: 'present' };
    case 'illegal':
      return { value: m.report_illegal(), presence: 'present' };
    case 'inappropriate':
      return { value: m.report_inappropriate(), presence: 'present' };
    case 'off_topic':
      return { value: m.report_off_topic(), presence: 'present' };
    case 'other':
      return { value: m.report_other(), presence: 'present' };
    default:
      return { value: reason, presence: 'present' };
  }
}

export function workbenchTriageOutcome(
  outcome: WorkbenchCase['outcome'] | string,
): { value: string; presence: WorkbenchTriagePresence } {
  if (outcome === 'actioned') return { value: m.moderation_actioned(), presence: 'present' };
  if (outcome === 'dismissed') return { value: m.moderation_dismissed(), presence: 'present' };
  if (outcome === null) return { value: m.reporter_status_pending(), presence: 'absent' };
  return { value: m.moderation_workbench_triage_outcome_unavailable(), presence: 'unavailable' };
}

export function workbenchTriageTime(
  createdAt: string,
  locale: string,
): { iso: string; readable: string } | null {
  if (!createdAt.trim() || !Number.isFinite(Date.parse(createdAt))) return null;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return {
      iso: createdAt,
      readable: new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
        timeZoneName: 'short',
      }).format(date),
    };
  } catch {
    return null;
  }
}

function field(
  key: string,
  label: string,
  value: string,
  presence: WorkbenchTriagePresence,
  kind: WorkbenchTriageFieldKind = 'text',
  iso?: string,
): WorkbenchTriageField {
  return iso ? { key, label, value, kind, presence, iso } : { key, label, value, kind, presence };
}

export function workbenchTriageCreatedField(createdAt: string, locale: string): WorkbenchTriageField {
  const time = workbenchTriageTime(createdAt, locale);
  return time
    ? field('created', m.moderation_workbench_triage_created(), time.readable, 'present', 'time', time.iso)
    : field(
        'created',
        m.moderation_workbench_triage_created(),
        m.moderation_workbench_triage_time_unavailable(),
        'unavailable',
      );
}

/** Compact scan fields. Optional empty evidence and statements stay omitted. */
export function workbenchTriageSummaryFields(item: WorkbenchCase, locale: string): WorkbenchTriageField[] {
  const created = workbenchTriageCreatedField(item.createdAt, locale);
  const fields: WorkbenchTriageField[] = [
    field('type', m.moderation_workbench_triage_type(), workbenchTriageType(item.kind), 'present'),
    field(
      'target-kind',
      m.moderation_workbench_triage_target_kind(),
      workbenchTriageTargetKind(item.target.kind),
      'present',
    ),
    created,
  ];
  if (item.kind === 'report') {
    const reason = workbenchTriageReason(item.reason);
    const outcome = workbenchTriageOutcome(item.outcome);
    fields.splice(
      2,
      0,
      field('reason', m.moderation_reason_label(), reason.value, reason.presence),
      field('outcome', m.moderation_workbench_triage_outcome(), outcome.value, outcome.presence),
    );
    if (item.evidence)
      fields.push(field('evidence', m.moderation_submitted_evidence_label(), item.evidence, 'present'));
  } else if (item.statement) {
    fields.push(field('statement', m.moderation_appeal_reason_label(), item.statement, 'present'));
  }
  return fields;
}

/** Structured disclosure. Optional empty fields stay visible as honest absence. */
export function workbenchTriageDetailFields(item: WorkbenchCase, locale: string): WorkbenchTriageField[] {
  const created = workbenchTriageCreatedField(item.createdAt, locale);
  const time = workbenchTriageTime(item.createdAt, locale);
  const fields: WorkbenchTriageField[] = [
    field('type', m.moderation_workbench_triage_type(), workbenchTriageType(item.kind), 'present'),
    field(
      'target-kind',
      m.moderation_workbench_triage_target_kind(),
      workbenchTriageTargetKind(item.target.kind),
      'present',
    ),
    field('target-id', m.moderation_case_details_target_id(), item.target.id, 'present', 'code'),
    created,
  ];
  if (time)
    fields.push(field('exact-time', m.moderation_workbench_triage_exact_time(), time.iso, 'present', 'code'));
  if (item.kind === 'report') {
    const reason = workbenchTriageReason(item.reason);
    const outcome = workbenchTriageOutcome(item.outcome);
    fields.push(
      field('reason', m.moderation_reason_label(), reason.value, reason.presence),
      field('outcome', m.moderation_workbench_triage_outcome(), outcome.value, outcome.presence),
      field('report-id', m.moderation_queue_details_report_id(), item.id, 'present', 'code'),
      item.evidence
        ? field('evidence', m.moderation_submitted_evidence_label(), item.evidence, 'present')
        : field(
            'evidence',
            m.moderation_submitted_evidence_label(),
            m.moderation_workbench_triage_evidence_absent(),
            'absent',
          ),
    );
    return fields;
  }
  fields.push(
    field('appeal-id', m.moderation_case_details_appeal_id(), item.id, 'present', 'code'),
    item.decisionId
      ? field('decision-id', m.moderation_case_details_decision_id(), item.decisionId, 'present', 'code')
      : field(
          'decision-id',
          m.moderation_case_details_decision_id(),
          m.moderation_workbench_triage_decision_unavailable(),
          'unavailable',
        ),
    item.statement
      ? field('statement', m.moderation_appeal_reason_label(), item.statement, 'present')
      : field(
          'statement',
          m.moderation_appeal_reason_label(),
          m.moderation_workbench_triage_statement_absent(),
          'absent',
        ),
  );
  return fields;
}
