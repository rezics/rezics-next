'use client';

import { Portal } from '@ark-ui/react';
import { ark } from '@ark-ui/react/factory';
import { Select as ArkSelect, createListCollection, useSelectContext } from '@ark-ui/react/select';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import type React from 'react';
import type { VariantProps } from 'tailwind-variants';
import { useUiCopy } from '../i18n/copy.ts';
import { cn } from '../utils.ts';
import { FieldLabel } from './field.tsx';
import { inputVariants } from './input.tsx';

export const useSelect = useSelectContext;

export const SelectContext = ArkSelect.Context;

export const Select: ArkSelect.RootComponent = (props) => {
  const { lazyMount = true, unmountOnExit = true, children, ...rest } = props;

  return (
    <ArkSelect.Root
      data-slot="select"
      lazyMount={lazyMount}
      unmountOnExit={unmountOnExit}
      {...rest}
    >
      {children}

      <ArkSelect.HiddenSelect />
    </ArkSelect.Root>
  );
};

/** A single choice from a short list, backed by the styled Ark Select. */
export function ChoiceSelect({ options, value, defaultValue, onValueChange, className, size, placeholder, label,
  portalled = true, ...props }: {
  options: readonly { value: string; label: string; lang?: string }[];
  value?: string; defaultValue?: string; onValueChange?: (value: string) => void;
  className?: string; size?: 'sm' | 'md' | 'lg'; placeholder?: string; label?: string;
  name?: string; required?: boolean; disabled?: boolean; id?: string; portalled?: boolean;
}) {
  const collection = createListCollection({ items: [...options] });
  return <Select collection={collection} value={value === undefined ? undefined : value ? [value] : []}
    defaultValue={defaultValue === undefined ? undefined : defaultValue ? [defaultValue] : []}
    onValueChange={details => onValueChange?.(details.value[0] ?? '')} {...props}>
    <SelectTrigger className={cn('w-full', className)} size={size} aria-label={label}>
      <SelectValue placeholder={placeholder ?? options.find(option => option.value === '')?.label} />
    </SelectTrigger>
    <SelectContent portalled={portalled}>
      {options.map(option => <SelectItem key={option.value} item={option}
        lang={option.lang}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}

interface SelectTriggerProps
  extends React.ComponentProps<typeof ArkSelect.Trigger>,
    VariantProps<typeof inputVariants> {
  /**
   * Show clear trigger
   *
   * @default false
   */
  showClear?: boolean;
}

/** Accessible name for a Select that is not inside a Field with a FieldLabel. */
export const SelectLabel = (props: React.ComponentProps<typeof ArkSelect.Label>) => (
  <FieldLabel asChild>
    <ArkSelect.Label data-slot="select-label" {...props} />
  </FieldLabel>
);

export const SelectTrigger = (props: SelectTriggerProps) => {
  const { showClear = false, size = 'md', className, children, ...rest } = props;

  return (
    <ArkSelect.Control data-slot="select-control">
      <ArkSelect.Trigger
        className={cn(
          inputVariants({ size }),
          'w-fit',
          'flex items-center gap-2',
          'text-sm',
          'data-placeholder-shown:text-muted-foreground',
          'data-[state=open]:border-ring/50 data-[state=open]:ring-2 data-[state=open]:ring-ring/20',
          '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
          className,
        )}
        data-slot="select-trigger"
        {...rest}
      >
        {children}

        <div className="ms-auto flex items-center gap-1 rtl:me-auto">
          {showClear && (
            <SelectClearTrigger>
              <XIcon />
            </SelectClearTrigger>
          )}
          <ArkSelect.Indicator
            className="transition-transform data-[state=open]:rotate-180 motion-reduce:transition-none"
            data-slot="select-indicator"
          >
            <ChevronDownIcon />
          </ArkSelect.Indicator>
        </div>
      </ArkSelect.Trigger>
    </ArkSelect.Control>
  );
};

// Decorative: a listbox may only contain options and groups, so no separator role.
export const SelectSeparator = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      aria-hidden
      className={cn('pointer-events-none -mx-1.5 my-1.5 h-px bg-border/60', className)}
      data-slot="select-separator"
      {...rest}
    />
  );
};

export const SelectValue = (props: React.ComponentProps<typeof ArkSelect.ValueText>) => {
  const { className, ...rest } = props;

  return (
    <ArkSelect.ValueText
      className={cn('min-w-0', 'flex items-center gap-2', 'truncate text-nowrap', className)}
      {...rest}
    />
  );
};

export const SelectContent = (props: React.ComponentProps<typeof ArkSelect.Content> & { portalled?: boolean }) => {
  const { className, portalled = true, ...rest } = props;

  const content = (
      <ArkSelect.Positioner data-slot="select-positioner">
        <ArkSelect.Content
          className={cn(
            'z-50',
            'relative',
            'max-h-96 min-w-(--reference-width)',
            'p-1.5',
            'bg-popover',
            'text-popover-foreground',
            'rounded-2xl border border-border/60 shadow-(--aura-shadow-float)',
            'origin-(--transform-origin)',
            'outline-none',
            'overflow-y-auto',
            'duration-100',
            'data-[state=open]:animate-in',
            'data-[state=open]:fade-in-0',
            'data-[state=open]:zoom-in-[98%]',
            'data-[placement=bottom]:slide-in-from-top-2',
            'data-[placement=left]:slide-in-from-end-2',
            'data-[placement=right]:slide-in-from-start-2',
            'data-[placement=top]:slide-in-from-bottom-2',
            'motion-reduce:animate-none!',
            className,
          )}
          data-slot="select-content"
          {...rest}
        />
      </ArkSelect.Positioner>
  );
  return portalled ? <Portal>{content}</Portal> : content;
};

interface SelectGroupProps extends React.ComponentProps<typeof ArkSelect.ItemGroup> {
  /**
   * The heading of the group
   */
  heading?: string | React.ReactNode;
}

export const SelectGroup = (props: SelectGroupProps) => {
  const { heading, children, ...rest } = props;

  return (
    <ArkSelect.ItemGroup data-slot="select-group" {...rest}>
      {!!heading && <SelectGroupLabel>{heading}</SelectGroupLabel>}

      {children}
    </ArkSelect.ItemGroup>
  );
};

export const SelectGroupLabel = (props: React.ComponentProps<typeof ArkSelect.ItemGroupLabel>) => {
  const { className, ...rest } = props;

  return (
    <ArkSelect.ItemGroupLabel
      className={cn('px-3 py-1.5', 'font-semibold text-muted-foreground text-xs', className)}
      data-slot="select-group-label"
      {...rest}
    />
  );
};

export const SelectItem = (props: React.ComponentProps<typeof ArkSelect.Item>) => {
  const { className, children, ...rest } = props;

  return (
    <ArkSelect.Item
      className={cn(
        'relative',
        'w-full',
        'py-2 ps-3 pe-9',
        'flex items-center gap-2',
        'select-none text-base md:text-sm',
        'rounded-xl',
        'cursor-default',
        'outline-hidden',
        'in-[[data-slot=select-content]:has([data-slot=select-group-label])]:ps-5',
        'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        'data-[state=checked]:font-medium data-[state=checked]:text-primary',
        'data-highlighted:data-[state=checked]:text-accent-foreground',
        'data-disabled:pointer-events-none data-disabled:opacity-64',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        "[&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      data-slot="select-item"
      {...rest}
    >
      <ArkSelect.ItemText
        className="flex w-full flex-1 items-center gap-2"
        data-slot="select-item-text"
      >
        {children}
      </ArkSelect.ItemText>

      <span className="absolute inset-e-3 flex size-4 items-center justify-center">
        <ArkSelect.ItemIndicator data-slot="select-item-indicator">
          <CheckIcon className="text-current" />
        </ArkSelect.ItemIndicator>
      </span>
    </ArkSelect.Item>
  );
};

export const SelectClearTrigger = (props: React.ComponentProps<typeof ArkSelect.ClearTrigger>) => {
  const { className, ...rest } = props;
  const copy = useUiCopy();

  return (
    <ArkSelect.ClearTrigger
      aria-label={copy.clearSelected}
      className={cn(
        '[&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        'transition-opacity',
        'opacity-64',
        'outline-none focus-visible:opacity-100',
        'hover:opacity-100',
        'motion-reduce:transition-none!',
        className,
      )}
      data-slot="select-clear-trigger"
      {...rest}
    />
  );
};

export const SelectEmpty = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  // Zag's `empty` means "nothing selected"; this part is for a list with no options.
  const { collection } = useSelectContext();

  if (collection.size === 0) {
    return (
      // A listbox must contain options, so the message is a disabled one.
      <ark.div
        aria-disabled
        aria-selected={false}
        className={cn('px-3 py-2', 'text-center text-muted-foreground text-sm', className)}
        data-slot="select-empty"
        role="option"
        {...rest}
      />
    );
  }

  return null;
};
