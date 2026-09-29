import { cn } from '@rezics/ui/utils';
import type { ReactNode } from 'react';

/**
 * The panel a product illustration floats in: a piece of real Rezics UI on the page.
 * Illustrations are decorative renderings of product components, so assistive
 * technology skips them and the section's own text carries the meaning.
 */
export function Plate({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-illustration
      className={cn(
        'w-full rounded-[1.75rem] border border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float) sm:p-6',
        className,
      )}
    >
      {children}
    </div>
  );
}
