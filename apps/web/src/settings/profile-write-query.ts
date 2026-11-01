import { hashKey, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect } from 'react';
import { personalRead } from '../kernel/query';
import { sessionQuery, useSession } from '../session/query';
import { readProfile, saveProfile } from './actions';
import { profileReadValue } from './profile-data';
import { ProfileEditorSession } from './profile-write';

type EditorEntry = {
  owner: ProfileEditorSession;
  users: number;
  release?: () => void;
  readError?: { value: unknown };
};
const editors = new WeakMap<QueryClient, EditorEntry>();

function readUnavailable(entry: EditorEntry, error: unknown) {
  if (entry.readError && entry.readError.value === error) return;
  entry.readError = { value: error };
  entry.owner.editor.unavailable(error);
}

function retire(client: QueryClient, entry: EditorEntry) {
  entry.release?.();
  delete entry.release;
  entry.owner.retire();
  if (editors.get(client) === entry) editors.delete(client);
  // Only this observation's query and callbacks belong to us.
  void client.cancelQueries({ queryKey: entry.owner.key, exact: true });
  client.removeQueries({ queryKey: entry.owner.key, exact: true });
}

export function useProfileEditor() {
  useSession();
  const client = useQueryClient();
  const sessionState = client.getQueryState(sessionQuery.queryKey);
  const observed =
    sessionState?.status === 'success' && sessionState.data
      ? sessionState.data
      : { state: sessionState?.status === 'error' ? 'unavailable' : 'unknown', csrfToken: null };
  let entry = editors.get(client);
  if (!entry || !entry.owner.matches(observed)) {
    if (entry) retire(client, entry);
    const owner = new ProfileEditorSession(observed, (owner) => {
      const current = () => {
        const query = client.getQueryState(sessionQuery.queryKey);
        return (
          owner.isCurrent() &&
          editors.get(client)?.owner === owner &&
          query?.status === 'success' &&
          owner.matches(query.data)
        );
      };
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
          // Replay belongs to these original credentials, never an imperative transport's newer token.
          return saveProfile({ data: attempt, headers: { 'X-CSRF-Token': owner.actor?.incarnation ?? '' } });
        },
        canWrite: () => current() && owner.canWrite(),
        confirmed: (profile) => {
          if (current()) client.setQueryData(owner.key, profile);
        },
      };
    });
    entry = { owner, users: 0 };
    editors.set(client, entry);
  }
  const { owner } = entry;
  const editor = owner.editor;
  const readable = owner.canRead();
  const writable = owner.canWrite();
  const isCurrent = useCallback(() => {
    const query = client.getQueryState(sessionQuery.queryKey);
    return (
      editors.get(client) === entry && owner.isCurrent() && query?.status === 'success' && owner.matches(query.data)
    );
  }, [client, entry, owner]);
  useLayoutEffect(() => {
    entry.users++;
    if (!entry.release) {
      const profileHash = hashKey(owner.key);
      const sessionHash = hashKey(sessionQuery.queryKey);
      entry.release = client.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === profileHash) {
          if (event.type === 'removed') {
            if (editors.get(client) === entry) retire(client, entry);
            return;
          }
          // Observe delivered query failures, never a cancelled request's later transport completion.
          if (event.type === 'updated' && event.action.type === 'error' && event.query.state.status === 'error')
            readUnavailable(entry, event.query.state.error);
          return;
        }
        if (event.query.queryHash !== sessionHash) return;
        const query = client.getQueryState(sessionQuery.queryKey);
        if (query?.status !== 'success' || !owner.matches(query.data)) retire(client, entry);
      });
    }
    return () => {
      entry.users--;
      // Let StrictMode reconnect before releasing the last consumer's private observation.
      queueMicrotask(() => {
        if (entry.users === 0) retire(client, entry);
      });
    };
  }, [client, entry, owner]);
  const query = useQuery({
    ...personalRead,
    queryKey: owner.key,
    queryFn: async () => {
      if (!isCurrent()) throw new Error('Profile unavailable');
      const profile = profileReadValue(await readProfile());
      if (!isCurrent()) throw new Error('Profile unavailable');
      if (profile.accountId !== owner.reader?.subject) throw new Error('Profile account changed');
      return profile;
    },
    enabled: personalRead.enabled && readable,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useLayoutEffect(() => {
    if (query.isError) readUnavailable(entry, query.error);
    else if (readable && query.data) editor.receive(query.data);
  }, [editor, entry, query.data, query.isError, query.error, readable]);
  return { editor, readable, writable, isCurrent };
}
