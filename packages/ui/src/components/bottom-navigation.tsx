'use client';

import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { cn } from '../utils.ts';

// A landmark of links, not Ark Tabs: each destination is its own page, and tabs would point
// aria-controls at panels that never exist. Mark the current page with `active`.

/**
 * The phone navigation bar fixed to the bottom edge: a `nav` landmark of links, with `active`
 * marking the current page. REZICS uses five destinations: Home, Discover, Create (emphasised in
 * the centre), Inbox and Shelves; the desktop left navigation moves into a drawer. Keep labels to
 * one short word, mark unread Inbox items with a brand-red dot plus screen-reader text, and hide
 * the bar above the phone breakpoint.
 */
export const BottomNavigation = (props: React.ComponentProps<typeof ark.nav>) => {
  const { className, ...rest } = props;

  return (
    <ark.nav
      className={cn(
        'w-full',
        // Reserves the fixed bar's height so the end of the page is not hidden behind it.
        'min-h-[calc(var(--spacing)*14+env(safe-area-inset-bottom,0))]',
        className,
      )}
      data-slot="bottom-navigation"
      {...rest}
    />
  );
};

export const BottomNavigationList = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'fixed inset-x-0 bottom-0 z-10',
        'flex w-full items-center justify-around',
        'min-h-14 shrink-0',
        'border-t border-border/60 bg-background/80 backdrop-blur-sm',
        'pb-[env(safe-area-inset-bottom,0px)]',
        className,
      )}
      data-slot="bottom-navigation-list"
      {...rest}
    />
  );
};

interface BottomNavigationItemProps extends React.ComponentProps<typeof ark.a> {
  /**
   * Whether the item is the current page; sets `aria-current="page"`.
   *
   * @default false
   */
  active?: boolean;
}

export const BottomNavigationItem = (props: BottomNavigationItemProps) => {
  const { active = false, className, ...rest } = props;

  return (
    <ark.a
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative',
        'min-w-0',
        'flex flex-1 flex-col items-center justify-center gap-0.5',
        'p-2',
        'text-muted-foreground',
        'rounded-xl',
        'transition-colors',
        'hover:text-foreground',
        'aria-[current=page]:text-primary',
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32',
        'aria-disabled:pointer-events-none aria-disabled:opacity-64',
        "[&_svg:not([class*='size-'])]:size-5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        'pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11',
        'motion-reduce:transition-none!',
        className,
      )}
      data-slot="bottom-navigation-item"
      {...rest}
    />
  );
};

export const BottomNavigationItemIcon = (props: React.ComponentProps<typeof ark.span>) => {
  const { className, ...rest } = props;

  return (
    <ark.span
      aria-hidden
      className={cn(
        'flex h-7 w-12 items-center justify-center rounded-full transition-colors',
        // The current page also gets a tinted pill, so it does not rely on colour alone.
        'in-aria-[current=page]:bg-accent',
        className,
      )}
      data-slot="bottom-navigation-item-icon"
      {...rest}
    />
  );
};

export const BottomNavigationItemLabel = (props: React.ComponentProps<typeof ark.span>) => {
  const { className, ...rest } = props;

  return (
    <ark.span
      className={cn('truncate font-medium text-xs', className)}
      data-slot="bottom-navigation-item-label"
      {...rest}
    />
  );
};
