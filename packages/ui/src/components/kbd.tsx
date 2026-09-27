'use client';

import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';

// Aura keyboard hint: 24px, `rounded-lg`, hairline border and a small shadow.
const kbdVariants = tv({
  base: [
    'h-6 min-w-6',
    'px-1.5',
    'inline-flex items-center justify-center gap-1',
    'select-none font-medium font-sans text-xs',
    'rounded-lg border shadow-xs',
    'pointer-events-none',
    'in-data-[slot=tooltip-content]:border-background/30 in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:text-background',
    "[&_svg:not([class*='size-'])]:size-3",
  ],
  variants: {
    variant: {
      default: 'border-border/60 bg-secondary text-muted-foreground',
      outline: 'border-border bg-background text-foreground',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

interface KbdProps extends React.ComponentProps<typeof ark.kbd>, VariantProps<typeof kbdVariants> {}

export const Kbd = (props: KbdProps) => {
  const { variant = 'default', className, ...rest } = props;

  return <ark.kbd className={cn(kbdVariants({ variant }), className)} data-slot="kbd" {...rest} />;
};

export const KbdGroup = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn('inline-flex items-center gap-1.5', className)}
      data-slot="kbd-group"
      {...rest}
    />
  );
};
