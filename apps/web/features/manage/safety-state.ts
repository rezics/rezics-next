import type { ReportCategory } from '../safety/report.ts';
import type { SafetyCase, SafetyItem, SafetyOutcome } from './safety-types.ts';

// What the platform safety queue decides on its own: the order it shows, the
// filters in its address, deadlines as read from Main's timestamps and which
// decisions fit a case. Everything else is what Main returned.

export type DueWindow = 'overdue' | 'day' | 'week';
export interface SafetyView {
  /** `null` shows urgent and routine cases together. */
  urgent: boolean | null;
  category: string | null;
  language: string | null;
  due: DueWindow | null;
}

const windows: Readonly<Record<DueWindow, number>> = { overdue: 0, day: 86_400_000, week: 7 * 86_400_000 };
const windowNames = Object.keys(windows) as DueWindow[];
// Main's report categories (`reportCategory`) and BCP 47 tags are open on the wire; these only keep a malformed address
// from reaching a request.
const code = /^[a-z][a-z0-9_.-]{0,63}$/;
const tag = /^[A-Za-z0-9-]{1,35}$/;

export function parseSafetyView(params: Record<string, string | string[] | undefined>): SafetyView {
  const urgency = params.urgency;
  const category = typeof params.category === 'string' && code.test(params.category) ? params.category : null;
  const language = typeof params.language === 'string' && tag.test(params.language) ? params.language : null;
  const due = typeof params.due === 'string' && (windowNames as string[]).includes(params.due)
    ? params.due as DueWindow : null;
  return { urgent: urgency === 'urgent' ? true : urgency === 'routine' ? false : null, category, language, due };
}

export const SITE_SAFETY_PATH = '/manage/site';

export function safetyHref(view: SafetyView): string {
  const search = new URLSearchParams();
  if (view.urgent !== null) search.set('urgency', view.urgent ? 'urgent' : 'routine');
  if (view.category) search.set('category', view.category);
  if (view.language) search.set('language', view.language);
  if (view.due) search.set('due', view.due);
  const query = search.toString();
  return `${SITE_SAFETY_PATH}${query ? `?${query}` : ''}`;
}

/** The query Main's queue takes for a view; the due window is counted from `now`. */
export function queueQuery(view: SafetyView, now: number) {
  return { ...view.urgent === null ? {} : { urgent: view.urgent }, ...view.category ? { category: view.category as ReportCategory } : {},
    ...view.language ? { contentLanguage: view.language } : {},
    ...view.due ? { dueBefore: new Date(now + windows[view.due]).toISOString() } : {} };
}

export type Deadline = { kind: 'none' } | { kind: 'overdue'; ms: number } | { kind: 'left'; ms: number };

export function deadlineOf(dueAt: string | null, now: number): Deadline {
  if (!dueAt) return { kind: 'none' };
  const ms = Date.parse(dueAt) - now;
  return ms < 0 ? { kind: 'overdue', ms: -ms } : { kind: 'left', ms };
}

/**
 * Urgent cases first, then overdue ones (longest overdue first), then by the
 * nearest deadline, then by when the case opened. Main pages by opening time,
 * so this orders what has been loaded.
 */
export function orderCases(items: readonly SafetyItem[], now: number): SafetyItem[] {
  const rank = (item: SafetyItem) => item.urgent ? 0 : deadlineOf(item.dueAt, now).kind === 'overdue' ? 1 : 2;
  const due = (item: SafetyItem) => item.dueAt ? Date.parse(item.dueAt) : Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => rank(a) - rank(b) || due(a) - due(b)
    || Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.caseId.localeCompare(b.caseId));
}

/** Pages of Main's queue merged by case; a later read of the same case replaces its row. */
export function mergeCases(known: readonly SafetyItem[], found: readonly SafetyItem[]): SafetyItem[] {
  const byId = new Map(known.map(item => [item.caseId, item]));
  for (const item of found) byId.set(item.caseId, item);
  return [...byId.values()];
}

export type Claim = 'free' | 'mine' | 'other';
export const claimOf = (item: SafetyItem, actingSubject: string): Claim =>
  item.claimedBy === null ? 'free' : item.claimedBy === actingSubject ? 'mine' : 'other';

/** A case Main already decided and put back for review: an appeal, a counter-notice or a newer report. */
export const isRevisit = (item: Pick<SafetyItem, 'decisionHead'>) => item.decisionHead !== null;

export interface CaseStep { stepId: string; kind: string }

/**
 * The process steps a staff case read carries. The read gains `steps` with G-906; until the contract has them this
 * is empty, and every decision that must answer a step stays disabled instead of sending a missing one.
 */
export function stepsOf(detail: unknown): CaseStep[] {
  const steps = typeof detail === 'object' && detail !== null && 'steps' in detail ? (detail as { steps: unknown }).steps : null;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((entry: Record<string, unknown>) => {
    const stepId = entry.stepId ?? entry.id;
    const kind = entry.kind ?? entry.step;
    return typeof stepId === 'string' && typeof kind === 'string' ? [{ stepId, kind }] : [];
  });
}

/** Why a decision is shown but cannot be sent: it needs a process step the read does not carry, the legal window is not
 * open, or an earlier decision still has unconfirmed effects. */
export type Blocked = 'step' | 'window' | 'pending';
export interface Offer { outcome: SafetyOutcome; blocked: Blocked | null; step: CaseStep | null }
export interface OfferInput {
  item: Pick<SafetyItem, 'kind' | 'category' | 'dueAt'>;
  /** The case's current decision, as the staff read returns it. */
  decision: { outcome: string; operationStatus: string } | null;
  steps: readonly CaseStep[]; now: number;
}

/** Step kinds a rights restoration may answer (`decide` in the governance store). */
const rightsRestorationSteps: readonly string[] = ['counter_notice', 'appeal', 'restoration_window'];

/**
 * The decisions Main's `decide` accepts for the case's state. A case with no restricting decision (new, or after a
 * dismissal or release) is decided afresh; one with a restricting decision can be reversed. Releases that answer a
 * process step are blocked until the step is known: NCII only reverses an upheld appeal, never restores; a rights
 * restoration answers a counter-notice, appeal or restoration window. Copyright releases wait for the earliest
 * restoration date.
 */
export function offersFor({ item, decision, steps, now }: OfferInput): Offer[] {
  const rights = item.kind === 'rights_complaint';
  const head = decision?.outcome ?? null;
  const open = (outcome: SafetyOutcome): Offer => ({ outcome, blocked: null, step: null });
  if (head === null || !restricts(head as SafetyOutcome)) {
    return (rights ? ['interim_restrict', 'final_restrict', 'dismiss'] as const : ['restrict', 'dismiss'] as const).map(open);
  }
  const pending = decision!.operationStatus !== 'completed';
  const ncii = item.category === 'ncii';
  const windowOpen = item.category !== 'copyright' || (item.dueAt !== null && Date.parse(item.dueAt) <= now);
  const release = (outcome: 'reverse' | 'restore'): Offer => {
    const step = ncii ? steps.find(entry => entry.kind === 'appeal') ?? null
      : rights && outcome === 'restore' ? steps.find(entry => rightsRestorationSteps.includes(entry.kind)) ?? null : null;
    const needsStep = ncii || (rights && outcome === 'restore');
    return { outcome, step, blocked: needsStep && !step ? 'step' : !windowOpen ? 'window' : null };
  };
  const offers: Offer[] = ncii ? [release('reverse')]
    : [...head === 'interim_restrict' ? [open('final_restrict')] : [], release('reverse'), release('restore')];
  return pending ? offers.map(offer => ({ ...offer, blocked: 'pending' as const })) : offers;
}

/** Outcomes that take content or access away; the others release or end the case. */
export const restricts = (outcome: SafetyOutcome) => outcome === 'restrict' || outcome === 'interim_restrict'
  || outcome === 'final_restrict';

export function evidenceDigestOf(view: Pick<SafetyCase, 'reports'>): string | null {
  return view.reports[0]?.evidenceDigest ?? null;
}

/** "2d 3h", "45m": the coarse span a deadline chip shows; a zero second part is left out. */
export function span(ms: number, locale: string): string {
  const hours = Math.floor(ms / 3_600_000);
  const format = (unit: 'day' | 'hour' | 'minute', value: number) =>
    new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
  const [unit, value, next, nextValue] = hours >= 24 ? ['day', Math.floor(hours / 24), 'hour', hours % 24] as const
    : hours >= 1 ? ['hour', hours, 'minute', Math.floor(ms / 60_000) % 60] as const
      : ['minute', Math.max(1, Math.floor(ms / 60_000)), 'minute', 0] as const;
  return nextValue ? `${format(unit, value)} ${format(next, nextValue)}` : format(unit, value);
}
