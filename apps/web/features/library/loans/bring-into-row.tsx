'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The shelf list is a sideways row on a phone. Keep the shelf the reader is
 * on inside that row, and leave a wide screen's column where it is.
 */
export function BringIntoRow({ active, children }: { active: boolean; children: ReactNode }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return <li ref={ref}>{children}</li>;
}
