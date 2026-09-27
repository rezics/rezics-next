'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useShell } from '../shell/shell-provider.tsx';
import { preferenceCookie } from '../shell/preferences.ts';
import { ZONE_LOOK_COOKIE } from '../zones/execution.ts';
import { loadDisplayPreferences } from './preferences.ts';

/** The cookie paints immediately; after sign-in the account becomes the source of truth. */
export function DisplayPreferenceSync({ userId }: { userId: string }) {
  const { theme, setTheme } = useShell();
  const router = useRouter();
  useEffect(() => {
    let active = true;
    void loadDisplayPreferences().then(value => {
      if (!active || !value) return;
      if (theme !== value.displayMode) setTheme(value.displayMode);
      const current = document.cookie.split('; ').find(part => part.startsWith(`${ZONE_LOOK_COOKIE}=`))?.split('=')[1];
      const next = value.showZoneThemes ? 'zone' : 'standard';
      if (current !== next) {
        document.cookie = preferenceCookie(ZONE_LOOK_COOKIE, next, location.protocol === 'https:');
        router.refresh();
      }
    });
    return () => { active = false; };
  }, [userId]);
  return null;
}
