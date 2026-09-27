'use client';

import { Switch as ArkSwitch, useSwitchContext } from '@ark-ui/react/switch';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';

export const useSwitch = useSwitchContext;

// Aura's sizes: sm 20x36, md 28x48, lg 32x56, each with a 2px transparent border
// around the thumb.
const switchVariants = tv({
  base: [
    'group/switch',
    'p-0.5',
    'inline-flex shrink-0 items-center',
    'rounded-full border-2 border-transparent shadow-inner',
    'transition-all',
    'outline-none',
    'data-focus-visible:ring-2 data-focus-visible:ring-ring data-focus-visible:ring-offset-2 data-focus-visible:ring-offset-background',
    'data-invalid:border-destructive data-invalid:ring-[3px] data-invalid:ring-destructive/24',
    'dark:data-invalid:border-destructive-foreground dark:data-invalid:ring-destructive-foreground/20',
    'data-[state=checked]:bg-primary',
    'data-[state=unchecked]:bg-input',
    'data-disabled:pointer-events-none data-disabled:opacity-64',
    'motion-reduce:transition-none!',
  ],
  variants: {
    size: {
      sm: 'h-5 w-9 [--thumb-size:--spacing(3)] [--travel:--spacing(4)]',
      md: 'h-7 w-12 [--thumb-size:--spacing(5)] [--travel:--spacing(5)]',
      lg: 'h-8 w-14 [--thumb-size:--spacing(6)] [--travel:--spacing(6)]',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

export interface SwitchProps
  extends React.ComponentProps<typeof ArkSwitch.Root>,
    VariantProps<typeof switchVariants> {}

export const Switch = (props: SwitchProps) => {
  const { size = 'md', className, tabIndex, ...rest } = props;

  return (
    <ArkSwitch.Root
      className={cn(switchVariants({ size }), className)}
      data-size={size}
      data-slot="switch"
      {...rest}
    >
      <ArkSwitch.Control className="flex size-full items-center" data-slot="switch-control">
        <ArkSwitch.Thumb
          className={cn(
            'block',
            'size-(--thumb-size)',
            'bg-background',
            'rounded-full shadow-md ring-0',
            'pointer-events-none',
            'transition-transform',
            'data-[state=checked]:translate-x-(--travel) rtl:data-[state=checked]:-translate-x-(--travel)',
            'data-[state=unchecked]:translate-x-0',
            'dark:data-[state=checked]:bg-primary-foreground',
            'dark:data-[state=unchecked]:bg-foreground',
            'motion-reduce:transition-none!',
          )}
          data-slot="switch-thumb"
        />
      </ArkSwitch.Control>

      {/* Ark renders a plain checkbox; the switch role makes screen readers announce on/off. */}
      <ArkSwitch.HiddenInput role="switch" tabIndex={tabIndex} />
    </ArkSwitch.Root>
  );
};
