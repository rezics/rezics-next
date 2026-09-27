'use client';

import { NumberInput as ArkNumberInput, useNumberInputContext } from '@ark-ui/react/number-input';
import { MinusIcon, PlusIcon } from 'lucide-react';
import type React from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { FieldLabel } from './field.tsx';
import { type InputProps, inputVariants } from './input.tsx';

export const useNumberInput = useNumberInputContext;

interface NumberInputProps
  extends React.ComponentProps<typeof ArkNumberInput.Root>,
    Pick<InputProps, 'size'> {}

export const NumberInput = (props: NumberInputProps) => {
  const { size = 'md', translations, className, ...rest } = props;

  return (
    <ArkNumberInput.Root
      // Zag's defaults are "increment value" and "decrease value"; keep the pair consistent.
      translations={{ incrementLabel: 'Increase', decrementLabel: 'Decrease', ...translations }}
      className={cn(
        'group/number-field',
        'flex w-full flex-col items-start gap-2',
        'has-data-[slot=number-field-increment]:has-data-[slot=number-field-decrement]:**:data-[slot=number-field-input]:text-center',
        className,
      )}
      data-size={size}
      data-slot="number-field"
      {...rest}
    />
  );
};

export const NumberInputGroup = (props: React.ComponentProps<typeof ArkNumberInput.Control>) => {
  const { className, ...rest } = props;

  return (
    <ArkNumberInput.Control
      // Input's chrome and heights, so a number field lines up with text fields.
      className={cn(
        'relative',
        'w-full',
        'flex justify-between',
        'h-9 in-data-[size=lg]:h-10 in-data-[size=sm]:h-8',
        'bg-primary/5',
        'text-base',
        'rounded-xl border border-border/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] hover:border-border',
        'in-data-[size=sm]:rounded-lg',
        'transition-shadow',
        'focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/20',
        'data-disabled:pointer-events-none data-disabled:opacity-64',
        'data-invalid:border-destructive data-invalid:ring-[3px] data-invalid:ring-destructive/24',
        'dark:data-invalid:border-destructive-foreground dark:data-invalid:ring-destructive-foreground/40',
        'motion-reduce:transition-none!',
        className,
      )}
      data-slot="number-field-group"
      {...rest}
    />
  );
};

export const NumberInputDecrement = (
  props: React.ComponentProps<typeof ArkNumberInput.DecrementTrigger>,
) => {
  const { className, ...rest } = props;

  return (
    <ArkNumberInput.DecrementTrigger
      asChild
      className={cn(
        'relative',
        'h-full w-9 in-data-[size=lg]:w-10 in-data-[size=sm]:w-8 px-0',
        'flex shrink-0',
        'text-muted-foreground hover:text-foreground',
        'rounded-none rounded-s-[calc(var(--radius-xl)-1px)] in-data-[size=sm]:rounded-s-[calc(var(--radius-lg)-1px)]',
        'cursor-pointer',
        'pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11',
        className,
      )}
      data-slot="number-field-decrement"
      {...rest}
    >
      <Button variant="ghost">
        <MinusIcon aria-hidden />
      </Button>
    </ArkNumberInput.DecrementTrigger>
  );
};

export const NumberInputIncrement = (
  props: React.ComponentProps<typeof ArkNumberInput.IncrementTrigger>,
) => {
  const { className, ...rest } = props;

  return (
    <ArkNumberInput.IncrementTrigger
      asChild
      className={cn(
        'relative',
        'h-full w-9 in-data-[size=lg]:w-10 in-data-[size=sm]:w-8 px-0',
        'flex shrink-0',
        'text-muted-foreground hover:text-foreground',
        'rounded-none rounded-e-[calc(var(--radius-xl)-1px)] in-data-[size=sm]:rounded-e-[calc(var(--radius-lg)-1px)]',
        'cursor-pointer',
        'pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11',
        className,
      )}
      data-slot="number-field-increment"
      {...rest}
    >
      <Button variant="ghost">
        <PlusIcon aria-hidden />
      </Button>
    </ArkNumberInput.IncrementTrigger>
  );
};

// Styled with inputVariants rather than wrapping Input: Input is Ark's FieldInput, and
// nesting a second Ark part on the same element kept zag from seeing focus and keys.
export const NumberInputInput = (
  props: Omit<React.ComponentProps<typeof ArkNumberInput.Input>, 'size'> & Pick<InputProps, 'size'>,
) => {
  const { size, className, ...rest } = props;

  return (
    <ArkNumberInput.Input
      className={cn(
        inputVariants({ size }),
        'grow',
        'h-full min-w-0',
        'tabular-nums',
        'bg-transparent',
        'rounded-none border-0 shadow-none ring-0',
        'focus-visible:ring-0 aria-invalid:ring-0 data-invalid:ring-0',
        'disabled:opacity-100',
        className,
      )}
      data-slot="number-field-input"
      {...rest}
    />
  );
};

// The label stays a <label>; the scrubber is a span inside it, since the scrubber's
// role="presentation" is not allowed on a label.
export const NumberInputScrubber = (
  props: React.ComponentProps<typeof ArkNumberInput.Scrubber>,
) => {
  const { className, children, ...rest } = props;

  return (
    <ArkNumberInput.Label asChild>
      <FieldLabel>
        <ArkNumberInput.Scrubber asChild data-slot="number-field-scrubber" {...rest}>
          <span className={cn('flex cursor-ew-resize', className)}>{children}</span>
        </ArkNumberInput.Scrubber>
      </FieldLabel>
    </ArkNumberInput.Label>
  );
};
