'use client';

import { ark } from '@ark-ui/react/factory';
import React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';
import { Separator } from './separator.tsx';

// Items inside an ItemGroup become list items of its list role; a lone Item
// stays a plain group of content.
const ItemGroupContext = React.createContext(false);

export const ItemGroup = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ItemGroupContext.Provider value={true}>
      <ark.div
        className={cn('group/item-group', 'flex w-full flex-col gap-2', className)}
        data-slot="item-group"
        role="list"
        {...rest}
      />
    </ItemGroupContext.Provider>
  );
};

export const ItemSeparator = (props: React.ComponentProps<typeof Separator>) => {
  const { className, ...rest } = props;

  return (
    <Separator
      className={cn('my-1', className)}
      data-slot="item-separator"
      decorative
      orientation="horizontal"
      {...rest}
    />
  );
};

const itemVariants = tv({
  base: [
    'group/item',
    'flex w-full flex-wrap items-center',
    'gap-3 px-4 py-3.5',
    'in-data-[slot=menu-content]:p-0',
    'text-sm',
    'rounded-2xl border',
    'transition-[background-color,border-color,box-shadow] duration-200',
    'motion-reduce:transition-none',
    '[a&]:hover:bg-accent/40',
    'outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/32',
    "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  variants: {
    variant: {
      default: 'border-transparent',
      // Aura: the outline item is a card with the card shadows.
      outline: [
        'border-border/60 bg-card shadow-(--aura-shadow-card)',
        '[a&]:hover:border-primary/25 [a&]:hover:bg-card [a&]:hover:shadow-(--aura-shadow-card-hover)',
      ],
      muted: 'border-transparent bg-secondary/50',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

interface ItemProps
  extends React.ComponentProps<typeof ark.div>,
    VariantProps<typeof itemVariants> {}

export const Item = (props: ItemProps) => {
  const { variant = 'default', className, ...rest } = props;

  const inGroup = React.useContext(ItemGroupContext);

  return (
    <ark.div
      className={cn(itemVariants({ variant }), className)}
      data-slot="item"
      role={inGroup ? 'listitem' : undefined}
      data-variant={variant}
      {...rest}
    />
  );
};

const itemMediaVariants = tv({
  base: [
    'flex shrink-0 items-center justify-center gap-2',
    'group-has-data-[slot=item-description]/item:translate-y-0.5 group-has-data-[slot=item-description]/item:self-start',
    '[&_svg]:pointer-events-none',
  ],
  variants: {
    variant: {
      default: 'bg-transparent',
      icon: [
        'size-10',
        'rounded-xl border border-border/60 bg-secondary/60',
        'text-primary',
        "[&_svg:not([class*='size-'])]:size-5",
      ],
      // Item images are usually Work covers, which use the cover radius.
      image: ['size-10', 'rounded-sm', 'overflow-hidden', '[&_img]:size-full [&_img]:object-cover'],
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

interface ItemMediaProps
  extends React.ComponentProps<typeof ark.div>,
    VariantProps<typeof itemMediaVariants> {}

export const ItemMedia = (props: ItemMediaProps) => {
  const { variant = 'default', className, ...rest } = props;

  return (
    <ark.div
      className={cn(itemMediaVariants({ variant, className }))}
      data-slot="item-media"
      data-variant={variant}
      {...rest}
    />
  );
};

export const ItemContent = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'flex flex-1 flex-col gap-0.5',
        '[&+[data-slot=item-content]]:flex-none',
        className,
      )}
      data-slot="item-content"
      {...rest}
    />
  );
};

export const ItemTitle = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'w-fit',
        'flex items-center gap-2',
        'line-clamp-1 font-medium text-sm leading-snug',
        'underline-offset-4',
        className,
      )}
      data-slot="item-title"
      {...rest}
    />
  );
};

export const ItemDescription = (props: React.ComponentProps<typeof ark.p>) => {
  const { className, ...rest } = props;

  return (
    <ark.p
      className={cn(
        'line-clamp-2 text-left font-normal text-muted-foreground text-sm leading-normal',
        '[&>a:hover]:text-primary',
        '[&>a]:underline [&>a]:underline-offset-4',
        className,
      )}
      data-slot="item-description"
      {...rest}
    />
  );
};

export const ItemActions = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn('flex items-center gap-2', className)}
      data-slot="item-actions"
      {...rest}
    />
  );
};

export const ItemHeader = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'flex basis-full items-center justify-between gap-2',
        '[&_img]:size-full [&_img]:rounded-2xl [&_img]:object-cover',
        className,
      )}
      data-slot="item-header"
      {...rest}
    />
  );
};

export const ItemFooter = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn('flex basis-full items-center justify-between gap-2', className)}
      data-slot="item-footer"
      {...rest}
    />
  );
};
