import type { ComponentPropsWithoutRef, ComponentPropsWithRef, ReactNode } from 'react';
import { cn } from '@rezics/ui/utils';

/** Official card surface. Radius and ring follow the shared theme tokens. */
export const authPanelClass =
  'rounded-lg bg-card p-4 text-card-foreground ring-1 ring-foreground/10 [overflow-wrap:anywhere]';

/** Focus for programmatic targets. Matches the generated Mira ring. */
export const authFocusClass = 'outline-none focus-visible:ring-2 focus-visible:ring-ring/30';

/** Presentation only: these containers never read advice or own an auth operation. */
export function AuthTask({ children, className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'mt-6 grid min-w-0 gap-4 text-start [overflow-wrap:anywhere] [&_h2]:text-base [&_h2]:font-medium [&_h2]:tracking-tight [&_p]:m-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AuthTaskSection({ children, className, ...props }: ComponentPropsWithoutRef<'section'>) {
  return (
    <section {...props} className={cn('grid min-w-0 gap-3 text-start [overflow-wrap:anywhere]', className)}>
      {children}
    </section>
  );
}

export function AuthNotice({ children, className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'relative grid w-full min-w-0 gap-0.5 rounded-lg border bg-card px-2 py-1.5 text-left text-xs/relaxed text-card-foreground [overflow-wrap:anywhere] [&_p]:m-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AuthActions({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-0 items-center gap-2 empty:hidden sm:flex sm:flex-wrap sm:items-center [&>button]:w-full sm:[&>button]:w-auto">
      {children}
    </div>
  );
}

export function AuthHelp({ children, className, ...props }: ComponentPropsWithoutRef<'nav'>) {
  return (
    <nav
      {...props}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-sm [&_a]:min-w-0 [&_a]:max-w-full [&_a]:underline [&_a]:underline-offset-4 [&_a]:[overflow-wrap:anywhere] [&_a]:focus-visible:rounded-sm [&_a]:focus-visible:outline-none [&_a]:focus-visible:ring-2 [&_a]:focus-visible:ring-ring/30',
        className,
      )}
    >
      {children}
    </nav>
  );
}
