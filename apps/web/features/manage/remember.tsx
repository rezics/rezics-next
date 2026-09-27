'use client';

import { Button } from '@rezics/ui/button';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { forget, readRememberedCookie, remember, writeRemembered } from './remembered.ts';

/** Adds the Realm to this device's list once its management opened. */
export function RememberRealm({ realm }: { realm: string }) {
  useEffect(() => { writeRemembered(remember(readRememberedCookie(), realm)); }, [realm]);
  return null;
}

/** Takes a Realm off this device's list. */
export function ForgetRealm({ realm, label, name }: { realm: string; label: string; name: string }) {
  const router = useRouter();
  return <Button variant="ghost" size="sm" aria-label={name} onClick={() => {
    writeRemembered(forget(readRememberedCookie(), realm));
    router.refresh();
  }}>{label}</Button>;
}
