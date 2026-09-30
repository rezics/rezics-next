import type { ContractOf } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { typeLabel } from '../catalogue/types.ts';
import { date, readableCode } from './format.ts';
import type { ManageMessages } from './messages.ts';
import type { QueueAction } from './queue-state.ts';
import { targetWork } from './queue-subject.ts';
import type { AuditItem, ModerationItem, PersonRecord, PublicDecision, PublishedRule, WorkSummary } from './types.ts';

type T = ContractOf<ManageMessages>;

export function kindLabel(kind: ModerationItem['kind'], t: T): string {
  switch (kind) {
    case 'content_report': return t.kindContentReport;
    case 'rights_complaint': return t.kindRightsComplaint;
    case 'contribution_submission': return t.kindContribution;
    case 'correction_submission': return t.kindCorrection;
    case 'work_submission': return t.kindWork;
    case 'content-publication_submission': return t.kindPublication;
  }
}

// Reason codes the demo and first report forms use; any other code reads as words.
const reasons: Record<string, keyof T> = { title_review: 'reasonTitleReview', edition_details: 'reasonEditionDetails' };

/** Whether a report says the content gives away the story (`spoiler`, `spoiler.in_title`, …). */
export const isSpoilerReason = (code: string | null) => code !== null && /^spoilers?(?:[._-]|$)/.test(code);

/**
 * The published rule a report reason names, with its number as readers see
 * it: a report form may send a rule's id (`spoilers`) or `rule.<id>`. Null
 * when the reason is one of the platform's own codes.
 */
export function ruleFor(code: string | null, rules: readonly PublishedRule[]):
  { rule: PublishedRule; number: number } | null {
  if (!code) return null;
  const index = rules.findIndex(rule => code === rule.id || code === `rule.${rule.id}`);
  return index < 0 ? null : { rule: rules[index]!, number: index + 1 };
}

/**
 * A report's reason as the queue shows it: the title of the Realm rule it
 * names, in the reader's language, or else the reason's own words.
 */
export function reasonLabel(item: Pick<ModerationItem, 'kind' | 'reasonCode'>, t: T, rules: readonly PublishedRule[]):
  string | null {
  const cited = item.kind.endsWith('_submission') ? null : ruleFor(item.reasonCode, rules);
  return cited ? cited.rule.title.value : reasonText(item, t);
}

/** What a Work is, in a word: a chapter of a Book, or the kind its types name (Prompt, Mod, Book…). */
export function workTypeText(work: WorkSummary | undefined, locale: UiLocale, t: T): string | null {
  return work?.partOf ? t.typeChapter : typeLabel(work?.types ?? [], locale);
}

export function completionText(status: WorkSummary['completionStatus'], t: T): string | null {
  switch (status) {
    case 'ongoing': return t.statusOngoing;
    case 'completed': return t.statusCompleted;
    case 'hiatus': return t.statusHiatus;
    default: return null;
  }
}

/**
 * A person's standing and record in this Realm as short facts: whether they
 * are a member or banned, then what became of their submissions (for
 * reviewers) or reports (for moderators). Empty parts are left out.
 */
export function recordFacts(record: PersonRecord, t: T, locale: UiLocale): { standing: string; banned: boolean;
  submissions: string[] | null; reports: string[] | null } {
  const { membership } = record;
  const standing = membership.banned ? membership.bannedUntil
    ? t.bannedUntilShort({ date: date(membership.bannedUntil, locale) }) : t.bannedShort
    : membership.state === 'joined' ? membership.joinedAt ? t.memberSince({ date: date(membership.joinedAt, locale) })
      : t.memberJoined
      : membership.state === 'left' ? t.leftRealm : t.notMember;
  const counted = (entries: ReadonlyArray<[number, (count: number) => string]>, total: number, capped: boolean,
    first: string) => {
    const parts = entries.filter(([count]) => count > 0).map(([count, text]) => text(count));
    if (capped) parts.push(t.countMore({ count: String(total) }));
    // The item in front of the moderator is itself one open submission or report.
    return total <= 1 && !capped ? [first] : parts;
  };
  const submissions = record.submissions;
  const reports = record.reports;
  return { standing, banned: membership.banned,
    submissions: submissions ? counted([[submissions.accepted, t.countAccepted], [submissions.rejected, t.countRejected],
      [submissions.changesRequested, t.countSentBack], [submissions.open, t.countWaiting],
      [submissions.withdrawn, t.countWithdrawn]], submissions.total, submissions.capped, t.firstSubmission) : null,
    reports: reports ? counted([[reports.upheld, t.countUpheld], [reports.dismissed, t.countDismissed],
      [reports.open, t.countOpen]], reports.total, reports.capped, t.firstReport) : null };
}

/** A report's reason code, or a submission's public reason, as people read it. */
export function reasonText(item: Pick<ModerationItem, 'kind' | 'reasonCode'>, t: T): string | null {
  if (!item.reasonCode) return null;
  if (item.kind.endsWith('_submission')) return item.reasonCode;
  const key = reasons[item.reasonCode];
  return key ? t[key] as string : readableCode(item.reasonCode);
}

const components: Record<string, keyof T> = { title: 'componentTitle', name: 'componentName', body: 'componentBody',
  structure: 'componentStructure', media_use: 'componentMedia', synopsis: 'componentSynopsis', cover: 'componentCover',
  publication: 'componentPublication', record: 'componentRecord' };

export function componentLabel(component: string, t: T): string {
  const key = components[component];
  return key ? t[key] as string : readableCode(component);
}

export function stateLabel(item: ModerationItem, t: T): string {
  if (!item.submission) return item.state === 'open' ? t.statePending : t.stateClosedReport;
  switch (item.submission.state) {
    case 'pending': return t.statePending;
    case 'deciding': return t.stateDeciding;
    case 'accepted': return t.stateAccepted;
    case 'rejected': return t.stateRejected;
    case 'changes-requested': return t.stateChangesRequested;
    case 'withdrawn': return t.stateWithdrawn;
    case 'stale': return t.stateStale;
  }
}

export function actionLabel(action: QueueAction, t: T): string {
  switch (action) {
    case 'approve': return t.approve;
    case 'reject': return t.reject;
    case 'request-changes': return t.requestChanges;
    case 'keep': return t.keep;
    case 'remove': return t.remove;
    case 'interim-restrict': return t.interimRestrict;
    case 'final-restrict': return t.finalRestrict;
    case 'escalate': return t.escalate;
  }
}

/** "Approved “Title”" for one item, "Approved 3 items" for several. */
export function decidedText(action: QueueAction, titles: readonly string[], t: T): string {
  if (titles.length === 1) {
    const title = titles[0]!;
    switch (action) {
      case 'approve': return t.approvedOne({ title });
      case 'reject': return t.rejectedOne({ title });
      case 'request-changes': return t.changesOne({ title });
      case 'keep': return t.keptOne({ title });
      case 'remove': return t.removedOne({ title });
      case 'interim-restrict': return t.interimRestrictedOne({ title });
      case 'final-restrict': return t.finalRestrictedOne({ title });
      case 'escalate': return t.escalatedOne({ title });
    }
  }
  const count = titles.length;
  switch (action) {
    case 'approve': return t.approvedMany(count);
    case 'reject': return t.rejectedMany(count);
    case 'request-changes': return t.changesMany(count);
    case 'keep': return t.keptMany(count);
    case 'remove': return t.removedMany(count);
    case 'interim-restrict': return t.interimRestrictedMany(count);
    case 'final-restrict': return t.finalRestrictedMany(count);
    case 'escalate': return t.escalatedMany(count);
  }
}

/** One key per kind of answer: A says yes (approve, or keep reported content), R says no (reject, or remove it). */
export const shortcutKeys: Record<QueueAction, string> = { approve: 'a', keep: 'a', reject: 'r', remove: 'r',
  'interim-restrict': 'i', 'final-restrict': 'f', 'request-changes': 'c', escalate: 'e' };

/** The actions a shortcut key stands for, in the order they are tried against what the items allow. */
export function shortcutActions(key: string): QueueAction[] {
  return (Object.entries(shortcutKeys) as [QueueAction, string][]).filter(([, value]) => value === key)
    .map(([action]) => action);
}

/** The audit log's outcome codes: management actions, moderation outcomes and publication rejections. */
export function auditOutcome(item: Pick<AuditItem, 'kind' | 'outcome'>, t: T): string {
  const known: Record<string, string> = {
    'realm.initialize': t.auditInitialize, 'realm.roles.manage': t.auditRoles, 'realm.members.manage': t.auditMembers,
    'realm.settings.manage': t.auditSettings, 'governance.moderate': t.auditEscalate,
    restrict: t.auditRestrict, dismiss: t.auditDismiss, restore: t.auditRestore, reverse: t.auditReverse,
    interim_restrict: t.auditInterim, final_restrict: t.auditFinal,
  };
  if (known[item.outcome]) return known[item.outcome]!;
  return item.kind === 'organization_publication_rejection' ? t.auditReject : readableCode(item.outcome);
}

/** The role, recipient and end date from Main's structured audit detail. */
export function auditDetail(item: AuditItem, t: T, nameOf: (iri: string) => string, locale: UiLocale): string | null {
  const detail = item.detail;
  if (!detail) return null;
  if (detail.kind === 'assignment' && detail.member && detail.assigned !== null) {
    if (!detail.assigned) return t.auditRoleTaken({ member: nameOf(detail.member), role: detail.role.name });
    return detail.validUntil ? t.auditRoleGivenUntil({ member: nameOf(detail.member), role: detail.role.name,
      date: date(detail.validUntil, locale) }) : t.auditRoleGiven({ member: nameOf(detail.member), role: detail.role.name });
  }
  return t.auditRoleUpdated({ role: detail.role.name });
}

/** Consecutive management entries that record one act, shown once with how many changes it made. */
export interface AuditRun { item: AuditItem; count: number; latest: string }

/** Entries this close together, by one person, of one kind and with one reason, are one act. */
const RUN_WINDOW_MS = 10 * 60_000;

/**
 * Groups the audit log's repeated lines. Setting up a team gives several
 * people a role one command at a time; Main records each, with the same
 * reason, and the log reads better as "Changed roles · 3 changes". Moderation
 * decisions each concern their own case, so they are never grouped.
 */
export function auditRuns(items: readonly AuditItem[]): AuditRun[] {
  const runs: AuditRun[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last && !item.detail && !last.item.detail && item.kind === 'realm_management'
      && last.item.kind === item.kind && last.item.outcome === item.outcome
      && last.item.reason === item.reason && last.item.actingSubject === item.actingSubject
      && Date.parse(item.decidedAt) - Date.parse(last.latest) <= RUN_WINDOW_MS) {
      last.count++;
      last.latest = item.decidedAt;
      continue;
    }
    runs.push({ item, count: 1, latest: item.decidedAt });
  }
  return runs;
}

/** The Works an audit page's decisions were about. */
export const auditWorks = (items: readonly AuditItem[]) =>
  items.flatMap(item => item.target ? targetWork(item.target) ?? [] : []);

/** The people an audit page names: who acted, and whom a role change was about. */
export const auditAgents = (items: readonly AuditItem[]) => items.flatMap(item => [item.actingSubject,
  ...(item.detail?.member ? [item.detail.member] : []), ...(item.detail?.changes.map(change => change.member) ?? [])]);

export function auditKindLabel(kind: AuditItem['kind'], t: T): string {
  switch (kind) {
    case 'content_moderation': return t.auditModeration;
    case 'rights_disposition': return t.auditRights;
    case 'organization_publication_rejection': return t.auditPublication;
    case 'realm_management': return t.auditManagement;
  }
}

export function publicDecisionLabel(decision: PublicDecision, t: T): string {
  switch (decision.kind) {
    case 'adoption': return t.decisionAdoption;
    case 'classification': return t.decisionClassification;
    case 'semantic-rule-change': return t.decisionRuleChange;
  }
}
