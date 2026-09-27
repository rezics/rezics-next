import type { ContractOf } from 'native-i18n';
import { readableCode } from './format.ts';
import type { ManageMessages } from './messages.ts';
import type { QueueAction } from './queue-state.ts';
import type { AuditItem, ModerationItem, PublicDecision } from './types.ts';

type T = ContractOf<ManageMessages>;

export function kindLabel(kind: ModerationItem['kind'], t: T): string {
  switch (kind) {
    case 'content_report': return t.kindContentReport;
    case 'rights_complaint': return t.kindRightsComplaint;
    case 'contribution_submission': return t.kindContribution;
    case 'correction_submission': return t.kindCorrection;
  }
}

// Reason codes the demo and first report forms use; any other code reads as words.
const reasons: Record<string, keyof T> = { title_review: 'reasonTitleReview', edition_details: 'reasonEditionDetails' };

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
      case 'escalate': return t.escalatedOne({ title });
    }
  }
  const count = titles.length;
  switch (action) {
    case 'approve': return t.approvedMany(count);
    case 'reject': return t.rejectedMany(count);
    case 'request-changes': return t.changesMany(count);
    case 'escalate': return t.escalatedMany(count);
  }
}

export const shortcutKeys: Record<QueueAction, string> = { approve: 'a', reject: 'r', 'request-changes': 'c',
  escalate: 'e' };

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
