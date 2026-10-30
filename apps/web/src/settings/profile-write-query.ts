import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect } from 'react';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { csrfHeaders } from '../threads/composer';
import { readProfile, saveProfile } from './actions';
import type { ProfileValues } from './profile-data';
import { ProfileEditor } from './profile-write';

type EditorEntry = { token: string | null; subject: string | null; editor: ProfileEditor; users: number };
const editors = new WeakMap<QueryClient, EditorEntry>();

export function useProfileEditor() {
  const session = useSession();
  const client = useQueryClient();
  const writable = session.state === 'signed-in' && !!session.csrfToken;
  const token = writable ? session.csrfToken : null;
  const subject = writable ? (session.subject ?? null) : null;
  // Session CSRF identity changes with sign-in. No private profile is reused by another session.
  const key = ['settings', 'profile', token, subject] as const;
  let entry = editors.get(client);
  if (!entry || entry.token !== token || entry.subject !== subject) {
    const editor = new ProfileEditor(
      {
        read: async () => {
          await client.cancelQueries({ queryKey: key });
          return readProfile();
        },
        save: async (attempt) => {
          await client.cancelQueries({ queryKey: key });
          return saveProfile({ data: attempt, headers: csrfHeaders() });
        },
        confirmed: (profile) => {
          if (editors.get(client)?.editor === editor) client.setQueryData(key, profile);
        },
      },
      token ? (client.getQueryData<ProfileValues>(key) ?? null) : null,
    );
    entry = { token, subject, editor, users: 0 };
    editors.set(client, entry);
  }
  const editor = entry.editor;
  const isCurrent = useCallback(() => editors.get(client) === entry && !!entry.token, [client, entry]);
  useLayoutEffect(() => {
    entry.users++;
    return () => {
      entry.users--;
      // The profile and activity sections share one mount. Cancelled navigation never releases it.
      // A microtask lets StrictMode reconnect before retiring the last consumer's private draft.
      queueMicrotask(() => {
        if (entry.users === 0 && editors.get(client) === entry) editors.delete(client);
      });
    };
  }, [client, entry]);
  const query = useQuery({
    ...personalRead,
    queryKey: key,
    queryFn: () => readProfile(),
    enabled: personalRead.enabled && writable,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useLayoutEffect(() => {
    if (query.isError || (session.state !== 'unknown' && !writable)) editor.unavailable();
    else if (writable && query.data) editor.receive(query.data);
  }, [editor, query.data, query.isError, session.state, writable]);
  return { editor, writable, isCurrent };
}
