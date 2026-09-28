'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/** A cached root layout must follow the session of the newly loaded page. */
export function useSessionSync(signedIn: boolean): void {
  const pathname = usePathname();
  const router = useRouter();
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (pathname === previousPath.current) return;
    previousPath.current = pathname;
    const controller = new AbortController();
    void fetch('/auth/session', { cache: 'no-store', signal: controller.signal })
      .then(response => {
        if ((response.status === 204 && !signedIn) || (response.status === 401 && signedIn)) {
          router.refresh();
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [pathname, router, signedIn]);
}
