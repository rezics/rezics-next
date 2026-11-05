import { hashKey, QueryObserver, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { personalRead } from '../kernel/query';
import { sessionQuery, useSession } from '../session/query';
import { readProfile, saveProfile } from './actions';
import { profileReadValue } from './profile-data';
import { ProfileEditorSession } from './profile-write';

type EditorEntry = {
  owner: ProfileEditorSession;
  users: number;
  attached: boolean;
  retired: boolean;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => boolean;
  current: () => boolean;
  observationCurrent: () => boolean;
  release?: () => void;
  readError?: { value: unknown };
};
const editors = new WeakMap<QueryClient, EditorEntry>();

function readUnavailable(entry: EditorEntry, error: unknown) {
  if (entry.retired || (entry.readError && entry.readError.value === error)) return;
  entry.readError = { value: error };
  entry.owner.editor.unavailable(error);
}

function retire(client: QueryClient, entry: EditorEntry) {
  if (entry.retired) return;
  // Revoke before cancellation, removal, abort handlers or subscriber reentry.
  entry.retired = true;
  entry.release?.();
  delete entry.release;
  if (editors.get(client) === entry) editors.delete(client);
  entry.owner.retire();
  // Every observation has a fresh private key. Old cleanup cannot target a successor.
  void client.cancelQueries({ queryKey: entry.owner.key, exact: true });
  client.removeQueries({ queryKey: entry.owner.key, exact: true });
  entry.listeners.forEach((listener) => listener());
}

function createEntry(client: QueryClient) {
  const sessionRecord = client.getQueryCache().get(hashKey(sessionQuery.queryKey));
  const sessionState = client.getQueryState(sessionQuery.queryKey);
  // These detect a committed success in the render-to-attachment gap, including structural sharing.
  const successes = sessionState?.dataUpdateCount;
  const observed =
    sessionState?.status === 'success' && sessionState.data
      ? sessionState.data
      : { state: sessionState?.status === 'error' ? 'unavailable' : 'unknown', csrfToken: null };
  let entry: EditorEntry | undefined;
  const observationCurrent = () => {
    const attached = entry;
    if (!attached || attached.retired) return false;
    const query = client.getQueryCache().get(hashKey(sessionQuery.queryKey));
    const state = client.getQueryState(sessionQuery.queryKey);
    return (
      editors.get(client) === attached &&
      query === sessionRecord &&
      state?.dataUpdateCount === successes &&
      (state?.status === 'success'
        ? owner.matches(state.data)
        : owner.matches({ state: state?.status === 'error' ? 'unavailable' : 'unknown', csrfToken: null }))
    );
  };
  // The constructor may mark an unreadable observation unavailable before it is attached.
  const current = () => !entry || (entry.users > 0 && owner.isCurrent() && observationCurrent());
  const owner = new ProfileEditorSession(observed, (owner) => {
    const read = async () => {
      if (!current()) throw new Error('Profile unavailable');
      const profile = profileReadValue(await readProfile());
      if (!current()) throw new Error('Profile unavailable');
      if (profile.accountId !== owner.reader?.subject) throw new Error('Profile account changed');
      return profile;
    };
    return {
      isCurrent: current,
      read: async () => {
        await client.cancelQueries({ queryKey: owner.key, exact: true });
        return read();
      },
      save: async (attempt) => {
        await client.cancelQueries({ queryKey: owner.key, exact: true });
        if (!current() || !owner.canWrite()) throw new Error('Profile unavailable');
        const commandProfile = (value: typeof attempt.before) => ({
          accountId: value.accountId,
          kind: value.kind,
          displayName: value.displayName,
          biography: value.biography,
          avatar: value.avatar,
          links: value.links,
          publicViews: value.publicViews,
          ...(value.kind === 'organization' && value.speakersListed !== undefined
            ? { speakersListed: value.speakersListed }
            : {}),
        });
        return saveProfile({
          data: {
            before: commandProfile(attempt.before),
            after: commandProfile(attempt.after),
            idempotencyKey: attempt.idempotencyKey,
          },
          headers: { 'X-CSRF-Token': owner.actor?.incarnation ?? '' },
        });
      },
      canWrite: () => current() && owner.canWrite(),
      confirmed: (profile) => {
        if (current()) client.setQueryData(owner.key, profile);
      },
    };
  });
  const listeners = new Set<() => void>();
  const attached: EditorEntry = {
    owner,
    users: 0,
    attached: false,
    retired: false,
    listeners,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => attached.retired,
    current,
    observationCurrent,
  };
  entry = attached;
  editors.set(client, attached);
  return attached;
}

export function useProfileEditor() {
  useSession();
  const client = useQueryClient();
  const previous = useRef<{ client: QueryClient; entry: EditorEntry } | null>(null);
  // Provider replacement revokes rendered callbacks during render, before layout cleanup or an await resumes.
  if (previous.current && previous.current.client !== client) retire(previous.current.client, previous.current.entry);
  let cached = editors.get(client);
  const state = client.getQueryState(sessionQuery.queryKey);
  const observed =
    state?.status === 'success' && state.data
      ? state.data
      : { state: state?.status === 'error' ? 'unavailable' : 'unknown', csrfToken: null };
  if (
    cached &&
    ((cached.attached && cached.users === 0) || !cached.observationCurrent() || !cached.owner.matches(observed))
  ) {
    retire(client, cached);
    cached = undefined;
  }
  // Keep the attachment check with its original entry rather than creating another session authority.
  const entry = cached ?? createEntry(client);
  previous.current = { client, entry };
  const { owner } = entry;
  useSyncExternalStore(entry.subscribe, entry.snapshot, entry.snapshot);
  useLayoutEffect(() => {
    entry.users++;
    entry.attached = true;
    if (!entry.observationCurrent()) retire(client, entry);
    if (!entry.retired && !entry.release) {
      const profileHash = hashKey(owner.key);
      const sessionHash = hashKey(sessionQuery.queryKey);
      const unsubscribe = client.getQueryCache().subscribe((event) => {
        if (entry.retired) return;
        if (event.query.queryHash === profileHash) {
          if (event.type === 'removed') retire(client, entry);
          else if (event.type === 'updated' && event.action.type === 'error' && event.query.state.status === 'error')
            readUnavailable(entry, event.query.state.error);
          return;
        }
        if (event.query.queryHash !== sessionHash) return;
        // Query.setData dispatches success for manual writes AND completed fetches, even if data and time are equal.
        // Observer notifications and fetch/failed/pause/continue/invalidate/setState do not commit a new result.
        if (
          event.type === 'removed' ||
          (event.type === 'updated' && event.action.type === 'success') ||
          !entry.observationCurrent()
        )
          retire(client, entry);
      });
      entry.release = unsubscribe;
    }
    return () => {
      entry.users--;
      // No action is admitted with zero attachments. StrictMode may reconnect within this turn.
      queueMicrotask(() => {
        if (entry.users === 0) retire(client, entry);
      });
    };
  }, [client, entry, owner]);
  const readable = !entry.retired && owner.canRead();
  const writable = !entry.retired && owner.canWrite();
  // useQuery retains its constructor's client. This observer instead belongs to the attached source,
  // so a provider replacement cannot build the successor's private query in the previous cache.
  const observer = useMemo(
    () =>
      new QueryObserver(client, {
        ...personalRead,
        queryKey: owner.key,
        queryFn: async () => {
          if (!entry.current()) throw new Error('Profile unavailable');
          const profile = profileReadValue(await readProfile());
          if (!entry.current()) throw new Error('Profile unavailable');
          if (profile.accountId !== owner.reader?.subject) throw new Error('Profile account changed');
          return profile;
        },
        enabled: personalRead.enabled && readable,
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      }),
    [client, entry, owner, readable],
  );
  const subscribeQuery = useCallback((listener: () => void) => observer.subscribe(listener), [observer]);
  const query = useSyncExternalStore(
    subscribeQuery,
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  );
  useLayoutEffect(() => {
    if (query.isError) readUnavailable(entry, query.error);
    else if (readable && query.data) owner.editor.receive(query.data);
  }, [owner, entry, query.data, query.isError, query.error, readable]);
  return { editor: owner.editor, readable, writable, isCurrent: entry.current, observationKey: owner.key[4] };
}
