'use client';

import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';

// Aura alert: card surface with the card shadow; semantic variants tint the
// surface and color the icon and title with the text-safe `-foreground` tone,
// because the fill tones (warning, info) fall below 3:1 on the page.
export const alertVariants = tv({
  base: [
    'relative',
    'px-5 py-4',
    'grid w-full items-start gap-x-3 gap-y-1',
    'text-card-foreground text-sm',
    'rounded-2xl border shadow-(--aura-shadow-card)',
    'has-[>svg]:has-data-[slot=alert-action]:grid-cols-[--spacing(4)_1fr_auto] has-[>svg]:grid-cols-[--spacing(4)_1fr]',
    'has-[>svg]:gap-x-3 [&>svg]:h-lh [&>svg]:w-4',
    'has-data-[slot=alert-action]:grid-cols-[1fr_auto]',
  ],
  variants: {
    variant: {
      default: [
        'bg-card border-border/60',
        '[&>svg]:text-muted-foreground',
        '[&_[data-slot=alert-action]_[data-variant=ghost]]:hover:bg-muted',
      ],
      destructive: [
        'bg-destructive/5',
        'border-destructive/24',
        '[&>svg]:text-destructive-foreground *:data-[slot=alert-title]:text-destructive-foreground',
        '[&_[data-slot=alert-action]_[data-variant=ghost]]:hover:bg-destructive/10',
      ],
      info: [
        'bg-info/5',
        'border-info/32',
        '[&>svg]:text-info-foreground *:data-[slot=alert-title]:text-info-foreground',
        '[&_[data-slot=alert-action]_[data-variant=ghost]]:hover:bg-info/10',
      ],
      warning: [
        'bg-warning/8',
        'border-warning/40',
        '[&>svg]:text-warning-foreground *:data-[slot=alert-title]:text-warning-foreground',
        '[&_[data-slot=alert-action]_[data-variant=ghost]]:hover:bg-warning/12',
      ],
      success: [
        'bg-success/5',
        'border-success/32',
        '[&>svg]:text-success-foreground *:data-[slot=alert-title]:text-success-foreground',
        '[&_[data-slot=alert-action]_[data-variant=ghost]]:hover:bg-success/10',
      ],
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

interface AlertProps
  extends React.ComponentProps<typeof ark.div>,
    VariantProps<typeof alertVariants> {}

export const Alert = (props: AlertProps) => {
  const { variant, className, ...rest } = props;

  return (
    <ark.div className={cn(alertVariants({ variant }), className)} data-slot="alert" {...rest} />
  );
};

export const AlertTitle = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn('font-semibold tracking-tight', '[svg~&]:col-start-2', className)}
      data-slot="alert-title"
      {...rest}
    />
  );
};

export const AlertDescription = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'flex flex-col gap-2.5',
        'text-muted-foreground',
        '[svg~&]:col-start-2',
        className,
      )}
      data-slot="alert-description"
      {...rest}
    />
  );
};

export const AlertAction = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'flex gap-1',
        'max-sm:col-start-2 max-sm:mt-2',
        'sm:[svg~[data-slot=alert-title]~&]:col-start-3',
        'sm:row-start-1 sm:row-end-3 sm:self-center',
        'sm:[[data-slot=alert-description]~&]:col-start-2',
        'sm:[[data-slot=alert-title]~&]:col-start-2',
        'sm:[svg~&]:col-start-2',
        'sm:[svg~[data-slot=alert-description]~&]:col-start-3',
        className,
      )}
      data-slot="alert-action"
      {...rest}
    />
  );
};
