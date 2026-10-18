'use client';

import { Field as ArkField, useFieldContext } from '@ark-ui/react/field';
import type React from 'react';
import { cn } from '../utils.ts';

export const Textarea = (props: React.ComponentProps<typeof ArkField.Textarea>) => {
  const { className, ...rest } = props;
  const field = useFieldContext();
  const errorId = field?.invalid && field.ariaDescribedby?.split(' ').includes(field.ids.errorText)
    ? field.ids.errorText
    : undefined;

  return (
    <ArkField.Textarea
      aria-errormessage={errorId}
      className={cn(
        'field-sizing-content min-h-24 w-full',
        'flex',
        'px-4 py-3',
        'bg-primary/5',
        'text-base md:text-sm',
        'rounded-2xl border border-control shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] hover:border-muted-foreground',
        'placeholder:text-muted-foreground',
        'resize-none',
        'transition-[color,box-shadow]',
        // Validation keeps its border and halo while the outline marks keyboard focus.
        'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20',
        'read-only:bg-muted/40',
        'aria-invalid:border-destructive aria-invalid:text-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/24',
        'data-invalid:border-destructive data-invalid:text-destructive data-invalid:ring-[3px] data-invalid:ring-destructive/24',
        'dark:aria-invalid:border-destructive-foreground dark:aria-invalid:text-destructive-foreground dark:aria-invalid:ring-destructive-foreground/40',
        'dark:data-invalid:border-destructive-foreground dark:data-invalid:text-destructive-foreground dark:data-invalid:ring-destructive-foreground/40',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-64',
        'motion-reduce:transition-none!',
        className,
      )}
      data-slot="textarea"
      {...rest}
    />
  );
};
