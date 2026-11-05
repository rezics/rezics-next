import type { QueryClient } from '@tanstack/react-query';
import type { DynamicCollectionPage } from '../dynamic-collection';

export type ResultsWindowMode = 'anonymous' | 'session';
export type ResultsWindowMove = 'continue' | 'previous' | 'first';
export type ResultsCursor = string | undefined;

export type ResultsWindowFocusHandoff = {
  keyboard: true;
  source: HTMLElement;
  eligible: () => boolean;
};
type StoredFocusHandoff = ResultsWindowFocusHandoff & { release: () => void };
type StagedMove = {
  target: ResultsCursor;
  move: ResultsWindowMove;
  focus?: StoredFocusHandoff;
  failed: boolean;
};
type Reading = {
  scope: string;
  current: ResultsCursor;
  admitted: boolean;
  predecessors: ResultsCursor[];
  staged?: StagedMove;
};
type Visit = { base: string; readings: Partial<Record<ResultsWindowMode, Reading>> };

const visits = new WeakMap<QueryClient, Visit>();

function focusHandoff(source: HTMLElement | undefined): StoredFocusHandoff | undefined {
  const owner = source?.ownerDocument;
  if (!source || !owner || owner.activeElement !== source) return undefined;
  let eligible = true;
  let released = false;
  let cancel = () => {};
  let onFocusIn = (_event: FocusEvent) => {};
  const release = () => {
    if (released) return;
    released = true;
    owner.removeEventListener('focusin', onFocusIn, true);
    owner.removeEventListener('pointerdown', cancel, true);
    owner.removeEventListener('keydown', cancel, true);
  };
  cancel = () => {
    eligible = false;
    release();
  };
  onFocusIn = (event) => {
    if (event.target !== source && event.target !== owner.body && event.target !== owner.documentElement) cancel();
  };
  owner.addEventListener('focusin', onFocusIn, true);
  owner.addEventListener('pointerdown', cancel, true);
  owner.addEventListener('keydown', cancel, true);
  return {
    keyboard: true,
    source,
    eligible: () =>
      eligible &&
      (owner.activeElement === source ||
        (!source.isConnected && (owner.activeElement === owner.body || owner.activeElement === owner.documentElement))),
    release,
  };
}

function releaseReading(reading: Reading | undefined): void {
  reading?.staged?.focus?.release();
}

/** A saved result visit is bound to the exact route address, locale and current admission generation. */
export function savedQueryResultsWindowBase(input: {
  id: string;
  search?: Record<string, string | string[]>;
  locale: string;
  admission: number;
}): string {
  return JSON.stringify([
    input.id,
    Object.entries(input.search ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    input.locale,
    input.admission,
  ]);
}

/** Scope a coordinate path without retaining its rendered page, private rule or command disclosure. */
export function savedQueryResultsWindowScope(
  base: string,
  mode: ResultsWindowMode,
  viewerId: string | null,
  page: Pick<
    DynamicCollectionPage,
    'id' | 'revision' | 'filterReleaseKey' | 'visibility' | 'viewerActions' | 'presentationKindSource' | 'coverSource'
  >,
): string {
  const authority = page.viewerActions
    ? JSON.stringify([
        page.viewerActions.state,
        page.viewerActions.state === 'ready'
          ? page.viewerActions.actions.map(({ action, operations }) => [action, [...operations].sort()]).sort()
          : null,
      ])
    : null;
  return JSON.stringify([
    base,
    mode,
    mode === 'session' ? viewerId : null,
    page.id,
    page.revision ?? null,
    page.filterReleaseKey ?? null,
    page.visibility ?? null,
    page.presentationKindSource ?? null,
    page.coverSource ?? null,
    authority === null ? null : fingerprint(authority),
  ]);
}

function fingerprint(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${left >>> 0}.${right >>> 0}`;
}

function visitFor(client: QueryClient, base: string): Visit {
  const current = visits.get(client);
  if (current?.base === base) return current;
  if (current) Object.values(current.readings).forEach(releaseReading);
  const next = { base, readings: {} } satisfies Visit;
  visits.set(client, next);
  return next;
}

function readingFor(visit: Visit, mode: ResultsWindowMode, scope: string): Reading {
  const current = visit.readings[mode];
  if (current?.scope === scope) return current;
  releaseReading(current);
  const next: Reading = { scope, current: undefined, admitted: false, predecessors: [] };
  visit.readings[mode] = next;
  return next;
}

export type ResultsWindowView = {
  current: ResultsCursor;
  isCurrent: boolean;
  previous?: ResultsCursor;
  hasPrevious: boolean;
  pendingTarget: boolean;
  failedTarget: boolean;
};

export function readSavedQueryResultsWindow(
  client: QueryClient,
  base: string,
  mode: ResultsWindowMode,
  scope: string,
  routeCursor: ResultsCursor,
): ResultsWindowView {
  const reading = readingFor(visitFor(client, base), mode, scope);
  const isCurrent = reading.admitted && reading.current === routeCursor && !reading.staged;
  return {
    current: reading.current,
    isCurrent,
    ...(isCurrent && reading.predecessors.length
      ? { previous: reading.predecessors[reading.predecessors.length - 1] }
      : {}),
    hasPrevious: isCurrent && reading.predecessors.length > 0,
    pendingTarget: reading.staged !== undefined && reading.staged.target === routeCursor,
    failedTarget: reading.staged?.failed === true && reading.staged.target === routeCursor,
  };
}

export function stageSavedQueryResultsWindowMove(
  client: QueryClient,
  base: string,
  mode: ResultsWindowMode,
  scope: string,
  from: ResultsCursor,
  target: ResultsCursor,
  move: ResultsWindowMove,
  source?: HTMLElement,
): boolean {
  const reading = visitFor(client, base).readings[mode];
  if (!reading || reading.scope !== scope || !reading.admitted || reading.current !== from || reading.staged)
    return false;
  if (move === 'previous' && reading.predecessors[reading.predecessors.length - 1] !== target) return false;
  reading.staged = { target, move, focus: focusHandoff(source), failed: false };
  return true;
}

export function admitSavedQueryResultsWindow(
  client: QueryClient,
  base: string,
  mode: ResultsWindowMode,
  scope: string,
  cursor: ResultsCursor,
  cursorRestarted: boolean,
): { changed: boolean; focus?: ResultsWindowFocusHandoff } {
  const visit = visitFor(client, base);
  const reading = readingFor(visit, mode, scope);
  if (cursorRestarted) {
    const storedFocus = reading.staged?.focus;
    const focus = storedFocus?.eligible() ? storedFocus : undefined;
    storedFocus?.release();
    const changed =
      !reading.admitted ||
      reading.current !== undefined ||
      reading.predecessors.length > 0 ||
      reading.staged !== undefined;
    reading.current = undefined;
    reading.admitted = true;
    reading.predecessors = [];
    delete reading.staged;
    return { changed, ...(focus ? { focus } : {}) };
  }
  if (reading.staged !== undefined && reading.staged.target === cursor) {
    const staged = reading.staged;
    const focus = staged.focus?.eligible() ? staged.focus : undefined;
    staged.focus?.release();
    if (staged.move === 'continue') reading.predecessors = [...reading.predecessors, reading.current].slice(-8);
    else if (staged.move === 'previous') reading.predecessors = reading.predecessors.slice(0, -1);
    else reading.predecessors = [];
    reading.current = cursor;
    reading.admitted = true;
    delete reading.staged;
    return { changed: true, ...(focus ? { focus } : {}) };
  }
  if (!reading.admitted || reading.current !== cursor || reading.staged) {
    releaseReading(reading);
    reading.current = cursor;
    reading.admitted = true;
    reading.predecessors = [];
    delete reading.staged;
    return { changed: true };
  }
  return { changed: false };
}

/** A failed result keeps its exact target and accepted predecessors, but releases a pending focus handoff. */
export function failSavedQueryResultsWindowMove(
  client: QueryClient,
  base: string,
  mode: ResultsWindowMode,
  scope: string,
  cursor: ResultsCursor,
): boolean {
  const reading = visits.get(client)?.readings[mode];
  const staged = reading?.scope === scope ? reading.staged : undefined;
  if (!staged || staged.target !== cursor) return false;
  const changed = !staged.failed || staged.focus !== undefined;
  staged.failed = true;
  staged.focus?.release();
  staged.focus = undefined;
  return changed;
}

export function cancelSavedQueryResultsWindowFocus(
  client: QueryClient,
  base: string,
  mode: ResultsWindowMode,
  scope: string,
  cursor: ResultsCursor,
): boolean {
  const staged = visits.get(client)?.readings[mode];
  if (!staged || staged.scope !== scope || staged.staged?.target !== cursor || !staged.staged.focus) return false;
  staged.staged.focus.release();
  staged.staged.focus = undefined;
  return true;
}

export function hasPendingSavedQueryResultsWindowTarget(
  client: QueryClient,
  base: string,
  mode: ResultsWindowMode,
  cursor: ResultsCursor,
): boolean {
  const visit = visits.get(client);
  const reading = visit?.base === base ? visit.readings[mode] : undefined;
  return reading?.staged !== undefined && reading.staged.target === cursor;
}

export function failPendingSavedQueryResultsWindowMove(
  client: QueryClient,
  base: string,
  mode: ResultsWindowMode,
  cursor: ResultsCursor,
): boolean {
  const staged = visits.get(client)?.base === base ? visits.get(client)?.readings[mode]?.staged : undefined;
  if (!staged || staged.target !== cursor) return false;
  const changed = !staged.failed || staged.focus !== undefined;
  staged.failed = true;
  staged.focus?.release();
  staged.focus = undefined;
  return changed;
}

export function retireSavedQueryResultsWindowReading(client: QueryClient, base: string, mode: ResultsWindowMode): void {
  const visit = visits.get(client);
  if (visit?.base === base) {
    releaseReading(visit.readings[mode]);
    delete visit.readings[mode];
  }
}

export function retireSavedQueryResultsWindows(client: QueryClient): void {
  const visit = visits.get(client);
  if (visit) Object.values(visit.readings).forEach(releaseReading);
  visits.delete(client);
}
