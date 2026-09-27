'use client';

import { ark } from '@ark-ui/react/factory';
import { PinInput as ArkPinInput } from '@ark-ui/react/pin-input';
import type React from 'react';
import { cn } from '../utils.ts';
import { Input, type InputProps } from './input.tsx';

interface InputOTPProps
  extends React.ComponentProps<typeof ArkPinInput.Root>,
    Pick<InputProps, 'size'> {}

export const InputOTP = (props: InputOTPProps) => {
  const { size = 'md', placeholder, otp = true, className, children, ...rest } = props;

  return (
    <ArkPinInput.Root
      className="group/input-otp"
      data-size={size}
      data-slot="input-otp"
      otp={otp}
      placeholder={placeholder ?? ''}
      {...rest}
    >
      <ArkPinInput.Control
        // Square cells a step larger than Input heights, up to Aura's 44px.
        className={cn(
          'flex items-center gap-2',
          '*:data-[slot=input-otp-input]:size-10',
          'in-data-[size=sm]:*:data-[slot=input-otp-input]:size-9',
          'in-data-[size=lg]:*:data-[slot=input-otp-input]:size-11',
          className,
        )}
        data-slot="input-otp-control"
      >
        {children}
      </ArkPinInput.Control>

      <ArkPinInput.HiddenInput />
    </ArkPinInput.Root>
  );
};

export const InputOTPSlot = (props: React.ComponentProps<typeof ArkPinInput.Input>) => {
  const { className, ...rest } = props;

  return (
    <ArkPinInput.Input asChild data-slot="input-otp-input" {...rest}>
      <Input
        className={cn('relative p-0 text-center font-medium text-base tabular-nums', className)}
      />
    </ArkPinInput.Input>
  );
};

export const InputOTPSeparator = (props: React.ComponentProps<typeof ark.hr>) => {
  const { className, ...rest } = props;

  return (
    <ark.hr
      className={cn('h-0.5 w-2 rounded-full border-0 bg-muted-foreground/50', className)}
      data-slot="input-otp-separator"
      {...rest}
    />
  );
};
