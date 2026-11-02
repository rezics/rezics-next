import { createContext, useMemo, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import { operationIsAdmitted } from '../kernel/exposure';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { personalLibraryAddress, type PersonalLibraryAddress } from './personal-library-server';
import { validateShelfSearch } from './shelf-params';

type Operation = Parameters<typeof operationIsAdmitted>[0];
const operations = [
  'library_entry.list',
  'progress_session.list',
  'library_continue.list',
  'library_entry.put',
  'library_entry.delete',
  'library_entry.restore',
  'library_label.list',
  'library_label.assign',
  'library_label.unassign',
  'library_label.assignment_list',
  'library_operation.preview',
  'library_operation.confirm',
  'library_operation.get',
  'library_operation.outcomes',
  'copy.list',
] as const satisfies readonly Operation[];
export type ShelfOrigin = {
  current: () => boolean;
  viewer: () => string | null;
  capture: (...operations: Operation[]) => () => boolean;
  version: (...operations: Operation[]) => string;
  watch: (listener: () => void) => () => void;
  headers: () => Headers;
  epoch?: (...operations: Operation[]) => string;
  retains?: (...operations: Operation[]) => boolean;
};
export const PersonalShelfOrigin = createContext<ShelfOrigin | null>(null);

/** Local to the personal Shelf: observe replacements at the cache/navigation boundary, before React commits. */
export function usePersonalShelfObservation(address: PersonalLibraryAddress) {
  const { store } = useLibraryWorkspaceAdmission(operations);
  const router = useRouter();
  const observation = useMemo(() => {
    let bound = JSON.stringify(address);
    let actual = bound;
    let locale = address.locale;
    let previous: { actor: string; admitted: boolean[] } | undefined;
    let value = {
      scope: 0,
      subject: null as string | null,
      versions: operations.map(() => 0),
      dispatch: operations.map(() => 0),
      admitted: operations.map(() => false),
    };
    const listeners = new Set<() => void>();
    const read = () => {
      const scoped = store.read();
      const subject = scoped.subject;
      const admitted = scoped.allowed;
      // A nonempty token rotation belongs to the same viewer; loss and subsequent restoration does not.
      const actor = JSON.stringify([subject, scoped.viewer, actual]);
      if (
        !previous ||
        previous.actor !== actor ||
        admitted.some((allowed, i) => allowed !== previous!.admitted[i]) ||
        scoped.episodes.some((v, i) => v !== value.versions[i]) ||
        scoped.dispatch.some((v, i) => v !== value.dispatch[i])
      ) {
        value = {
          scope: value.scope + (previous && previous.actor !== actor ? 1 : 0),
          subject,
          versions: scoped.episodes,
          dispatch: scoped.dispatch,
          admitted,
        };
        previous = { actor, admitted };
      }
      return value;
    };
    const server = value;
    const changed = () => {
      const before = value;
      read();
      if (before !== value) listeners.forEach((listener) => listener());
    };
    return {
      read,
      server: () => server,
      bind: (next: PersonalLibraryAddress) => {
        const key = JSON.stringify(next);
        if (key === bound) return;
        bound = key;
        actual = key;
        locale = next.locale;
        read();
      },
      at: (expected: PersonalLibraryAddress) => actual === JSON.stringify(expected),
      epoch: (...ops: Operation[]) => ops.map((op) => store.dispatchVersion(op)).join(':'),
      retains: (...ops: Operation[]) =>
        ops.every((op) => store.read().granted[operations.indexOf(op as (typeof operations)[number])]),
      version: (...ops: Operation[]) =>
        ops.map((op) => value.versions[operations.indexOf(op as (typeof operations)[number])]).join(':'),
      allowed: (...ops: Operation[]) =>
        ops.every((op) => value.admitted[operations.indexOf(op as (typeof operations)[number])]),
      headers: () => new Headers(store.headers(store.read().subject) ?? {}),
      watch: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        read();
        const cache = store.watch(changed);
        const navigation = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
          const url = new URL(toLocation.publicHref, 'https://shelf.invalid');
          const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
          const shelf = parts.at(-1) === 'library' && parts.length <= 2;
          const input = validateShelfSearch(Object.fromEntries(url.searchParams));
          actual =
            shelf && !input.label
              ? JSON.stringify(personalLibraryAddress(input, parts.length === 2 ? parts[0]! : locale))
              : toLocation.publicHref;
          changed();
        });
        return () => {
          listeners.delete(notify);
          cache();
          navigation();
        };
      },
    };
  }, [store, router]);
  observation.bind(address);
  const value = useSyncExternalStore(observation.subscribe, observation.read, observation.server);
  return { observation, value };
}
