'use client';

import { Pagination as ArkPagination, usePaginationContext } from '@ark-ui/react/pagination';
import { ChevronLeft, ChevronRight, Ellipsis } from 'lucide-react';
import type React from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';

export const usePagination = usePaginationContext;

interface PaginationProps extends React.ComponentProps<typeof ArkPagination.Root> {}

export const Pagination = (props: PaginationProps) => {
  const { className, ...rest } = props;

  return (
    <ArkPagination.Root
      className={cn('mx-auto', 'w-full', 'flex justify-center gap-1', className)}
      data-slot="pagination"
      {...rest}
    />
  );
};

// Children replace the English label, for example with 上一页 in zh-CN.
export const PaginationPrevious = (
  props: React.ComponentProps<typeof ArkPagination.PrevTrigger>,
) => {
  const { children = 'Previous', ...rest } = props;

  return (
    <ArkPagination.PrevTrigger asChild data-slot="pagination-previous" {...rest}>
      <Button className="rounded-full" variant="ghost">
        <ChevronLeft className="rtl:rotate-180" />
        {children}
      </Button>
    </ArkPagination.PrevTrigger>
  );
};

export const PaginationNext = (props: React.ComponentProps<typeof ArkPagination.NextTrigger>) => {
  const { children = 'Next', ...rest } = props;

  return (
    <ArkPagination.NextTrigger asChild data-slot="pagination-next" {...rest}>
      <Button className="rounded-full" variant="ghost">
        {children}
        <ChevronRight className="rtl:rotate-180" />
      </Button>
    </ArkPagination.NextTrigger>
  );
};

export const PaginationItem = (props: React.ComponentProps<typeof ArkPagination.Item>) => {
  const { className, children, ...rest } = props;

  return (
    <ArkPagination.Item asChild data-slot="pagination-item" {...rest}>
      <Button
        className={cn(
          'tabular-nums',
          'rounded-full',
          'text-muted-foreground hover:text-foreground',
          'data-selected:bg-primary/10 data-selected:text-primary',
          className,
        )}
        size="icon-md"
        variant="ghost"
      >
        {children}
      </Button>
    </ArkPagination.Item>
  );
};

export const PaginationItems = (
  props: Omit<React.ComponentProps<typeof ArkPagination.Context>, 'children'>,
) => (
  <ArkPagination.Context {...props}>
    {({ pages }) =>
      pages.map((page, index) =>
        page.type === 'page' ? (
          <PaginationItem key={page.value} type="page" value={page.value}>
            {page.value}
          </PaginationItem>
        ) : (
          <PaginationEllipsis index={index} key={`ellipsis-${index}`} />
        ),
      )
    }
  </ArkPagination.Context>
);

interface PaginationItemLinkProps extends React.ComponentProps<typeof Button> {
  /**
   * The page number to link to.
   */
  page?: 'previous' | 'next' | number;
}

export const PaginationItemLink = (props: PaginationItemLinkProps) => {
  const { page, children, ...rest } = props;

  const pagination = usePaginationContext();

  const pageValue = () => {
    if (page === 'previous') {
      return pagination.previousPage;
    }

    if (page === 'next') {
      return pagination.nextPage;
    }

    return page;
  };

  if (typeof page === 'number') {
    return (
      <Button asChild variant="outline" {...rest}>
        <a href={`?page=${pageValue()}`}>{children}</a>
      </Button>
    );
  }

  return (
    <Button asChild variant="ghost" {...rest}>
      <a href={`?page=${pageValue()}`}>{children}</a>
    </Button>
  );
};

export const PaginationEllipsis = (props: React.ComponentProps<typeof ArkPagination.Ellipsis>) => {
  const { className, ...rest } = props;

  return (
    <ArkPagination.Ellipsis
      className={cn(
        'h-8 w-12',
        'flex items-end justify-center',
        'text-muted-foreground',
        'pointer-events-none select-none',
        '[&_svg]:size-4',
        className,
      )}
      data-slot="pagination-ellipsis"
      {...rest}
    >
      <Ellipsis />
    </ArkPagination.Ellipsis>
  );
};
