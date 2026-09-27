'use client';

import { Collapsible as ArkCollapsible, useCollapsibleContext } from '@ark-ui/react/collapsible';
import { ChevronDownIcon } from 'lucide-react';
import type React from 'react';
import { cn } from '../utils.ts';

export const useCollapsible = useCollapsibleContext;

/**
 * Shows and hides one region under a single trigger: a spoiler inside a review, the rest of a long
 * review (`collapsedHeight` keeps a preview visible), a Work’s full edition details, or a thread’s
 * collapsed replies. The trigger states what it reveals. Use an accordion for several related
 * sections.
 */
export const Collapsible = (props: React.ComponentProps<typeof ArkCollapsible.Root>) => {
  const { collapsedHeight, lazyMount = true, unmountOnExit = true, className, ...rest } = props;

  return (
    <ArkCollapsible.Root
      className={cn('group/collapsible', className)}
      collapsedHeight={collapsedHeight}
      data-partial-collapse={collapsedHeight ? '' : undefined}
      data-slot="collapsible"
      lazyMount={collapsedHeight ? false : lazyMount}
      unmountOnExit={collapsedHeight ? false : unmountOnExit}
      {...rest}
    />
  );
};

export const CollapsibleTrigger = (props: React.ComponentProps<typeof ArkCollapsible.Trigger>) => {
  const { className, ...rest } = props;

  // Native disabled, so an asChild Button is really disabled; Button overwrites aria-disabled.
  const { disabled } = useCollapsibleContext();

  return (
    <ArkCollapsible.Trigger
      disabled={disabled || undefined}
      className={cn(
        'cursor-pointer',
        'data-disabled:pointer-events-none data-disabled:opacity-64',
        'has-data-[slot=collapsible-indicator]:[button]:justify-between',
        className,
      )}
      data-slot="collapsible-trigger"
      {...rest}
    />
  );
};

export const CollapsibleContent = (props: React.ComponentProps<typeof ArkCollapsible.Content>) => {
  const { className, children, ...rest } = props;

  return (
    <ArkCollapsible.Content
      className={cn(
        'h-(--collapsed-height)',
        'group-data-partial-collapse/collapsible:h-full',
        'transition-[height] duration-200',
        'overflow-hidden',
        'data-[state=open]:animate-expand',
        'data-[state=closed]:animate-collapse',
        'motion-reduce:animate-none! motion-reduce:transition-none!',
      )}
      data-slot="collapsible-content"
      {...rest}
    >
      <div className={className}>{children}</div>
    </ArkCollapsible.Content>
  );
};

export const CollapsibleIndicator = (
  props: React.ComponentProps<typeof ArkCollapsible.Indicator>,
) => {
  const { className, ...rest } = props;

  return (
    <ArkCollapsible.Indicator
      className={cn('data-[state=open]:[&_svg]:rotate-180', className)}
      data-slot="collapsible-indicator"
      {...rest}
    >
      <ChevronDownIcon className="transition-transform duration-200 motion-reduce:transition-none!" />
    </ArkCollapsible.Indicator>
  );
};
