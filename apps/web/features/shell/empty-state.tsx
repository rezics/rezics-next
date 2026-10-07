import { cn } from '@rezics/ui/utils';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** A server failure's description, with the short id the response carried. */
export function failureDetail(description: string, reference: string | undefined, label: string, show: boolean): ReactNode {
  if (!show || !reference) return description;
  return <>{description}<span className="mt-2 block text-xs">{label}: <span className="font-mono break-all">{reference}</span></span></>;
}

/**
 * A place with nothing to show yet: no results, a missing page, a failure or a
 * feature still to come. Say what happened and offer the next step.
 */
export function EmptyState({ icon: Icon, title, description, children, tone = 'default', role,
  headingLevel = 2, className }: {
  icon: LucideIcon; title: ReactNode; description?: ReactNode; children?: ReactNode;
  tone?: 'default' | 'destructive'; role?: 'alert' | 'status'; headingLevel?: 1 | 2 | 3;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  return <div role={role} data-slot="empty-state" className={cn('flex flex-col items-center gap-3 text-center',
    'rounded-2xl border border-border/80 border-dashed bg-card/60 px-6 py-12 sm:py-16', className)}>
    <span className={cn('mb-1 grid size-12 place-items-center rounded-2xl',
      tone === 'destructive' ? 'bg-destructive/10 text-destructive-foreground' : 'bg-primary/10 text-primary')}>
      <Icon aria-hidden="true" className="size-6" />
    </span>
    <Heading className="text-balance font-semibold text-lg">{title}</Heading>
    {description ? <p className="max-w-md text-pretty text-muted-foreground text-sm">{description}</p> : null}
    {children ? <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div> : null}
  </div>;
}
