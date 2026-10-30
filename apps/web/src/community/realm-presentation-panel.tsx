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
import type { RealmAppearanceAdapter } from './realm-presentation';

export function RealmAppearancePanel({ realmId }: { realmId: string }) {
  const { state, csrfToken } = useSession();
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
  const { data } = useQuery({
    queryKey: ['realm-appearance', realmId],
    queryFn: () => adapter.read(realmId),
    enabled: personalRead.enabled && state === 'signed-in',
    staleTime: 0,
    retry: false,
  });
  if (state !== 'signed-in' || !data || data.kind === 'hidden') return null;
  return <RealmAppearanceSettings key={realmId} realmId={realmId} initial={data} adapter={adapter} />;
}
