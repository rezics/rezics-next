import { readAccountProfile, saveAccountProfile } from './actions';
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionQuery, useSession } from '../../session/query';
import { useSettingsAmbient } from '../../settings/adapters/ambient-view.tsx';
import type { AccountSession } from '../../settings/ports/accounts';
import type { AccountProfileRuntime, ProfileSessionLease } from './ports';

function useProfileSession() {
  const session = useSession();
  const client = useQueryClient();
  const ambient = useSettingsAmbient();
  const record = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  const revision = record?.state.dataUpdateCount;
  const observation = useMemo(() => ambient.id(), [ambient, client, record, revision]);
  return {
    session,
    observation,
    bind(viewerId: string, csrfToken: string): ProfileSessionLease {
      const original = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      const originalRevision = original?.state.dataUpdateCount;
      let attachments = 0;
      const current = () => {
        const latest = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
        if (!attachments || !original || latest !== original || latest.state.status !== 'success') return false;
        const value = latest.state.data as AccountSession;
        return (
          latest.state.dataUpdateCount === originalRevision &&
          value.state === 'signed-in' &&
          value.subject === viewerId &&
          value.csrfToken === csrfToken
        );
      };
      return {
        isCurrent: current,
        attach(retire) {
          attachments++;
          if (!current()) retire();
          const unsubscribe = client.getQueryCache().subscribe(() => {
            if (!current()) retire();
          });
          return () => {
            attachments--;
            unsubscribe();
            // StrictMode reconnects synchronously; detached callbacks remain refused throughout the gap.
            queueMicrotask(() => {
              if (!attachments) retire();
            });
          };
        },
      };
    },
  };
}

export const nativeAccountProfileRuntime: AccountProfileRuntime = {
  useSession: useProfileSession,
  read: (data, signal) => readAccountProfile({ data, ...(signal ? { signal } : {}) }),
  save: (data, csrfToken, signal) =>
    saveAccountProfile({
      data,
      headers: { 'X-CSRF-Token': csrfToken },
      ...(signal ? { signal } : {}),
    }),
};
