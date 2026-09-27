'use client';

import { ark } from '@ark-ui/react/factory';
import { Pagination as ArkPagination, usePaginationContext } from '@ark-ui/react/pagination';
import { ChevronLeft, ChevronRight, Ellipsis } from 'lucide-react';
import React from 'react';
import { cn } from '../utils.ts';
import { Button, buttonVariants } from './button.tsx';

export const usePagination = usePaginationContext;

// With type="link" Zag gives triggers an href; they must render as anchors, not buttons.
const PaginationTypeContext = React.createContext<'button' | 'link'>('button');

const PaginationControl = (props: React.ComponentProps<typeof Button>) => {
  const { variant, size, className, children, ...rest } = props;
  const type = React.useContext(PaginationTypeContext);

  if (type === 'button') {
    return (
      <Button className={className} size={size} variant={variant} {...rest}>
        {children}
      </Button>
    );
  }

  // A link cannot be disabled natively: drop its href and mark it aria-disabled, which also
  // exempts the dimmed label from contrast checks. Button would overwrite aria-disabled.
  const { href, type: _buttonType, ...anchor } = rest as React.ComponentProps<'a'>;
  const disabled = (rest as Record<string, unknown>)['data-disabled'] !== undefined;

  return (
    <ark.a
      aria-disabled={disabled || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      data-size={size}
      data-variant={variant}
      href={disabled ? undefined : href}
      {...anchor}
    >
      {children}
    </ark.a>
  );
};

interface PaginationProps extends React.ComponentProps<typeof ArkPagination.Root> {}

/**
 * Moves through a long, stable, numbered list in fixed pages: a Work’s reviews, a Realm’s
 * moderation log, search results. Readers can jump to a page and share its URL (`type="link"` with
 * `getPageUrl`). Feeds that grow while you read, like a Realm’s Hot posts, should load more on
 * scroll instead. `PaginationPrevious` and `PaginationNext` take localized labels as children.
 */
export const Pagination = (props: PaginationProps) => {
  const { className, type = 'button', ...rest } = props;

  return (
    <PaginationTypeContext.Provider value={type}>
      <ArkPagination.Root
        className={cn('mx-auto', 'w-full', 'flex justify-center gap-1', className)}
        data-slot="pagination"
        type={type}
        {...rest}
      />
    </PaginationTypeContext.Provider>
  );
};

// Children replace the English label, for example with 上一页 in zh-CN.
export const PaginationPrevious = (
  props: React.ComponentProps<typeof ArkPagination.PrevTrigger>,
) => {
  const { children = 'Previous', ...rest } = props;

  return (
    <ArkPagination.PrevTrigger asChild data-slot="pagination-previous" {...rest}>
      <PaginationControl className="rounded-full" variant="ghost">
        <ChevronLeft className="rtl:rotate-180" />
        {children}
      </PaginationControl>
    </ArkPagination.PrevTrigger>
  );
};

export const PaginationNext = (props: React.ComponentProps<typeof ArkPagination.NextTrigger>) => {
  const { children = 'Next', ...rest } = props;

  return (
    <ArkPagination.NextTrigger asChild data-slot="pagination-next" {...rest}>
      <PaginationControl className="rounded-full" variant="ghost">
        {children}
        <ChevronRight className="rtl:rotate-180" />
      </PaginationControl>
    </ArkPagination.NextTrigger>
  );
};

export const PaginationItem = (props: React.ComponentProps<typeof ArkPagination.Item>) => {
  const { className, children, ...rest } = props;

  return (
    <ArkPagination.Item asChild data-slot="pagination-item" {...rest}>
      <PaginationControl
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
      </PaginationControl>
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
