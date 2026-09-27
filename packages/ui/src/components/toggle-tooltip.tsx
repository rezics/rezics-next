'use client';

import { Popover as ArkPopover } from '@ark-ui/react/popover';
import { Portal } from '@ark-ui/react/portal';
import React from 'react';
import { cn } from '../utils.ts';
import { Popover, PopoverTrigger, usePopoverLabelling } from './popover.tsx';

/**
 * A tooltip-styled hint that opens on tap or click instead of hover, so phone readers can reach
 * it: what a rating Context means, why a Work is marked “merged”, how Realm karma is counted. Keep
 * it to a sentence or two of text. It closes on a second tap, on Escape or when focus leaves. Use
 * a popover when the hint needs a title, links or actions.
 */
export const ToggleTooltip = (props: React.ComponentProps<typeof ArkPopover.Root>) => {
  const {
    positioning = { placement: 'top' },
    lazyMount = true,
    unmountOnExit = true,
    modal = false,
    ...rest
  } = props;

  return (
    <Popover
      data-slot="toggle-tooltip"
      lazyMount={lazyMount}
      modal={modal}
      positioning={positioning}
      unmountOnExit={unmountOnExit}
      {...rest}
    />
  );
};

export const ToggleTooltipTrigger = (props: React.ComponentProps<typeof ArkPopover.Trigger>) => (
  <PopoverTrigger data-slot="toggle-tooltip-trigger" {...props} />
);

export const ToggleTooltipContent = (props: React.ComponentProps<typeof ArkPopover.Content>) => {
  const { className, children, ...rest } = props;

  const content = React.useRef<HTMLDivElement>(null);
  const labelling = usePopoverLabelling(content);

  return (
    <Portal>
      <ArkPopover.Positioner data-slot="toggle-tooltip-positioner">
        <ArkPopover.Content
          {...labelling}
          ref={content}
          className={cn(
            'z-50 w-fit',
            'px-3 py-1.5',
            'bg-foreground',
            'text-background text-xs',
            'rounded-xl shadow-(--aura-shadow-float)',
            'origin-(--transform-origin) animate-in',
            'fade-in-0 zoom-in-[98%]',
            'data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[98%]',
            'data-[state=closed]:animate-out',
            'data-[placement=bottom]:slide-in-from-top-2',
            'data-[placement=left]:slide-in-from-end-2',
            'data-[placement=right]:slide-in-from-start-2',
            'data-[placement=top]:slide-in-from-bottom-2',
            'motion-reduce:animate-none!',
            className,
          )}
          data-slot="toggle-tooltip-content"
          {...rest}
        >
          {/* The popover is a dialog; its hint text doubles as the dialog's accessible name. */}
          <ArkPopover.Title asChild>
            <div>{children}</div>
          </ArkPopover.Title>
          <ToggleTooltipArrow />
        </ArkPopover.Content>
      </ArkPopover.Positioner>
    </Portal>
  );
};

export const ToggleTooltipArrow = (props: React.ComponentProps<typeof ArkPopover.Arrow>) => {
  const { style, ...rest } = props;

  return (
    <ArkPopover.Arrow
      data-slot="toggle-tooltip-arrow"
      style={
        {
          '--arrow-background': 'var(--foreground)',
          '--arrow-size': 'calc(1.5 * var(--spacing))',
          ...style,
        } as React.CSSProperties
      }
      {...rest}
    >
      <ArkPopover.ArrowTip />
    </ArkPopover.Arrow>
  );
};
