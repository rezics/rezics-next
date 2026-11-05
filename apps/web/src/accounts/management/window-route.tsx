import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useReducer, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import { browserObservation } from '../../session';
import { getLocale } from '../../paraglide/runtime.js';
import type { Cursors, Detail, Inventory, Page } from './data';
import { ManagementWindow, type Feed, type Movement } from './window';

export type WindowRead<T> = { page: Page<T>; reader: number | null; scope: string };

/** Stamp client work before dispatch; an A/B/A session can never admit the former A's response. */
export async function readManagementWindow<T>(
  client: QueryClient,
  target: string,
  read: () => Promise<Page<T>>,
): Promise<WindowRead<T>> {
  const observation = browserObservation(client).getSnapshot();
  const reader = observation.state === 'signed-in' ? observation.observation.id : null;
  const scope = `${getLocale()}:${target}`;
  return { page: await read(), reader, scope };
}

export type WindowNavigation = {
  previous: (field: Feed) => { cursor: string | undefined } | undefined;
  move: (event: MouseEvent<HTMLAnchorElement>, field: Feed, cursor: string | undefined, movement: Movement) => void;
};

/** Search navigation retains this owner, unlike the former full-document Next anchors. */
export function useManagementWindow<T extends Inventory | Detail>({
  read,
  cursors,
  target,
  navigate,
  retry,
}: {
  read: WindowRead<T>;
  cursors: Cursors;
  target: string;
  navigate: (cursors: Cursors) => void;
  retry: () => void;
}) {
  const observation = browserObservation(useQueryClient());
  const snapshot = useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getServerSnapshot);
  const reader = snapshot.state === 'signed-in' ? snapshot.observation.id : null;
  const scope = `${getLocale()}:${target}`;
  const key = `${scope}:${reader}`;
  const [, render] = useReducer((value: number) => value + 1, 0);
  const bootstrap = useRef(new WeakSet<object>(read.reader === null ? [read] : []));
  const owner = useRef<{
    key: string;
    history: ManagementWindow;
    initial: WeakSet<object>;
    hydrated: boolean;
    attached: boolean;
    retired: boolean;
    signedOut?: boolean;
    handoff?: { control: HTMLElement; field: Feed; cancel: () => void };
  } | null>(null);
  const retire = () => {
    if (!owner.current) return;
    owner.current.retired = true;
    owner.current.history.retire();
    owner.current.handoff?.cancel();
    owner.current.handoff = undefined;
  };
  if (!owner.current || owner.current.key !== key) {
    const hydrated = bootstrap.current.has(read) && (snapshot.state === 'unknown' || snapshot.state === 'signed-in');
    if (reader !== null || snapshot.state === 'signed-out') bootstrap.current = new WeakSet();
    retire();
    owner.current = {
      key,
      history: new ManagementWindow(cursors),
      initial: new WeakSet([read]),
      hydrated,
      attached: false,
      retired: false,
    };
  }
  const visit = owner.current;
  const current = () => !visit.retired && observation.getSnapshot() === snapshot;
  const accepted =
    current() &&
    read.scope === scope &&
    ((reader !== null && read.reader === reader) ||
      (visit.hydrated && visit.initial.has(read) && read.reader === null));
  const page: Page<T> = visit.signedOut
    ? { state: 'signed-out' }
    : accepted
      ? read.page
      : { state: snapshot.state === 'signed-out' ? 'signed-out' : 'unavailable' };
  const admitted = (field: Feed) => {
    if (page.state !== 'ready') return false;
    const value = page.value;
    if (field === 'organizationsCursor' && 'organizations' in value) return value.organizations.state === 'ready';
    if (field === 'membersCursor' && 'members' in value) return value.members.state === 'ready';
    return true;
  };
  const handoff = (control: HTMLElement, field: Feed) => {
    visit.handoff?.cancel();
    const moved = (event: FocusEvent) => {
      if (event.target !== control) {
        visit.handoff?.cancel();
        visit.handoff = undefined;
      }
    };
    document.addEventListener('focusin', moved);
    visit.handoff = { control, field, cancel: () => document.removeEventListener('focusin', moved) };
  };
  useLayoutEffect(() => {
    if (!current()) return;
    if (accepted && page.state === 'signed-out') {
      visit.signedOut = true;
      retire();
      render();
    }
    if (accepted && page.state === 'ready') {
      visit.history.admit(cursors, admitted);
      const focus = visit.handoff;
      if (focus && admitted(focus.field)) {
        const region = document.querySelector<HTMLElement>(`[data-management-feed="${focus.field}"]`);
        const owns =
          document.activeElement === focus.control ||
          (!focus.control.isConnected && document.activeElement === document.body);
        focus.cancel();
        visit.handoff = undefined;
        if (owns) region?.focus();
      }
      render();
    }
  }, [read, cursors, visit, accepted]);
  useLayoutEffect(() => {
    visit.attached = true;
    const release = observation.subscribe(() => {
      if (observation.getSnapshot() !== snapshot) {
        visit.retired = true;
        visit.history.retire();
        visit.handoff?.cancel();
        visit.handoff = undefined;
      }
    });
    return () => {
      release();
      visit.attached = false;
      queueMicrotask(() => {
        if (visit.attached) return;
        visit.retired = true;
        visit.history.retire();
        visit.handoff?.cancel();
        visit.handoff = undefined;
      });
    };
  }, [visit]);
  const navigation: WindowNavigation = {
    previous: (field) => visit.history.previous(field),
    move: (event, field, cursor, movement) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (!visit.attached || !current()) return;
      if (event.detail === 0 && document.activeElement === event.currentTarget) handoff(event.currentTarget, field);
      else {
        visit.handoff?.cancel();
        visit.handoff = undefined;
      }
      navigate(visit.history.request(field, cursor, movement, cursors));
    },
  };
  return {
    page,
    navigation,
    retry: (event?: MouseEvent<HTMLElement>) => {
      if (!visit.attached || !current()) return;
      const field = visit.history.pendingField();
      if (field && event?.detail === 0 && document.activeElement === event.currentTarget)
        handoff(event.currentTarget, field);
      retry();
    },
  };
}
