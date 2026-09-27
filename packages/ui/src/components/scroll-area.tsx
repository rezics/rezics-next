'use client';

import { ScrollArea as ArkScrollArea, useScrollAreaContext } from '@ark-ui/react/scroll-area';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';

export const useScrollArea = useScrollAreaContext;

const scrollAreaVariants = tv({
  base: [
    'h-full',
    'rounded-[inherit]',
    'scrollbar-none',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32',
    'transition-shadow motion-reduce:transition-none!',
  ],
  variants: {
    scrollFade: {
      true: [
        'mask-t-from-[calc(100%-var(--fade-size))]',
        'mask-b-from-[calc(100%-var(--fade-size))]',
        'data-at-top:mask-t-from-100%',
        'data-at-bottom:mask-b-from-100%',
        'transition-shadow',
        'motion-reduce:transition-none!',
      ],
    },
  },
  defaultVariants: {
    scrollFade: false,
  },
});

interface ScrollAreaProps
  extends React.ComponentProps<typeof ArkScrollArea.Root>,
    VariantProps<typeof scrollAreaVariants> {}

export const ScrollArea = (props: ScrollAreaProps) => {
  const { scrollFade = false, className, children, ...rest } = props;

  return (
    <ArkScrollArea.Root
      className={cn('size-full min-h-0 [--fade-size:1.5rem]', className)}
      data-slot="scroll-area"
      {...rest}
    >
      <ScrollAreaViewport className={cn(scrollAreaVariants({ scrollFade }))}>
        <ArkScrollArea.Content data-slot="scroll-area-content">{children}</ArkScrollArea.Content>
      </ScrollAreaViewport>

      <ScrollAreaScrollbar orientation="vertical" />
      <ScrollAreaScrollbar orientation="horizontal" />

      <ArkScrollArea.Corner data-slot="scroll-area-corner" />
    </ArkScrollArea.Root>
  );
};

const ScrollAreaViewport = (props: React.ComponentProps<typeof ArkScrollArea.Viewport>) => {
  const { hasOverflowX, hasOverflowY } = useScrollArea();

  return (
    <ArkScrollArea.Viewport
      data-slot="scroll-area-viewport"
      // Zag only makes the viewport focusable when it overflows on both axes;
      // keyboard users must reach any scrollable region (WCAG 2.1.1).
      tabIndex={hasOverflowX || hasOverflowY ? 0 : undefined}
      {...props}
    />
  );
};

export const ScrollAreaScrollbar = (
  props: React.ComponentProps<typeof ArkScrollArea.Scrollbar>,
) => {
  const { orientation, className, ...rest } = props;

  return (
    <ArkScrollArea.Scrollbar
      className={cn(
        'flex',
        'm-1',
        'bg-transparent',
        'opacity-0 transition-opacity delay-300',
        'data-[orientation=vertical]:w-1.5',
        'data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:flex-col',
        'data-hover:opacity-100 data-hover:delay-0 data-hover:duration-100',
        'data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-100',
        'data-[orientation=vertical]:in-[[data-slot=scroll-area]:not([data-overflow-y])]:hidden',
        'data-[orientation=horizontal]:in-[[data-slot=scroll-area]:not([data-overflow-x])]:hidden',
        'motion-reduce:transition-none!',
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...rest}
    >
      <ArkScrollArea.Thumb
        className="relative flex-1 rounded-full bg-primary/25 transition-colors hover:bg-primary/40 motion-reduce:transition-none"
        data-slot="scroll-area-thumb"
      />
    </ArkScrollArea.Scrollbar>
  );
};
