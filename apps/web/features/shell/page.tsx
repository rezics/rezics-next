import { cn } from '@rezics/ui/utils';
import type { ComponentProps, ReactNode } from 'react';

/** The content column every route renders inside the shell's <main>. */
export function PageContainer({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10',
    className)} {...props} />;
}

/** A route's title block: the only <h1> on the page, with optional lead text and actions. */
export function PageHeader({ title, description, actions, id, className, children }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; id?: string; className?: string;
  children?: ReactNode;
}) {
  return <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}>
    <div className="min-w-0 space-y-2">
      <h1 id={id} className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">{title}</h1>
      {description ? <p className="max-w-2xl text-pretty text-muted-foreground">{description}</p> : null}
      {children}
    </div>
    {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
  </header>;
}
