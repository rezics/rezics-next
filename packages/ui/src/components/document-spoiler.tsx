import { useState, type ReactNode } from 'react';

export function DocumentSpoiler({ children, label = 'Reveal spoiler' }: { children: ReactNode; label?: string }) {
  const [revealed, setRevealed] = useState(false);
  return revealed ? (
    <span>{children}</span>
  ) : (
    <button type="button" aria-expanded="false" onClick={() => setRevealed(true)}>
      {label}
    </button>
  );
}
