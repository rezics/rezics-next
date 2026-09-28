import type { ModerationItem, ReadFailure } from './types.ts';

// The triage model behind the queue: which item is current, what is selected,
// which decisions wait out their undo window and how each one ended. It is a
// pure reducer so keyboard, bulk and undo behavior is testable without a browser.

/** Submissions are approved, rejected or sent back; reported content is kept or removed; either can go to the owners. */
export type QueueAction = 'approve' | 'reject' | 'request-changes' | 'keep' | 'remove'
  | 'interim-restrict' | 'final-restrict' | 'escalate';

/**
 * What the acting Agent may decide in this Realm, from the permissions Main
 * lists for it (`GET /v1/me/managed-realms`). Main still refuses anything
 * the Agent may not do; this only keeps impossible choices off the screen.
 */
export interface QueueAuthority {
  /** Keep or remove reported content: `governance.moderate`, and published Realm rules for the decision to cite. */
  decideReports: boolean;
  /** Escalations go to the owners, so an owner has no one to escalate to. */
  escalate: boolean;
}

/** When Main could not say what the Agent holds, every choice shows and Main decides. */
export const fullAuthority: QueueAuthority = { decideReports: true, escalate: true };

export function authorityFrom(permissions: readonly string[] | null): QueueAuthority {
  if (!permissions) return fullAuthority;
  return { decideReports: permissions.includes('governance.moderate'), escalate: !permissions.includes('realm.owner') };
}

/** How long a decision can be taken back before it is sent. Nothing reaches Main before then. */
export const UNDO_WINDOW_MS = 6_000;

export interface Decision {
  action: QueueAction;
  /** Shown to the author (rejection, change request) or to the owners (escalation). */
  reason: string | null;
  /** Kept with the decision for moderators only. */
  note: string | null;
}

export const isReport = (item: Pick<ModerationItem, 'kind'>) =>
  item.kind === 'content_report' || item.kind === 'rights_complaint';

/**
 * A report someone already kept or removed. Main keeps a decided case open,
 * so the decision can still be reversed, and lists it among open items with
 * its decision head; it no longer waits for anyone.
 */
export const isDecidedReport = (item: Pick<ModerationItem, 'kind' | 'decisionHead'>) =>
  isReport(item) && item.decisionHead !== null;

/** The items a view lists: waiting leaves out reports that were already decided. */
export const itemsFor = (items: readonly ModerationItem[], state: 'open' | 'closed') =>
  state === 'open' ? items.filter(item => !isDecidedReport(item)) : [...items];

/**
 * What a moderator can do with an item now. A report is kept or removed
 * (citing its decision basis) and stays decidable after it was escalated.
 * Rights complaints use the rights restriction route for interim or final decisions.
 */
export function actionsFor(item: ModerationItem, authority: QueueAuthority = fullAuthority): ReadonlySet<QueueAction> {
  if (item.state === 'closed' || isDecidedReport(item)) return new Set();
  const escalate: QueueAction[] = item.escalation || !authority.escalate ? [] : ['escalate'];
  if (item.kind === 'content_report') {
    return new Set<QueueAction>([...authority.decideReports ? ['keep', 'remove'] as const : [], ...escalate]);
  }
  if (item.kind === 'rights_complaint') return new Set<QueueAction>([
    ...authority.decideReports ? ['keep', 'interim-restrict', 'final-restrict'] as const : [], ...escalate]);
  if (item.submission?.state !== 'pending') return new Set();
  return new Set<QueueAction>(['approve', 'reject', 'request-changes', ...escalate]);
}

/** Main requires a reason for everything except approving a submission or keeping reported content. */
export const needsReason = (action: QueueAction): action is Exclude<QueueAction, 'approve' | 'keep'> =>
  action !== 'approve' && action !== 'keep';

export interface PendingDecision {
  key: string;
  ids: readonly string[];
  decision: Decision;
  /** Epoch milliseconds when the decision is sent unless undone. */
  deadline: number;
}

export type Settled =
  | { kind: 'done' }
  /** Main refused because the item changed: another moderator got there first, or it moved on. */
  | { kind: 'stale' }
  /** The item left the open queue while a stale decision was being checked. */
  | { kind: 'gone' }
  /** A keep or remove decision needs Realm rules to cite, and none are published. */
  | { kind: 'failed'; failure: ReadFailure | 'invalid-reason' | 'no-rules' };

export interface TriageState {
  order: readonly string[];
  items: Readonly<Record<string, ModerationItem>>;
  current: string | null;
  selected: readonly string[];
  pending: readonly PendingDecision[];
  committing: readonly string[];
  settled: Readonly<Record<string, Settled>>;
}

export type TriageEvent =
  | { type: 'load'; items: readonly ModerationItem[]; append?: boolean }
  | { type: 'focus'; id: string }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'toggle'; id: string }
  | { type: 'select-all' }
  | { type: 'clear-selection' }
  | { type: 'decide'; key: string; ids: readonly string[]; decision: Decision; now: number; window?: number }
  | { type: 'undo'; key?: string }
  | { type: 'commit'; key: string }
  | { type: 'settle'; id: string; outcome: Settled }
  | { type: 'dismiss'; id: string };

export function initialTriage(items: readonly ModerationItem[]): TriageState {
  return { order: items.map(item => item.id), items: Object.fromEntries(items.map(item => [item.id, item])),
    current: items[0]?.id ?? null, selected: [], pending: [], committing: [], settled: {} };
}

/** Items still waiting for this moderator: not in an undo window, not being sent, not decided. */
export function visibleIds(state: TriageState): string[] {
  const held = new Set([...state.pending.flatMap(entry => entry.ids), ...state.committing]);
  return state.order.filter(id => !held.has(id) && state.settled[id]?.kind !== 'done'
    && state.settled[id]?.kind !== 'gone');
}

/** The items the next decision applies to: the selection, or else the current item. */
export function targetIds(state: TriageState): string[] {
  const visible = new Set(visibleIds(state));
  const selected = state.selected.filter(id => visible.has(id));
  if (selected.length) return selected;
  return state.current && visible.has(state.current) ? [state.current] : [];
}

/** Actions every target allows, so a bulk decision is never half-applicable. */
export function commonActions(state: TriageState, ids: readonly string[], authority: QueueAuthority = fullAuthority):
  Set<QueueAction> {
  const sets = ids.map(id => state.items[id]).filter(item => item !== undefined).map(item => actionsFor(item, authority));
  if (!sets.length) return new Set();
  return new Set([...sets[0]!].filter(action => sets.every(set => set.has(action))));
}

function nextCurrent(state: TriageState, removed: ReadonlySet<string>, from: string | null): string | null {
  const visible = visibleIds(state);
  if (from && visible.includes(from) && !removed.has(from)) return from;
  // Continue down the list from where the decided item was, as mail and review tools do.
  const index = from ? state.order.indexOf(from) : -1;
  const after = state.order.slice(index + 1).find(id => visible.includes(id) && !removed.has(id));
  if (after) return after;
  return [...state.order.slice(0, Math.max(index, 0))].reverse()
    .find(id => visible.includes(id) && !removed.has(id)) ?? null;
}

export function triage(state: TriageState, event: TriageEvent): TriageState {
  switch (event.type) {
    case 'load': {
      const incoming = new Map(event.items.map(item => [item.id, item]));
      const order = event.append
        ? [...state.order, ...event.items.map(item => item.id).filter(id => !state.items[id])]
        : event.items.map(item => item.id);
      const items = event.append ? { ...state.items, ...Object.fromEntries(incoming) } : Object.fromEntries(incoming);
      const settled: Record<string, Settled> = {};
      const pendingIds = new Set([...state.pending.flatMap(entry => entry.ids), ...state.committing]);
      // Keep items that are still ours to resolve even if a fresh page no longer lists them.
      for (const id of pendingIds) if (!items[id] && state.items[id]) items[id] = state.items[id]!;
      for (const [id, outcome] of Object.entries(state.settled)) {
        const present = incoming.has(id) || event.append && state.items[id] !== undefined;
        if (outcome.kind === 'stale') settled[id] = present ? outcome : { kind: 'gone' };
        else if (outcome.kind === 'failed' && present) settled[id] = outcome;
        else if (outcome.kind === 'gone') settled[id] = outcome;
      }
      const keep = [...order];
      for (const id of Object.keys(settled)) if (!keep.includes(id) && state.items[id]) {
        keep.push(id);
        items[id] = state.items[id]!;
      }
      for (const id of pendingIds) if (!keep.includes(id)) keep.push(id);
      const next: TriageState = { ...state, order: keep, items, settled,
        selected: state.selected.filter(id => incoming.has(id) || event.append && state.items[id] !== undefined) };
      return { ...next, current: nextCurrent(next, new Set(), state.current) };
    }
    case 'focus':
      return visibleIds(state).includes(event.id) ? { ...state, current: event.id } : state;
    case 'move': {
      const visible = visibleIds(state);
      if (!visible.length) return { ...state, current: null };
      const index = state.current ? visible.indexOf(state.current) : -1;
      const target = index < 0 ? (event.delta > 0 ? 0 : visible.length - 1)
        : Math.min(visible.length - 1, Math.max(0, index + event.delta));
      return { ...state, current: visible[target]! };
    }
    case 'toggle': {
      if (!visibleIds(state).includes(event.id)) return state;
      const selected = state.selected.includes(event.id)
        ? state.selected.filter(id => id !== event.id) : [...state.selected, event.id];
      return { ...state, selected };
    }
    case 'select-all':
      return { ...state, selected: visibleIds(state) };
    case 'clear-selection':
      return { ...state, selected: [] };
    case 'decide': {
      const visible = new Set(visibleIds(state));
      const ids = event.ids.filter(id => visible.has(id));
      if (!ids.length) return state;
      const removed = new Set(ids);
      const settled = { ...state.settled };
      for (const id of ids) delete settled[id];
      const next: TriageState = { ...state, settled,
        pending: [...state.pending, { key: event.key, ids, decision: event.decision,
          deadline: event.now + (event.window ?? UNDO_WINDOW_MS) }],
        selected: state.selected.filter(id => !removed.has(id)) };
      return { ...next, current: nextCurrent(next, removed, state.current && removed.has(state.current)
        ? state.current : ids.at(-1) ?? state.current) };
    }
    case 'undo': {
      const entry = event.key ? state.pending.find(item => item.key === event.key) : state.pending.at(-1);
      if (!entry) return state;
      return { ...state, pending: state.pending.filter(item => item !== entry), current: entry.ids[0] ?? state.current };
    }
    case 'commit': {
      const entry = state.pending.find(item => item.key === event.key);
      if (!entry) return state;
      return { ...state, pending: state.pending.filter(item => item !== entry),
        committing: [...state.committing, ...entry.ids] };
    }
    case 'settle': {
      const next: TriageState = { ...state, committing: state.committing.filter(id => id !== event.id),
        settled: { ...state.settled, [event.id]: event.outcome } };
      return event.outcome.kind === 'done' ? next : { ...next, current: next.current ?? event.id };
    }
    case 'dismiss': {
      const settled = { ...state.settled };
      delete settled[event.id];
      return { ...state, settled };
    }
  }
}
