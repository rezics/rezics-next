import type { ComponentPropsWithoutRef, ComponentPropsWithRef, ReactNode } from 'react';
import { cn } from '@rezics/ui/utils';

/** Presentation only: these containers never read advice or own an auth operation. */
export function AuthTask({ children, className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'mt-8 grid min-w-0 gap-6 text-start [overflow-wrap:anywhere] [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:m-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AuthTaskSection({ children, className, ...props }: ComponentPropsWithoutRef<'section'>) {
  return (
    <section {...props} className={cn('grid min-w-0 gap-4 text-start [overflow-wrap:anywhere]', className)}>
      {children}
    </section>
  );
}

export function AuthNotice({ children, className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'grid min-w-0 gap-3 rounded-lg border border-border bg-muted/40 p-4 text-sm leading-relaxed [overflow-wrap:anywhere] [&_p]:m-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AuthActions({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-3 sm:flex sm:flex-wrap sm:items-center [&>button]:w-full sm:[&>button]:w-auto sm:[&>button]:flex-1">
      {children}
    </div>
  );
}

export function AuthHelp({ children, className, ...props }: ComponentPropsWithoutRef<'nav'>) {
  return (
    <nav
      {...props}
      className={cn(
        'flex min-w-0 flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-sm [&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-0 [&_a]:max-w-full [&_a]:items-center [&_a]:py-2 [&_a]:underline [&_a]:underline-offset-4 [&_a]:[overflow-wrap:anywhere] [&_a:focus-visible]:rounded-sm [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-4 [&_a:focus-visible]:outline-ring',
        className,
      )}
    >
      {children}
    </nav>
  );
}
