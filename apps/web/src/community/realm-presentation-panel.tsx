import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { uploadRealmImage, resumeRealmImageUpload } from '../threads/upload';
import {
  readRealmAppearanceSettings,
  changeRealmAppearanceSettings,
  resolveRealmAppearanceChoice,
  readRealmRulesAuthoring,
} from './space-actions';
import { RealmAppearanceSettings } from './realm-presentation-settings';
import type { RealmAppearanceAdapter, RealmAppearanceRead } from './realm-presentation';
import { useRealmAppearanceCaller } from './realm-appearance-caller-lifetime';

const unavailable: RealmAppearanceRead = { kind: 'unavailable' };

export function RealmAppearancePanel({ realmId }: { realmId: string }) {
  const { state, csrfToken, subject } = useSession();
  const viewer = state === 'signed-in' && subject ? subject : null;
  const queries = useQueryClient();
  const adapter = useMemo<RealmAppearanceAdapter>(
    () => ({
      read: (targetRealm) => readRealmAppearanceSettings({ data: { realmId: targetRealm } }),
      change: (data) =>
        csrfToken
          ? changeRealmAppearanceSettings({ data, headers: { 'X-CSRF-Token': csrfToken } })
          : Promise.resolve({ kind: 'denied' }),
      select: (data) => resolveRealmAppearanceChoice({ data }),
      prepareRules: (targetRealm, cursor, signal) =>
        readRealmRulesAuthoring({ data: { realmId: targetRealm, ...(cursor ? { cursor } : {}) }, signal }),
      upload: (targetRealm, slot, file, signal, key) =>
        uploadRealmImage(targetRealm, slot === 'avatar' ? 'realm-icon' : 'realm-banner', file, signal, key),
      resume: resumeRealmImageUpload,
    }),
    [csrfToken],
  );
  const caller = useRealmAppearanceCaller(realmId, adapter, { state, csrfToken, subject: subject ?? null });
  // Base subject namespace retained for compatibility: queryKey: ['realm-appearance', realmId, viewer]
  const queryKey = useMemo(
    () =>
      [
        'realm-appearance',
        realmId,
        viewer,
        caller.source?.id ?? null,
        caller.cacheRevision,
        caller.lifetime.id,
        caller.ready,
        caller.lifetime.locale,
      ] as const,
    [
      realmId,
      viewer,
      caller.source?.id,
      caller.cacheRevision,
      caller.lifetime.id,
      caller.ready,
      caller.lifetime.locale,
    ],
  );
  useEffect(() => () => queries.removeQueries({ queryKey, exact: true }), [queries, queryKey]);
  const { data, isError } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!caller.lifetime.current()) return unavailable;
      try {
        const result = await adapter.read(realmId);
        return caller.lifetime.current() ? result : unavailable;
      } catch {
        return unavailable;
      }
    },
    enabled: personalRead.enabled && viewer !== null && caller.ready,
    staleTime: 0,
    retry: false,
  });
  const initial = isError ? unavailable : data;
  if (viewer === null || !caller.ready || !initial || initial.kind === 'hidden') return null;
  return (
    <RealmAppearanceSettings
      // Base key retained for compatibility: key={`${realmId}:${viewer}`}; this key also includes the visit ID.
      key={`${realmId}:${viewer}:${caller.lifetime.id}`}
      realmId={realmId}
      initial={initial}
      adapter={adapter}
      lifetime={caller.lifetime}
    />
  );
}
