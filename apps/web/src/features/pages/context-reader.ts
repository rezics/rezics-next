import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';

/** Cache identity is separate from permission. Every BFF read still prepares and verifies its current credential. */
export function subjectReaderPartition(
  realm: string | undefined,
  initial: string | null,
  session: { state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable'; subject?: string | null },
): string | null {
  if (!realm) return null;
  if (session.state === 'unknown') return initial;
  if (session.state === 'signed-out') return null;
  return session.state === 'signed-in' && session.subject ? session.subject : 'unavailable';
}

/** Retire the entire old route frame and head while another account's current reading is loaded. */
export function useSubjectReaderRefresh(initial: string | null, current: string | null): boolean {
  const router = useRouter();
  useEffect(() => {
    if (initial !== current) void router.invalidate();
  }, [initial, current, router]);
  return initial === current;
}
