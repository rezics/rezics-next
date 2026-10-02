'use client';

import { RadioGroup as ArkRadioGroup, useRadioGroupContext } from '@ark-ui/react/radio-group';
import type React from 'react';
import { cn } from '../utils.ts';
import { FieldLabel } from './field.tsx';

export const useRadioGroup = useRadioGroupContext;

export const RadioGroup = (props: React.ComponentProps<typeof ArkRadioGroup.Root>) => {
  const { className, children, ...rest } = props;

  return (
    <ArkRadioGroup.Root
      className={cn(
        'flex flex-col gap-3',
        'data-invalid:text-destructive dark:data-invalid:text-destructive-foreground',
        className,
      )}
      data-slot="radio-group"
      {...rest}
    >
      {children}
    </ArkRadioGroup.Root>
  );
};

export const RadioGroupItem = (props: React.ComponentProps<typeof ArkRadioGroup.Item>) => {
  const { tabIndex, className, children, ...rest } = props;

  return (
    <ArkRadioGroup.Item
      className={cn('inline-flex items-start gap-2', 'data-disabled:opacity-64', className)}
      data-slot="radio-group-item"
      {...rest}
    >
      {/* Aura's radio: 20px ring with a primary dot on a primary tint. The unchecked edge
          uses 75% muted-foreground for WCAG's 3:1 control contrast, as Checkbox does. */}
      <ArkRadioGroup.ItemControl
        className={cn(
          'relative',
          'inline-flex shrink-0 items-center justify-center',
          'size-5',
          'border-2 border-muted-foreground/75 shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]',
          'bg-primary/5',
          'rounded-full',
          'transition-[border-color,background-color]',
          'before:size-2.5 before:rounded-full',
          'hover:border-primary/50 hover:bg-accent/30',
          'data-focus-visible:ring-2 data-focus-visible:ring-ring data-focus-visible:ring-offset-2 data-focus-visible:ring-offset-background',
          'data-[state=checked]:border-primary data-[state=checked]:bg-primary/10 data-[state=checked]:before:bg-primary',
          'data-invalid:border-destructive data-invalid:data-[state=checked]:before:bg-destructive',
          'dark:data-invalid:border-destructive-foreground',
          'dark:data-invalid:data-[state=checked]:before:bg-destructive-foreground',
          'motion-reduce:transition-none!',
        )}
        data-slot="radio-group-item-control"
      />

      <RadioGroupText>{children}</RadioGroupText>

      <ArkRadioGroup.ItemHiddenInput tabIndex={tabIndex} />
    </ArkRadioGroup.Item>
  );
};

export const RadioGroupText = (props: React.ComponentProps<typeof ArkRadioGroup.ItemText>) => {
  const { className, children, ...rest } = props;

  return (
    <FieldLabel asChild className={cn('min-w-0 flex-1 leading-5', className)}>
      <ArkRadioGroup.ItemText data-slot="radio-group-item-text" {...rest}>
        {children}
      </ArkRadioGroup.ItemText>
    </FieldLabel>
  );
};

export const RadioGroupLabel = (props: React.ComponentProps<typeof ArkRadioGroup.Label>) => {
  const { children, ...rest } = props;

  return (
    <FieldLabel asChild>
      <ArkRadioGroup.Label data-slot="radio-group-label" {...rest}>
        {children}
      </ArkRadioGroup.Label>
    </FieldLabel>
  );
};
