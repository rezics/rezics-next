'use client';

import { ark } from '@ark-ui/react/factory';
import React from 'react';
import { cn } from '../utils.ts';

interface TableProps extends React.ComponentProps<typeof ark.table> {
  /**
   * Whether the table rows are hoverable.
   *
   * @default true
   */
  isHoverable?: boolean;
  /**
   * The variant of the table.
   *
   * @default "plain"
   */
  variant?: 'plain' | 'striped';
}

// Keyboard users must be able to scroll a table wider than its container
// (WCAG 2.1.1), so the wrapper joins the tab order only while it overflows.
const useOverflows = () => {
  const ref = React.useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = React.useState(false);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const measure = () =>
      setOverflows(
        element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) {
      observer.observe(element.firstElementChild);
    }
    measure();

    return () => observer.disconnect();
  }, []);

  return [ref, overflows] as const;
};

export const Table = (props: TableProps) => {
  const { variant = 'plain', isHoverable = true, className, ...rest } = props;

  const [wrapperRef, overflows] = useOverflows();

  return (
    // Aura tables sit in their own bordered container with a tinted header.
    <div
      className={cn(
        'relative w-full overflow-auto rounded-2xl border border-border/60 bg-card',
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32',
      )}
      data-slot="table-wrapper"
      ref={wrapperRef}
      tabIndex={overflows ? 0 : undefined}
    >
      <ark.table
        className={cn(
          'group/table',
          'w-full',
          'caption-bottom',
          'text-foreground text-sm',
          className,
        )}
        data-hoverable={isHoverable}
        data-slot="table"
        data-variant={variant}
        {...rest}
      />
    </div>
  );
};

export const TableHeader = (props: React.ComponentProps<typeof ark.thead>) => {
  const { className, ...rest } = props;

  return (
    <ark.thead
      className={cn('bg-secondary/50', '[&_tr]:border-border/60 [&_tr]:border-b', className)}
      data-slot="table-header"
      {...rest}
    />
  );
};

export interface TableBodyProps extends React.ComponentProps<typeof ark.tbody> {}

export const TableBody = (props: TableBodyProps) => {
  const { className, ...rest } = props;

  return (
    <ark.tbody
      className={cn('[&_tr:last-child]:border-0', className)}
      data-slot="table-body"
      {...rest}
    />
  );
};

export const TableFooter = (props: React.ComponentProps<typeof ark.tfoot>) => {
  const { className, ...rest } = props;

  return (
    <ark.tfoot
      className={cn(
        'border-border/60 border-t',
        'bg-secondary/40',
        'font-medium',
        'last:[&>tr]:border-b-0',
        className,
      )}
      data-slot="table-footer"
      {...rest}
    />
  );
};

export const TableRow = (props: React.ComponentProps<typeof ark.tr>) => {
  const { className, ...rest } = props;

  return (
    <ark.tr
      className={cn(
        'border-border/40 border-b',
        'transition-colors motion-reduce:transition-none',
        'group-data-[variant=striped]/table:even:bg-secondary/40',
        'group-data-[hoverable=true]/table:[&:has(td):hover]:bg-accent/40',
        'data-[state=selected]:bg-accent/70',
        className,
      )}
      data-slot="table-row"
      {...rest}
    />
  );
};

export const TableHead = (props: React.ComponentProps<typeof ark.th>) => {
  const { className, ...rest } = props;

  return (
    <ark.th
      className={cn(
        'h-11 px-4',
        'text-left align-middle',
        'whitespace-nowrap font-semibold text-foreground',
        'rtl:text-right',
        'has-[[role=checkbox]]:ps-2 has-[[role=checkbox]]:pe-0',
        className,
      )}
      data-slot="table-head"
      {...rest}
    />
  );
};

export const TableCell = (props: React.ComponentProps<typeof ark.td>) => {
  const { className, ...rest } = props;

  return (
    <ark.td
      className={cn(
        'whitespace-nowrap px-4 py-3 align-middle',
        'has-[[role=checkbox]]:ps-2 has-[[role=checkbox]]:pe-0',
        className,
      )}
      data-slot="table-cell"
      {...rest}
    />
  );
};

export const TableCaption = (props: React.ComponentProps<typeof ark.caption>) => {
  const { className, ...rest } = props;

  return (
    <ark.caption
      className={cn('mt-4', 'text-muted-foreground text-sm', className)}
      data-slot="table-caption"
      {...rest}
    />
  );
};
