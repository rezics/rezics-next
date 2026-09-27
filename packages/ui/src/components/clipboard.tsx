'use client';

import { Clipboard as ArkClipboard, useClipboardContext } from '@ark-ui/react/clipboard';
import { CheckIcon, ClipboardIcon } from 'lucide-react';
import type React from 'react';
import type { VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';
import { inputVariants } from './input.tsx';

export const useClipboard = useClipboardContext;

interface ClipboardProps extends React.ComponentProps<typeof ArkClipboard.Root> {
  /**
   * Visible label, rendered above the control and tied to `ClipboardInput`.
   */
  label?: React.ReactNode;
  /**
   * Styles for the root element
   */
  rootClassName?: string;
}

export const Clipboard = (props: ClipboardProps) => {
  const { label, rootClassName, className, children, ...rest } = props;

  return (
    <ArkClipboard.Root className={cn(rootClassName)} data-slot="clipboard" {...rest}>
      {label !== undefined && <ClipboardLabel>{label}</ClipboardLabel>}
      <ArkClipboard.Control
        className={cn('flex items-center gap-2', className)}
        data-slot="clipboard-control"
      >
        {children}
      </ArkClipboard.Control>
    </ArkClipboard.Root>
  );
};

const ClipboardLabel = (props: React.ComponentProps<typeof ArkClipboard.Label>) => {
  const { className, ...rest } = props;

  return (
    <ArkClipboard.Label
      className={cn('mb-2 block select-none font-medium text-sm leading-snug', className)}
      data-slot="clipboard-label"
      {...rest}
    />
  );
};

export const ClipboardTrigger = (props: React.ComponentProps<typeof ArkClipboard.Trigger>) => (
  <ArkClipboard.Trigger data-slot="clipboard-trigger" {...props} />
);

export const ClipboardInput = (props: React.ComponentProps<typeof ArkClipboard.Input>) => {
  const { className, ...rest } = props;

  return (
    <ArkClipboard.Input
      className={cn(inputVariants(), className)}
      data-slot="clipboard-input"
      {...rest}
    />
  );
};

interface ClipboardValueProps
  extends React.ComponentProps<typeof ArkClipboard.ValueText>,
    VariantProps<typeof inputVariants> {}

export const ClipboardValue = (props: ClipboardValueProps) => {
  const { size, className, ...rest } = props;

  return (
    <ArkClipboard.ValueText
      // Shares the input surface so a copied value looks like a read-only field.
      className={cn(
        inputVariants({ size }),
        'inline-flex items-center hover:border-border/80',
        className,
      )}
      data-slot="clipboard-value"
      {...rest}
    />
  );
};

export const ClipboardIndicator = (props: React.ComponentProps<typeof ArkClipboard.Indicator>) => {
  const { copied = <CheckIcon />, className, children, ...rest } = props;

  return (
    <ArkClipboard.Indicator
      className={cn('pointer-events-none', className)}
      copied={copied}
      data-slot="clipboard-indicator"
      {...rest}
    >
      {children || <ClipboardIcon />}
    </ArkClipboard.Indicator>
  );
};
