'use client';

import { useState, type ReactNode } from 'react';
import { Button } from './button.tsx';

/** A spoiler contributes no visible or accessible text until the reader chooses to reveal it. */
export function DocumentSpoiler({ children, label }: { children: ReactNode; label: string }) {
  const [revealed, setRevealed] = useState(false);
  return revealed ? <span>{children}</span>
    : <Button size="xs" variant="secondary" onClick={() => setRevealed(true)} aria-expanded="false">{label}</Button>;
}
