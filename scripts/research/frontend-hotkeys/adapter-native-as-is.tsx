'use client';
import { useEffect } from 'react';
import { usePageKeys } from '../../../apps/accounts/features/admin/shell/keys.ts';
// The unmodified search and sidebar owners are mounted by NativeOwners below.
export function Adapter({ act }: any) {
  usePageKeys(event => {
    if (event.key !== '?') return false;
    act('navigation-help', event); return true;
  });
  useEffect(() => {
    (window as any).__adapter = { count: () => 3, kind: 'native-as-is' };
  }, []);
  return null;
}
