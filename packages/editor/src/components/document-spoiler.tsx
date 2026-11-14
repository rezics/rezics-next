import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';

const useIsoLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export function DocumentSpoiler({
  children,
  label = 'Reveal spoiler',
  initialRevealed = false,
  onReveal,
}: {
  children: ReactNode;
  label?: string;
  initialRevealed?: boolean;
  onReveal?: () => void;
}) {
  const [revealed, setRevealed] = useState(initialRevealed);
  const place = useRef<HTMLSpanElement>(null);
  const reveal = () => {
    onReveal?.();
    setRevealed(true);
  };

  // Replacing the button would drop focus onto the document and scroll to the top.
  useIsoLayoutEffect(() => {
    if (!revealed) return;
    place.current?.focus({ preventScroll: true });
  }, [revealed]);

  if (revealed) {
    return (
      <span ref={place} tabIndex={-1} className="document-spoiler-revealed">
        {children}
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant={null}
      size={null}
      className="document-spoiler"
      aria-expanded="false"
      aria-label={label}
      onClick={reveal}
      onKeyDown={(event) => {
        // Storybook's keyboard helper reports Space as the key name, not " ".
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Space' || event.code === 'Space') {
          event.preventDefault();
          reveal();
        }
      }}
    >
      <span aria-hidden="true" style={{ visibility: 'hidden' }}>
        {children}
      </span>
    </Button>
  );
}
