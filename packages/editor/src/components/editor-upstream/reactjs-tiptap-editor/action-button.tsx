'use client';

// Adapted from src/components/ActionButton.tsx; upstream revision and MIT notice are adjacent.
import { forwardRef, type ButtonHTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Toggle } from '@rezics/ui/shadcn/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@rezics/ui/shadcn/tooltip';
import { cn } from '@rezics/ui/utils';

interface ActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'value'> {
  label: string;
  icon?: ReactNode;
  action?: () => void;
  pressed?: boolean;
}

/** One control for command availability, pressed state, tooltip and selection-preserving pointer use. */
export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { label, icon, action, pressed, className, children, onMouseDown, onPointerDown, ...props },
  ref,
) {
  const common = {
    ...props,
    ref,
    type: 'button' as const,
    'aria-label': label,
    className: cn(
      'min-h-11 min-w-11 shrink-0 rounded-xl aria-pressed:bg-primary/10 aria-pressed:text-primary',
      className,
    ),
    onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
      onMouseDown?.(event);
      event.preventDefault();
    },
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(event);
      event.preventDefault();
    },
  };
  const content = (
    <>
      {icon}
      {children}
    </>
  );
  const control =
    pressed === undefined ? (
      <Button
        {...common}
        variant="ghost"
        onClick={() => {
          if (!props.disabled) action?.();
        }}
      >
        {content}
      </Button>
    ) : (
      <Toggle
        {...common}
        pressed={pressed}
        onPressedChange={() => {
          if (!props.disabled) action?.();
        }}
      >
        {content}
      </Toggle>
    );

  return (
    <Tooltip>
      <TooltipTrigger render={control} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
