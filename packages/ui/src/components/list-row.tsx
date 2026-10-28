import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../utils.ts';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLLIElement>, 'children'> {
  children: ReactNode;
  /** Show the row overlay in a story or visual regression capture. */
  forceOverlay?: boolean;
}

/**
 * Shared row for item lists: use ListRow, omit dividers, and make its translucent rounded overlay the only hover
 * state. Prefer a larger cover over denser rows. Put ordinary content alongside ListRowLink and wrap controls or
 * secondary links in ListRowControl so they stay above the stretched primary link.
 */
export function ListRow({ children, forceOverlay = false, className, ...props }: ListRowProps) {
  return (
    <li
      {...props}
      data-slot="list-row"
      data-overlay={forceOverlay ? 'visible' : undefined}
      className={cn(
        'group relative isolate before:pointer-events-none before:absolute before:-inset-1 before:z-[-1] before:rounded-xl before:bg-foreground/[0.03] before:opacity-0 before:transition-opacity before:content-[""]',
        '[@media(hover:hover)_and_(pointer:fine)]:hover:before:opacity-100 has-[:focus-visible]:before:opacity-100 active:before:opacity-100 data-[overlay=visible]:before:opacity-100',
        className,
      )}
    >
      {children}
    </li>
  );
}

export type ListRowLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

/** Primary link; its transparent box stretches over the row while its accessible name comes from the title. */
export function ListRowLink({ className, children, ...props }: ListRowLinkProps) {
  return (
    <a
      {...props}
      data-slot="list-row-link"
      className={cn(
        'absolute inset-1 z-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        className,
      )}
    >
      <span className="sr-only">{children}</span>
    </a>
  );
}

export interface ListRowControlProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Wrap buttons, inputs, menus and secondary links so their own targets sit above the stretched primary link. */
export function ListRowControl({ className, children, ...props }: ListRowControlProps) {
  return (
    <div {...props} data-slot="list-row-control" className={cn('relative z-10', className)}>
      {children}
    </div>
  );
}
