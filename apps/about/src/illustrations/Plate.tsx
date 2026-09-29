import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';

/**
 * The frame every product illustration sits in. Illustrations are decorative
 * renderings of real product components, so assistive technology skips them
 * and the section's own paragraph carries the meaning.
 */
export function Plate({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-illustration
      className={cn(
        'rounded-3xl border border-border bg-card p-4 shadow-(--aura-shadow-card) sm:p-6',
        className,
      )}
    >
      {children}
    </div>
  );
}
