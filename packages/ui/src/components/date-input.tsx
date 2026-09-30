'use client';

import {
  DateInput as ArkDateInput,
  useDateInput as useArkDateInput,
  useDateInputContext as useArkDateInputContext,
} from '@ark-ui/react/date-input';
import { XIcon } from 'lucide-react';
import type React from 'react';
import { useUiCopy } from '../i18n/copy.ts';
import { cn } from '../utils.ts';
import { FieldLabel } from './field.tsx';
import type { InputProps } from './input.tsx';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  type InputGroupProps,
} from './input-group.tsx';

export const useDateInput = useArkDateInput;

/** Date Input does not read Field context, so it takes its own label part. */
export const DateInputLabel = (props: React.ComponentProps<typeof ArkDateInput.Label>) => (
  <FieldLabel asChild>
    <ArkDateInput.Label data-slot="date-input-label" {...props} />
  </FieldLabel>
);
export const useDateInputContext = useArkDateInputContext;

interface DateInputProps
  extends React.ComponentProps<typeof ArkDateInput.Root>,
    Pick<InputProps, 'size'> {
  /**
   * The separator to show between the date input fields.
   *
   * @default "-"
   */
  separator?: string | React.ReactNode;
  /**
   * Whether to show the clear button.
   *
   * @default false
   */
  showClear?: boolean;
}

interface DateInputControlProps
  extends React.ComponentProps<typeof ArkDateInput.Root>,
    Pick<InputGroupProps, 'size'> {
  /**
   * Whether to show the clear button.
   *
   * @default false
   */
  showClear: boolean;
}

export const DateInput = (props: DateInputProps) => {
  const {
    size = 'md',
    showClear = false,
    selectionMode = 'single',
    shouldForceLeadingZeros = true,
    separator = '-',
    className,
    children,
    ...rest
  } = props;

  return (
    <ArkDateInput.Root
      className={cn('group/date-input', 'flex w-full flex-col items-start gap-2', className)}
      data-size={size}
      data-slot="date-input"
      selectionMode={selectionMode}
      shouldForceLeadingZeros={shouldForceLeadingZeros}
      {...rest}
    >
      {/* Children render above the control, for a DateInputLabel. */}
      {children}
      <DateInputControl showClear={showClear} size={size}>
        <DateInputSegmentGroup index={0} />
        {selectionMode === 'range' && (
          <>
            <span
              aria-hidden
              className="pointer-events-none select-none text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0"
            >
              {separator}
            </span>
            <DateInputSegmentGroup index={1} />
          </>
        )}
      </DateInputControl>
      <ArkDateInput.HiddenInput index={0} key="date-input-hidden-0" />
      {selectionMode === 'range' && (
        <ArkDateInput.HiddenInput index={1} key="date-input-hidden-1" />
      )}
    </ArkDateInput.Root>
  );
};

const DateInputControl = (props: DateInputControlProps) => {
  const { size = 'md', showClear, children } = props;

  const dateInput = useArkDateInputContext();
  const copy = useUiCopy();
  const hasValue = dateInput.value.length > 0;

  return (
    <ArkDateInput.Control asChild data-slot="date-input-control">
      <InputGroup
        className={cn(
          'px-3',
          'data-disabled:pointer-events-none data-disabled:opacity-64',
          'has-data-[slot=date-input-clear]:pr-0',
        )}
        size={size}
      >
        <div
          aria-invalid={dateInput.invalid || undefined}
          className={cn('min-w-0', 'flex flex-1 items-center gap-2', 'text-base md:text-sm')}
          data-slot="date-input-field"
        >
          {children}
        </div>
        {showClear && hasValue && !dateInput.disabled && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={copy.clearDate}
              data-slot="date-input-clear"
              onClick={() => dateInput.clearValue()}
              size="icon-xs"
              variant="ghost"
            >
              <XIcon aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </ArkDateInput.Control>
  );
};

const DateInputSegmentGroup = (props: React.ComponentProps<typeof ArkDateInput.SegmentGroup>) => {
  const { index = 0, className, ...rest } = props;

  return (
    <ArkDateInput.SegmentGroup
      className={cn('flex min-w-0 items-center gap-px', className)}
      data-slot="date-input-segment-group"
      index={index}
      {...rest}
    >
      <ArkDateInput.SegmentContext>
        {(segment) => <DateInputSegment segment={segment} />}
      </ArkDateInput.SegmentContext>
    </ArkDateInput.SegmentGroup>
  );
};

const DateInputSegment = (props: React.ComponentProps<typeof ArkDateInput.Segment>) => {
  const { className, ...rest } = props;

  return (
    <ArkDateInput.Segment
      className={cn(
        'tabular-nums',
        'rounded-sm border-0 shadow-none ring-0',
        'not-data-[type=literal]:px-0.5',
        'not-data-[type=literal]:focus:bg-primary not-data-[type=literal]:focus:text-primary-foreground',
        'data-[type=literal]:select-none data-[type=literal]:px-px data-[type=literal]:text-muted-foreground',
        // Placeholder segments are real text, so they need the full muted tone for 4.5:1.
        'data-placeholder-shown:text-muted-foreground',
        'outline-none',
        'data-readonly:cursor-default',
        'group-aria-invalid/date-input:text-destructive group-data-invalid/date-input:text-destructive',
        'not-data-[type=literal]:focus:group-data-invalid/date-input:bg-destructive not-data-[type=literal]:focus:group-data-invalid/date-input:text-white',
        'dark:group-data-invalid/date-input:text-destructive-foreground dark:group-aria-invalid/date-input:text-destructive-foreground',
        'dark:not-data-[type=literal]:focus:group-data-invalid/date-input:bg-destructive-foreground dark:not-data-[type=literal]:focus:group-data-invalid/date-input:text-white',
        className,
      )}
      data-slot="date-input-segment"
      {...rest}
    />
  );
};
