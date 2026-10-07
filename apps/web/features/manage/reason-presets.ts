import type { ContractOf } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { ruleFor } from './labels.ts';
import type { ManageMessages } from './messages.ts';
import type { QueueAction } from './queue-state.ts';
import type { DecisionBasis, Loaded, ModerationDecisionCommand, ModerationItem, PublishedRule } from './types.ts';

type T = ContractOf<ManageMessages>;

// The statement of reasons a report decision sends to the people it affects
// (the contract's `reasons`: facts, scope, duration, automation, language).
// Moderators pick a reason instead of writing three paragraphs; the catalogs
// carry each reason's words in the moderator's interface language, so the
// statement is written in that language and says so.

/** Report decisions: Main requires a statement of reasons for all of them, keeping included. */
export type ReportAction = 'keep' | 'remove' | 'interim-restrict' | 'final-restrict';

export const isReportAction = (action: QueueAction): action is ReportAction =>
  action === 'keep' || action === 'remove' || action === 'interim-restrict' || action === 'final-restrict';

/** The reasons offered for each decision, in the order their number keys pick them. */
export const reportReasons = {
  keep: ['not-a-breach', 'insufficient-evidence', 'already-handled'],
  remove: ['spam', 'harassment', 'spoiler', 'off-topic', 'rule-breach'],
  'interim-restrict': ['credible-claim', 'awaiting-response'],
  'final-restrict': ['claim-upheld', 'claim-unanswered'],
} as const satisfies Record<ReportAction, readonly string[]>;

export type PresetReason = (typeof reportReasons)[ReportAction][number];
/** `other` is the moderator's own explanation, for what no preset says. */
export type ReasonId = PresetReason | 'other';

export const reasonsFor = (action: ReportAction): readonly ReasonId[] => [...reportReasons[action], 'other'];

/** Longest explanation Main takes for facts, scope or duration. */
export const STATEMENT_LIMIT = 4000;
export const NOTE_LIMIT = 8000;

const APPEAL_ROUTE = '/v1/public-reports/{caseId}/correspondence' as const;

const words: Record<PresetReason, { label: keyof T; facts: keyof T }> = {
  'not-a-breach': { label: 'rsnNotABreach', facts: 'rsnNotABreachFacts' },
  'insufficient-evidence': { label: 'rsnInsufficientEvidence', facts: 'rsnInsufficientEvidenceFacts' },
  'already-handled': { label: 'rsnAlreadyHandled', facts: 'rsnAlreadyHandledFacts' },
  spam: { label: 'rsnSpam', facts: 'rsnSpamFacts' },
  harassment: { label: 'rsnHarassment', facts: 'rsnHarassmentFacts' },
  spoiler: { label: 'rsnSpoiler', facts: 'rsnSpoilerFacts' },
  'off-topic': { label: 'rsnOffTopic', facts: 'rsnOffTopicFacts' },
  'rule-breach': { label: 'rsnRuleBreach', facts: 'rsnRuleBreachFacts' },
  'credible-claim': { label: 'rsnCredibleClaim', facts: 'rsnCredibleClaimFacts' },
  'awaiting-response': { label: 'rsnAwaitingResponse', facts: 'rsnAwaitingResponseFacts' },
  'claim-upheld': { label: 'rsnClaimUpheld', facts: 'rsnClaimUpheldFacts' },
  'claim-unanswered': { label: 'rsnClaimUnanswered', facts: 'rsnClaimUnansweredFacts' },
};

export function reasonLabelOf(reason: ReasonId, t: T): string {
  return reason === 'other' ? t.rsnOther : t[words[reason].label] as string;
}

const scopes: Record<ReportAction, keyof T> = { keep: 'rsnScopeKeep', remove: 'rsnScopeRemove',
  'interim-restrict': 'rsnScopeInterim', 'final-restrict': 'rsnScopeFinal' };
const durations: Record<ReportAction, keyof T> = { keep: 'rsnDurationKeep', remove: 'rsnDurationRemove',
  'interim-restrict': 'rsnDurationInterim', 'final-restrict': 'rsnDurationFinal' };

export interface Statement { facts: string; scope: string; duration: string }

/** A generic reason says nothing about this case by itself: the moderator must add what in it applies. */
export const needsDetails = (reason: ReasonId) => reason === 'other' || reason === 'rule-breach';

/**
 * What the affected person reads for a reason. A reason that blames the
 * content also names the Realm rule the report cited, when there is one; a
 * kept report names no rule, since nothing was found. The moderator's own
 * words (`details`) follow the preset, or are the whole explanation for
 * `other`. Null while the words a reason needs are still empty.
 */
export function statementFor(action: ReportAction, reason: ReasonId, t: T,
  details: string, rule: { number: number; title: string } | null): Statement | null {
  const scope = t[scopes[action]] as string;
  const duration = t[durations[action]] as string;
  const own = details.trim();
  if (needsDetails(reason) && !own) return null;
  if (reason === 'other') return { facts: own, scope, duration };
  const cited = rule && action !== 'keep' ? ` ${t.rsnRuleCited({ number: String(rule.number), title: rule.title })}` : '';
  return { facts: `${t[words[reason].facts] as string}${cited}${own ? ` ${own}` : ''}`, scope, duration };
}

/** The contract's statement; `automation` is whether the case's evidence records automated involvement. */
export function reasonsOf(statement: Statement, locale: UiLocale, automation: boolean):
  ModerationDecisionCommand['reasons'] {
  return { facts: statement.facts, scope: statement.scope, duration: statement.duration, automation,
    appealRoute: APPEAL_ROUTE, contentLanguage: locale };
}

/**
 * Whether a case's retained evidence records automation, the way Main
 * decides (an `automation` entry in an evidence item's provenance) and
 * refuses a statement that denies it. Null when more reports exist than the
 * page read, since a later page could still record it.
 */
export function automationOf(basis: Pick<DecisionBasis, 'reports' | 'nextCursor'>): boolean | null {
  const automated = basis.reports.some(report => report.evidence.some(entry => 'automation' in entry.provenance));
  return automated ? true : basis.nextCursor ? null : false;
}

/**
 * What the preview may say for several cases at once: a value only when every
 * case is known to agree. Each case's own evidence decides its statement when
 * it is sent, so a mixed or unread batch is unknown here, never "involved".
 */
export function combineAutomation(values: readonly (boolean | null)[]): boolean | null {
  const [first] = values;
  return first !== undefined && first !== null && values.every(value => value === first) ? first : null;
}

/** The one Realm rule every reported item names, as its number and title; null when they differ or none is named. */
export function sharedRule(items: readonly Pick<ModerationItem, 'reasonCode'>[], rules: readonly PublishedRule[]):
  { number: number; title: string } | null {
  const cited = items.map(item => ruleFor(item.reasonCode, rules));
  const first = cited[0];
  if (!first || cited.some(entry => entry?.rule.id !== first.rule.id)) return null;
  return { number: first.number, title: first.rule.title.value };
}

/** Where the reason last used for a decision in a Realm is kept, on this device only. */
export const reasonMemoryKey = (realm: string, action: ReportAction) => `rezics:manage:reason:${realm}:${action}`;

export function recallReason(realm: string | undefined, action: ReportAction): PresetReason | null {
  if (!realm) return null;
  let stored: string | null = null;
  try { stored = globalThis.localStorage?.getItem(reasonMemoryKey(realm, action)) ?? null; } catch { /* private mode */ }
  return (reportReasons[action] as readonly string[]).includes(stored ?? '') ? stored as PresetReason : null;
}

export function rememberReason(realm: string | undefined, action: ReportAction, reason: ReasonId) {
  if (!realm || reason === 'other') return;
  try { globalThis.localStorage?.setItem(reasonMemoryKey(realm, action), reason); } catch { /* private mode */ }
}

/** The published rules (reference and revision) every read case cites; null when they differ or a case is unread. */
export function sharedRules(bases: readonly (Loaded<DecisionBasis> | undefined)[]): { ref: string; revision: string } | null {
  const cited = bases.map(basis => basis?.ok ? basis.data.ruleBasis : null);
  const first = cited[0];
  if (!first || cited.some(entry => entry?.ref !== first.ref || entry.revision !== first.revision)) return null;
  return { ref: first.ref, revision: first.revision };
}
