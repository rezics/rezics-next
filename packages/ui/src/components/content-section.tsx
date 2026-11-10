import type { ComponentProps } from 'react';
import { cn } from '../utils.ts';

export function ContentSection({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      data-slot="content-section"
      className={cn('min-w-0 space-y-4 border-t border-border pt-5', className)}
      {...props}
    />
  );
}

export function ContentSectionHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      data-slot="content-section-header"
      className={cn(
        'grid min-w-0 auto-rows-min items-start gap-1.5 has-data-[slot=content-section-action]:grid-cols-[minmax(0,1fr)_auto]',
        className,
      )}
      {...props}
    />
  );
}

export function ContentSectionTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-w-0 font-heading text-base font-semibold', className)} {...props} />;
}

export function ContentSectionDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-w-0 text-sm text-muted-foreground', className)} {...props} />;
}

export function ContentSectionBody({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="content-section-body" className={cn('min-w-0', className)} {...props} />;
}

export function ContentSectionAction({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="content-section-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}
