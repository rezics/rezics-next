'use client';

import { Toggle as ArkToggle, useToggleContext } from '@ark-ui/react/toggle';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';
import { buttonVariants } from './button.tsx';

export const useToggle = useToggleContext;

// Pressed toggles use the accent surface, the Rezics color for selected states; sizes
// match Button (32/36/40px).
export const toggleVariants = tv({
  base: [
    'relative',
    'text-muted-foreground hover:text-foreground',
    'data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
    'data-[state=on]:hover:bg-accent data-[state=on]:hover:text-accent-foreground',
    'pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11',
  ],
  variants: {
    variant: {
      ghost: '',
      outline: 'data-[state=on]:border-primary/40',
    },
    size: {
      sm: 'h-8 min-w-8 px-2 text-xs',
      md: 'h-9 min-w-9 px-2.5',
      lg: 'h-10 min-w-10 px-3',
    },
  },
  defaultVariants: {
    variant: 'ghost',
    size: 'md',
  },
});

export interface ToggleProps
  extends React.ComponentProps<typeof ArkToggle.Root>,
    VariantProps<typeof toggleVariants> {
  /**
   * The variant of the toggle
   *
   * @default "ghost"
   */
  variant?: Extract<VariantProps<typeof buttonVariants>['variant'], 'outline' | 'ghost'>;
}

export const Toggle = (props: ToggleProps) => {
  const { variant = 'ghost', size = 'md', className, ...rest } = props;

  return (
    <ArkToggle.Root
      className={cn(
        buttonVariants({ variant, clickEffect: false }),
        toggleVariants({ variant, size }),
        className,
      )}
      data-slot="toggle"
      {...rest}
    />
  );
};

export const ToggleIndicator = (props: React.ComponentProps<typeof ArkToggle.Indicator>) => {
  const { children, ...rest } = props;

  return (
    <ArkToggle.Indicator className="flex items-center gap-2" data-slot="toggle-indicator" {...rest}>
      {children}
    </ArkToggle.Indicator>
  );
};
