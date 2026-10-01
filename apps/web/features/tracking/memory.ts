import type { ReaderActions, ReadingStatus } from '../catalogue/reader-actions.tsx';
import { shelfFollowing } from '../catalogue/reader-store.ts';
import type { AttemptWrite, StartInput, StaleChange, TrackingApi } from './api.ts';
import { equivalentDefinition, iri, session as sessionOf } from './fixtures.ts';
import { movesFrom } from './model.ts';
import type { Editions, EditionChoice, EditionPreference, Relations, SelectionInput, ProgressSummary, Session,
  SessionChanges } from './types.ts';

// Main in memory, for stories and tests: attempts with the same compare-and-set versions, pinned
// selections and current/furthest positions as `ConsumptionSessionStore`, answered the way the routes
// answer (a 409 carries the attempt as it stands and the change that was refused). Two `TrackingApi`s
// over one `MemoryMain` are two devices.

export interface MemoryMain {
  sessions: Session[];
  editions: Editions;
  /** Progress per language, as Main would compute it; the tests and stories decide what it says. */
  summaries: Record<string, ProgressSummary | (() => ProgressSummary)>;
  preferences: Map<string, EditionPreference>;
  relations: Relations | null;
  /** What was written, in order, so a test can tell that nothing was written silently. */
  calls: { started: string[]; changed: string[] };
  next: number;
}

export function createMemoryMain(seed: Partial<Pick<MemoryMain, 'sessions' | 'editions' | 'summaries' | 'relations'>> = {}): MemoryMain {
  return { sessions: [], editions: { realizations: [], releases: [], more: false }, summaries: {}, relations: null,
    ...seed, preferences: new Map(), calls: { started: [], changed: [] }, next: 100 };
}

function pin(main: MemoryMain, input: SelectionInput, work: string): Session['selections'][number] {
  const edition = main.editions.realizations.find(item => item.id === input.target)
    ?? main.editions.releases.find(item => item.id === input.target);
  const base = input.target === work ? 'work' : main.editions.releases.some(item => item.id === input.target) ? 'release' : 'realization';
  return { target: { resource: input.target, base, types: [], work, revision: edition?.revision ?? iri('ff9'), disclosure: 'public' },
    language: input.language ?? null, format: input.format ?? null, progress: 'locator' };
}

/** Main's rules for one change (`session/state.ts`), as far as the UI can reach them. */
function applied(main: MemoryMain, current: Session, changes: SessionChanges): Session | 'invalid' {
  const state = changes.state ?? current.state;
  if (!movesFrom(current.state).includes(state) && state !== current.state) return 'invalid';
  const selections = [...current.selections];
  for (const added of changes.addSelections ?? []) {
    const prior = selections.find(item => item.target.resource === added.target);
    const next = pin(main, added, current.target.work!);
    if (prior && (prior.format !== next.format || prior.language !== next.language)) return 'invalid';
    if (!prior) selections.push(next);
  }
  const locators = current.locators.map(item => ({ ...item }));
  if (changes.position) {
    const { target, unit, value } = changes.position;
    const chosen = selections.find(item => item.target.resource === target);
    if (!chosen || chosen.target.base === 'work') return 'invalid';
    const previous = locators.find(item => item.target === target);
    if (previous && previous.unit !== unit) return 'invalid';
    if (previous) { previous.current = value; previous.furthest = Math.max(previous.furthest, value); }
    else locators.push({ target, unit, current: value, furthest: value });
  }
  return { ...current, state, selections, locators,
    startedOn: changes.startedOn === undefined ? current.startedOn : changes.startedOn,
    finishedOn: changes.finishedOn === undefined ? current.finishedOn : changes.finishedOn,
    completedAt: current.completedAt ?? (state === 'finished' ? '2026-10-01T00:00:00.000Z' : null),
    version: current.version + 1, changedAt: '2026-10-01T00:00:00.000Z' };
}

/** One device's calls over the shared Main. */
export function memoryTracking(main: MemoryMain): TrackingApi {
  return {
    async sessions(work) {
      return { ok: true, data: { items: main.sessions.filter(item => item.target.work === work), next: null } };
    },
    async start(work, input: StartInput): Promise<AttemptWrite> {
      main.calls.started.push(work);
      const id = iri(`a${main.next++}`);
      const base = sessionOf({ id, target: { ...sessionOf().target, resource: work, work }, state: input.state,
        startedOn: input.startedOn ?? null, finishedOn: input.finishedOn ?? null, version: 0,
        selections: [pin(main, { target: work }, work)], locators: [] });
      const made = applied(main, base, { addSelections: input.addSelections?.filter(item => item.target !== work) });
      if (made === 'invalid') return { ok: false, failure: 'invalid' };
      const withFormat = input.addSelections?.find(item => item.target === work);
      const created: Session = { ...made, selections: withFormat ? [pin(main, withFormat, work), ...made.selections.slice(1)] : made.selections,
        completedAt: input.state === 'finished' ? '2026-10-01T00:00:00.000Z' : null };
      main.sessions.unshift(created);
      return { ok: true, data: created };
    },
    async change(id, expectedVersion, changes): Promise<AttemptWrite> {
      main.calls.changed.push(id);
      const current = main.sessions.find(item => item.id === id);
      if (!current) return { ok: false, failure: 'missing' };
      if (current.version !== expectedVersion) {
        const submitted: StaleChange = { ...changes, expectedVersion };
        return { ok: false, failure: 'stale', current, submitted };
      }
      const next = applied(main, current, changes);
      if (next === 'invalid') return { ok: false, failure: 'invalid' };
      main.sessions = main.sessions.map(item => (item.id === id ? next : item));
      return { ok: true, data: next };
    },
    async editions() { return { ok: true, data: main.editions }; },
    async series(_resource, language) {
      const found = (language && main.summaries[language]) || Object.values(main.summaries)[0];
      return found ? { ok: true, data: typeof found === 'function' ? found() : found } : { ok: false, failure: 'missing' };
    },
    async relations() { return main.relations ? { ok: true, data: main.relations } : { ok: false, failure: 'missing' }; },
    async definition() { return { ok: true, data: { definition: equivalentDefinition } }; },
    async preference(work) { return { ok: true, data: main.preferences.get(work) ?? null }; },
    async setPreference(work, expectedVersion, choice: EditionChoice) {
      const current = main.preferences.get(work) ?? null;
      if ((current?.version ?? 0) !== expectedVersion) return { ok: false, failure: 'stale', current, submitted: choice };
      const saved: EditionPreference = { work, ...choice, version: expectedVersion + 1 };
      main.preferences.set(work, saved);
      return { ok: true, data: saved };
    },
  };
}

/** What Main projects onto the shelf from a Work's latest attempt (`session/state.ts`). */
const shelfOf = (state: Session['state']): ReadingStatus | null =>
  state === 'planned' ? 'want-to-read' : state === 'finished' ? 'read' : state === 'dnf' ? null : 'reading';

/**
 * Reader actions over the in-memory Main, with the same wrapper the store uses: after a write that took,
 * the Work's shelf is read again (here from its latest attempt), so the status button follows.
 */
export function memoryReader(main: MemoryMain, initial: Record<string, ReadingStatus | null> = {}):
  ReaderActions & { kind: 'ready' } {
  const statuses = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => { version += 1; for (const listener of listeners) listener(); };
  const refresh = (work: string) => {
    const latest = main.sessions.find(item => item.target.work === work);
    if (latest) statuses.set(work, shelfOf(latest.state));
    notify();
  };
  return { kind: 'ready', ratingMax: 5, rate: null,
    stateOf: work => ({ status: statuses.get(work) ?? null, rating: null }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => version,
    async setStatus(work, status) { statuses.set(work, status); notify(); return true; },
    tracking: shelfFollowing(memoryTracking(main), refresh) };
}
