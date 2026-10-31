import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { uploadRealmImage, resumeRealmImageUpload } from '../threads/upload';
import {
  readRealmAppearanceSettings,
  changeRealmAppearanceSettings,
  resolveRealmAppearanceChoice,
} from './space-actions';
import { RealmAppearanceSettings } from './realm-presentation-settings';
import type { RealmAppearanceAdapter, RealmAppearanceRead } from './realm-presentation';

const unavailable: RealmAppearanceRead = { kind: 'unavailable' };

export function RealmAppearancePanel({ realmId }: { realmId: string }) {
  const { state, csrfToken, subject } = useSession();
  const viewer = state === 'signed-in' && subject ? subject : null;
  const adapter = useMemo<RealmAppearanceAdapter>(
    () => ({
      read: (realmId) => readRealmAppearanceSettings({ data: { realmId } }),
      change: (data) =>
        csrfToken
          ? changeRealmAppearanceSettings({ data, headers: { 'X-CSRF-Token': csrfToken } })
          : Promise.resolve({ kind: 'denied' }),
      select: (data) => resolveRealmAppearanceChoice({ data }),
      upload: (realmId, slot, file, signal) =>
        uploadRealmImage(realmId, slot === 'avatar' ? 'realm-icon' : 'realm-banner', file, signal),
      resume: resumeRealmImageUpload,
    }),
    [csrfToken],
  );
  const { data, isError } = useQuery({
    queryKey: ['realm-appearance', realmId, viewer],
    queryFn: () => adapter.read(realmId),
    enabled: personalRead.enabled && viewer !== null,
    staleTime: 0,
    retry: false,
  });
  const initial = isError ? unavailable : data;
  if (viewer === null || !initial || initial.kind === 'hidden') return null;
  return <RealmAppearanceSettings key={`${realmId}:${viewer}`} realmId={realmId} initial={initial} adapter={adapter} />;
}
