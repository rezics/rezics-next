import type { EditionChoice, Editions, Locator, LocatorUnit, Selection, SelectionInput, Session, SessionChanges,
  SessionState } from './types.ts';

// What tracking needs to know that is not a read of Main: which moves the status control offers, how a
// date or a time is typed and shown, and how two versions of an attempt differ. Nothing here computes
// progress; every state, count and "next" on screen is Main's.

export const sessionStates = ['planned', 'active', 'paused', 'dnf', 'finished'] as const satisfies readonly SessionState[];

/**
 * The moves Main accepts (`services/main/src/modules/session/state.ts`): a finished or did-not-finish
 * attempt has ended, and reading it again is a new attempt. Main enforces this; the control only offers it.
 */
const moves: Record<SessionState, readonly SessionState[]> = {
  planned: ['active', 'dnf', 'finished'], active: ['paused', 'dnf', 'finished'],
  paused: ['active', 'dnf', 'finished'], dnf: [], finished: [],
};
export const movesFrom = (state: SessionState) => moves[state];
export const hasEnded = (session: Pick<Session, 'state'>) => moves[session.state].length === 0;

/** An attempt that is being read now. Two devices that both start one leave two of these. */
export const isOpen = (session: Pick<Session, 'state'>) => session.state === 'active' || session.state === 'paused';

/** Attempts in the order Main lists them (newest first) numbered from the oldest: the first read, then rereads. */
export function numbered(sessions: readonly Session[]): { session: Session; number: number }[] {
  return sessions.map((session, index) => ({ session, number: sessions.length - index }));
}

/** Formats are the reader's own words; these four are named in every language and kept under a stable key. */
export const knownFormats = ['print', 'ebook', 'audiobook', 'web'] as const;
export type KnownFormat = (typeof knownFormats)[number];
export const isKnownFormat = (value: string | null): value is KnownFormat =>
  (knownFormats as readonly (string | null)[]).includes(value);

// Dates keep the precision the reader knows; null is unknown, never today (Main stores it as given).
const datePattern = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** A year, year-month or full date that exists, or nothing Main would accept. */
export function validDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match || match[1] === '0000') return false;
  const [year, month, day] = [Number(match[1]), match[2] ? Number(match[2]) : null, match[3] ? Number(match[3]) : null];
  if (month !== null && (month < 1 || month > 12)) return false;
  if (day !== null) {
    const last = new Date(Date.UTC(2000, month!, 0));
    last.setUTCFullYear(year, month!, 0);
    if (day < 1 || day > last.getUTCDate()) return false;
  }
  return true;
}

/** A date at the precision it was given, in the reader's language; null when unknown. */
export function dateText(value: string | null, locale: string): string | null {
  if (value === null || !validDate(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number | undefined, number | undefined];
  const at = new Date(Date.UTC(2000, (month ?? 1) - 1, day ?? 1));
  at.setUTCFullYear(year);
  const options: Intl.DateTimeFormatOptions = day ? { dateStyle: 'medium' } : month ? { year: 'numeric', month: 'long' }
    : { year: 'numeric' };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(at);
}

export const today = () => new Date().toISOString().slice(0, 10);

/** `1:02:03`, `12:30` or seconds, as seconds; null when it is none of these. */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some(part => !/^\d+(\.\d+)?$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some(value => value >= 60)) return null;
  return numbers.reduce((total, value) => total * 60 + value, 0);
}

export function timeText(seconds: number): string {
  const whole = Math.floor(seconds);
  const [h, m, s] = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60];
  const pad = (value: number) => String(value).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A typed position as the value Main takes for its unit, or null when it is not valid for it. */
export function parsePosition(unit: LocatorUnit, text: string): number | null {
  const value = unit === 'media-time' ? parseTime(text) : /^\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : null;
  if (value === null || !Number.isFinite(value)) return null;
  if (unit === 'page') return Number.isSafeInteger(value) ? value : null;
  return unit === 'percentage' && value > 100 ? null : value;
}

/** A resource Main lets a page, percentage or time be recorded against: an exact edition, not the Work. */
export const takesPosition = (selection: Selection) => selection.progress === 'locator' && selection.target.base !== 'work';

export const locatorOf = (session: Session, selection: Selection): Locator | undefined =>
  session.locators.find(locator => locator.target === selection.target.resource);

/** What an attempt can add: its Work in general, or one of the Work's realizations or releases, each once. */
export interface EditionOption { resource: string; kind: 'work' | 'realization' | 'release'; revision?: string; language: string | null }

export function editionOptions(work: string, editions: Editions | null, session: Session | null): EditionOption[] {
  const taken = new Set(session?.selections.map(selection => selection.target.resource));
  const options: EditionOption[] = [{ resource: work, kind: 'work', language: null },
    ...(editions?.realizations ?? []).map(item => ({ resource: item.id, kind: 'realization' as const,
      revision: item.revision, language: item.language })),
    ...(editions?.releases ?? []).map(item => ({ resource: item.id, kind: 'release' as const, revision: item.revision,
      language: item.contentLanguages.length === 1 ? item.contentLanguages[0]! : null }))];
  return options.filter(option => !taken.has(option.resource));
}

export function selectionInput(option: EditionOption, format: string | null): SelectionInput {
  return { target: option.resource, ...(option.language ? { language: option.language } : {}), ...(format ? { format } : {}) };
}

/** One field on which two versions of an attempt disagree. */
export type ConflictRow =
  | { field: 'state'; mine: SessionState; theirs: SessionState }
  | { field: 'startedOn' | 'finishedOn'; mine: string | null; theirs: string | null }
  | { field: 'selection'; mine: SelectionInput; theirs: Selection | null }
  | { field: 'position'; target: string; unit: LocatorUnit; mine: number; theirs: Locator | null };

/**
 * The fields a refused change touches that differ in the state Main now holds: the two sides of a 409.
 * A change whose result is already there (the same state, an edition already pinned the same way)
 * is not a disagreement and is left out.
 */
export function conflictRows(current: Session, submitted: SessionChanges): ConflictRow[] {
  const rows: ConflictRow[] = [];
  if (submitted.state !== undefined && submitted.state !== current.state) {
    rows.push({ field: 'state', mine: submitted.state, theirs: current.state });
  }
  for (const field of ['startedOn', 'finishedOn'] as const) {
    if (submitted[field] !== undefined && submitted[field] !== current[field]) {
      rows.push({ field, mine: submitted[field] ?? null, theirs: current[field] });
    }
  }
  for (const added of submitted.addSelections ?? []) {
    const existing = current.selections.find(selection => selection.target.resource === added.target) ?? null;
    const same = existing && (added.format ?? null) === existing.format;
    if (!same) rows.push({ field: 'selection', mine: added, theirs: existing });
  }
  const position = submitted.position;
  if (position) {
    const existing = current.locators.find(locator => locator.target === position.target) ?? null;
    if (!existing || existing.unit !== position.unit || existing.current !== position.value) {
      rows.push({ field: 'position', target: position.target, unit: position.unit, mine: position.value, theirs: existing });
    }
  }
  return rows;
}

/** The refused change to send again on Main's current version ("keep mine"). */
export const withoutVersion = (submitted: SessionChanges & { expectedVersion?: number }): SessionChanges => {
  const { expectedVersion: _ignored, ...changes } = submitted;
  return changes;
};

export type { EditionChoice };
