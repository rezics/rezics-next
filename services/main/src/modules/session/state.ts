import type { ResolvedTarget } from '../target/contract.ts';
import { InvalidSession, SESSION_COST, type SessionChanges, type SessionSelection,
  type SessionState, type SessionStatus } from './contract.ts';

const transitions: Record<SessionStatus, SessionStatus[]> = {
  planned: ['planned', 'active', 'dnf', 'finished'], active: ['active', 'paused', 'dnf', 'finished'],
  paused: ['paused', 'active', 'dnf', 'finished'], dnf: ['dnf'], finished: ['finished'],
};

function dateRange(value: string | null): [string, string] | null {
  if (value === null) return null;
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value) || value.startsWith('0000')) {
    throw new InvalidSession('Invalid session date');
  }
  const [year, month, day] = value.split('-').map(Number);
  const maximum = new Date(0);
  maximum.setUTCFullYear(year, month ?? 12, 0);
  const lastDay = maximum.getUTCDate();
  if (month !== undefined && (month < 1 || month > 12)
    || day !== undefined && (day < 1 || day > lastDay)) throw new InvalidSession('Invalid session date');
  return [value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value,
    value.length === 4 ? `${value}-12-31` : value.length === 7 ? `${value}-${lastDay}` : value];
}

export function validateSessionDates(start: string | null, finish: string | null) {
  const a = dateRange(start), b = dateRange(finish);
  if (a && b && a[0] > b[1]) throw new InvalidSession('Finish precedes start');
}

function selectionPin(selection: SessionSelection) {
  const { target, language, format, progress } = selection;
  // JSONB and clients may reorder object members without changing the pin.
  return JSON.stringify([target.resource, target.base, target.work, target.revision,
    target.types, target.disclosure, language, format, progress]);
}

export function mergeSelections(target: ResolvedTarget, saved: SessionSelection[], added: SessionSelection[]) {
  const selections = [...saved];
  for (const selection of added) {
    if (!selection.target.work || selection.target.work !== target.work
      || !['work', 'realization', 'release', 'occurrence'].includes(selection.target.base)) {
      throw new InvalidSession('Selections must belong to the attempt’s Work');
    }
    const prior = selections.find(item => item.target.resource === selection.target.resource);
    if (prior) {
      // A resource's exact version/language is immutable in an attempt. A new
      // translation or revision needs its own selection/attempt, never a rewind.
      if (selectionPin(prior) !== selectionPin(selection)) throw new InvalidSession('Selection is already pinned');
    } else selections.push(selection);
  }
  if (selections.length > SESSION_COST.selections) throw new InvalidSession('Too many selections in one attempt');
  return selections;
}

/** Omitted members retain their state, following RFC 7396's intent distinction:
 * https://www.rfc-editor.org/rfc/rfc7396.html. This domain patch preserves
 * explicit unknown dates and appends selections instead of replacing arrays. */
export function applySessionChanges(current: SessionState, changes: SessionChanges,
  added: SessionSelection[], now: string): SessionState {
  const state = changes.state ?? current.state;
  if (!transitions[current.state].includes(state)) throw new InvalidSession('A terminal attempt needs a new session');
  const startedOn = changes.startedOn === undefined ? current.startedOn : changes.startedOn;
  const finishedOn = changes.finishedOn === undefined ? current.finishedOn : changes.finishedOn;
  validateSessionDates(startedOn, finishedOn);
  const selections = mergeSelections(current.target, current.selections, added);
  const locators = current.locators.map(locator => ({ ...locator }));
  if (changes.position) {
    const { target, unit, value } = changes.position;
    const selection = selections.find(item => item.target.resource === target);
    if (!selection || selection.progress === 'structure') {
      throw new InvalidSession('Hosted occurrence progress belongs to Structure progress');
    }
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
      || unit === 'page' && !Number.isSafeInteger(value)
      || unit === 'percentage' && value > 100) throw new InvalidSession('Invalid locator value');
    const previous = locators.find(locator => locator.target === target);
    if (previous && previous.unit !== unit) throw new InvalidSession('Locator units cannot change within a selection');
    if (previous) { previous.current = value; previous.furthest = Math.max(previous.furthest, value); }
    else locators.push({ target, unit, current: value, furthest: value });
  }
  return { ...current, state, startedOn, finishedOn, selections, locators,
    completedAt: current.completedAt ?? (state === 'finished' ? now : null),
    version: current.version + 1, changedAt: now };
}
