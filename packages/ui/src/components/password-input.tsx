'use client';

import {
  PasswordInput as ArkPasswordInput,
  usePasswordInputContext,
} from '@ark-ui/react/password-input';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import type React from 'react';
import { cn } from '../utils.ts';
import type { InputProps } from './input.tsx';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  type InputGroupProps,
} from './input-group.tsx';

export const usePasswordInput = usePasswordInputContext;

interface PasswordInputProps
  extends Omit<React.ComponentProps<typeof ArkPasswordInput.Root>, 'size'>,
    Pick<InputGroupProps, 'size'> {}

export const PasswordInput = (props: PasswordInputProps) => {
  const { size = 'md', className, ...rest } = props;

  return (
    <ArkPasswordInput.Root
      className={cn('group/password-input', 'w-full', 'flex flex-col items-start gap-2', className)}
      data-size={size}
      data-slot="password-input"
      {...rest}
    />
  );
};

export const PasswordInputGroup = (
  props: React.ComponentProps<typeof ArkPasswordInput.Control>,
) => {
  const { className, ...rest } = props;

  return (
    <ArkPasswordInput.Control asChild data-slot="password-input-control">
      <InputGroup
        className={cn(
          'in-data-[size=lg]:h-10 in-data-[size=sm]:h-8 in-data-[size=sm]:rounded-lg',
          'data-disabled:pointer-events-none data-disabled:opacity-64',
          className,
        )}
        {...rest}
      />
    </ArkPasswordInput.Control>
  );
};

export const PasswordInputInput = (
  props: Omit<React.ComponentProps<typeof ArkPasswordInput.Input>, 'size'> &
    Pick<InputProps, 'size'>,
) => {
  const { size, ...rest } = props;

  return (
    <ArkPasswordInput.Input asChild data-slot="password-input-input" {...rest}>
      <InputGroupInput size={size} />
    </ArkPasswordInput.Input>
  );
};

export const PasswordInputTrigger = (
  props: React.ComponentProps<typeof ArkPasswordInput.VisibilityTrigger>,
) => {
  const { children, ...rest } = props;

  return (
    <InputGroupAddon align="inline-end">
      <ArkPasswordInput.VisibilityTrigger asChild data-slot="password-input-visibility-trigger">
        <InputGroupButton size="icon-xs" variant="ghost" {...rest}>
          {children ?? <PasswordInputIndicator />}
        </InputGroupButton>
      </ArkPasswordInput.VisibilityTrigger>
    </InputGroupAddon>
  );
};

export const PasswordInputIndicator = (
  props: React.ComponentProps<typeof ArkPasswordInput.Indicator>,
) => {
  const { children, ...rest } = props;

  return (
    <ArkPasswordInput.Indicator
      data-slot="password-input-indicator"
      fallback={<EyeOffIcon />}
      {...rest}
    >
      {children ?? <EyeIcon />}
    </ArkPasswordInput.Indicator>
  );
};
