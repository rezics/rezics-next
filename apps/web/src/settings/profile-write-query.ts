import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect } from 'react';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { csrfHeaders } from '../threads/composer';
import { readProfile, saveProfile } from './actions';
import type { ProfileValues } from './profile-data';
import { ProfileEditor } from './profile-write';

const editors = new WeakMap<QueryClient, { token: string | null; editor: ProfileEditor }>();

export function useProfileEditor() {
  const session = useSession();
  const client = useQueryClient();
  const token = session.csrfToken;
  // Session CSRF identity changes with sign-in. No private profile is reused by another session.
  const key = ['settings', 'profile', token] as const;
  let entry = editors.get(client);
  if (!entry || entry.token !== token) {
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
        confirmed: (profile) => client.setQueryData(key, profile),
      },
      token ? (client.getQueryData<ProfileValues>(key) ?? null) : null,
    );
    entry = { token, editor };
    editors.set(client, entry);
  }
  const editor = entry.editor;
  const writable = session.state === 'signed-in' && !!token;
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
    else if (query.data) editor.receive(query.data);
  }, [editor, query.data, query.isError, session.state, writable]);
  return { editor, writable };
}
