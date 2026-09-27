'use client';

import { ark } from '@ark-ui/react/factory';
import { Field as ArkField } from '@ark-ui/react/field';
import { ChevronsUpDownIcon } from 'lucide-react';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';

// Input's chrome and heights, so native and custom selects line up with text fields.
export const nativeSelectVariants = tv({
  base: [
    'appearance-none',
    'w-full min-w-0',
    'select-none text-sm',
    'bg-primary/5',
    'rounded-xl border border-border/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] hover:border-border',
    'transition-colors',
    'outline-none',
    "[&:has(option[value='']:checked)]:text-muted-foreground",
    'disabled:pointer-events-none disabled:cursor-not-allowed',
    'focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/20',
    'aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/24',
    'dark:aria-invalid:border-destructive-foreground dark:aria-invalid:text-destructive-foreground dark:aria-invalid:ring-destructive-foreground/20',
    'motion-reduce:transition-none!',
  ],
  variants: {
    size: {
      sm: ['h-8', 'ps-3 pe-8', 'rounded-lg'],
      md: ['h-9', 'ps-4 pe-9'],
      lg: ['h-10', 'ps-5 pe-10', 'text-[15px]'],
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

interface NativeSelectProps
  extends Omit<React.ComponentProps<typeof ArkField.Select>, 'size'>,
    VariantProps<typeof nativeSelectVariants> {
  /**
   * Whether the select is invalid.
   *
   * @default false
   */
  invalid?: boolean;
}

export const NativeSelect = (props: NativeSelectProps) => {
  const { size = 'md', invalid, className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'relative w-fit',
        'has-[select:disabled]:opacity-64',
        '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        className,
      )}
      data-slot="native-select-wrapper"
    >
      <ArkField.Select
        aria-invalid={invalid}
        className={cn(nativeSelectVariants({ size }))}
        data-size={size}
        data-slot="native-select"
        {...rest}
      />
      <ChevronsUpDownIcon
        aria-hidden="true"
        className="absolute inset-e-3 top-1/2 -translate-y-1/2"
        data-slot="native-select-icon"
      />
    </ark.div>
  );
};

export const NativeSelectOption = (props: React.ComponentProps<typeof ark.option>) => (
  <ark.option data-slot="native-select-option" {...props} />
);

export const NativeSelectOptGroup = (props: React.ComponentProps<typeof ark.optgroup>) => (
  <ark.optgroup data-slot="native-select-optgroup" {...props} />
);
