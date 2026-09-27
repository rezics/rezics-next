'use client';

import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { cn } from '../utils.ts';

const SKIP_NAV_ID = 'skip-nav-content';

export interface SkipNavLinkProps extends React.ComponentProps<typeof ark.a> {
  /**
   * The id of the element to skip to.
   *
   * @default "skip-nav-content"
   */
  id?: string;
}

/**
 * A “Skip to content” link that stays hidden until the first Tab press, so keyboard and screen-
 * reader readers can jump past the header and navigation straight to the page’s main content. Put
 * `SkipNavLink` first in the document and wrap the main region in `SkipNavContent`; every REZICS
 * page shell needs exactly one pair.
 */
export const SkipNavLink = (props: SkipNavLinkProps) => {
  const { id = SKIP_NAV_ID, className, children, ...rest } = props;

  return (
    <ark.a
      className={cn(
        'focus:fixed focus:inset-s-4 focus:top-4 focus:z-9999',
        'focus:px-4 focus:py-2',
        'focus:bg-primary',
        // Important: the web app's unlayered legacy `a { color: inherit }` beats utilities,
        // and inherited body text on the ink-blue fill fails contrast.
        'focus:text-primary-foreground! focus:text-sm',
        'sr-only focus:not-sr-only',
        'focus:rounded-xl',
        'focus:shadow-(--aura-shadow-float)',
        // The offset keeps the ink-blue ring visible against the ink-blue fill.
        'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
        className,
      )}
      data-slot="skip-nav-link"
      href={`#${id}`}
      {...rest}
    >
      {children ?? 'Skip to content'}
    </ark.a>
  );
};

export interface SkipNavContentProps extends React.ComponentProps<typeof ark.div> {
  /**
   * The id that SkipNavLink links to.
   *
   * @default "skip-nav-content"
   */
  id?: string;
}

export const SkipNavContent = (props: SkipNavContentProps) => {
  const { id = SKIP_NAV_ID, className, ...rest } = props;

  return (
    <ark.div
      className={cn('outline-none', className)}
      data-slot="skip-nav-content"
      id={id}
      tabIndex={-1}
      {...rest}
    />
  );
};
