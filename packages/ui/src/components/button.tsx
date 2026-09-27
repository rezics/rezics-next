import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '../utils.ts';
import { Spinner } from './spinner.tsx';

export const buttonVariants = tv({
  base: [
    'relative',
    'inline-flex shrink-0 items-center justify-center gap-2',
    'whitespace-nowrap font-medium text-sm',
    'rounded-xl',
    'transition-all',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/32',
    'disabled:pointer-events-none disabled:opacity-64',
    'data-disabled:pointer-events-none data-disabled:opacity-64',
    'aria-disabled:pointer-events-none aria-disabled:opacity-64',
    'data-[state=loading]:pointer-events-none',
    'aria-invalid:border-destructive aria-invalid:ring-destructive/24',
    "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    'motion-reduce:transition-none!',
  ],
  variants: {
    variant: {
      default: [
        'bg-primary',
        'border border-transparent shadow-(--aura-shadow-card)',
        'text-primary-foreground',
        'hover:bg-primary/90 hover:shadow-(--aura-shadow-card-hover)',
        'focus-visible:border-background',
      ],
      outline: [
        'bg-transparent',
        'text-foreground',
        'border border-border/70 bg-background',
        'hover:bg-accent/60 hover:text-accent-foreground hover:border-primary/40',
        'dark:bg-input/32 dark:hover:bg-input/64',
        'focus-visible:border-primary',
      ],
      destructive: [
        'bg-destructive',
        'text-white',
        'border border-transparent shadow-(--aura-shadow-card)',
        'hover:bg-destructive/90',
        'focus-visible:border-background focus-visible:ring-destructive-foreground/32',
      ],
      secondary: [
        'bg-secondary',
        'text-secondary-foreground',
        'border border-transparent shadow-xs',
        'focus-visible:border-primary',
        'hover:bg-secondary/80 hover:shadow-(--aura-shadow-card)',
      ],
      soft: [
        'bg-primary/10',
        'text-primary',
        'border border-transparent',
        'hover:bg-primary/20',
        'focus-visible:border-primary',
      ],
      ghost: [
        'hover:bg-accent hover:text-accent-foreground',
        'border border-transparent',
        'focus-visible:border-primary',
      ],
      link: [
        'text-primary',
        'underline-offset-4',
        'border border-transparent',
        'hover:underline',
        'focus-visible:border-primary',
      ],
    },
    size: {
      xs: [
        'h-6',
        'gap-1.5',
        'px-2.5',
        'text-xs',
        'rounded-lg',
        "[&_svg:not([class*='size-'])]:size-2.5",
      ],
      sm: ['h-8', 'px-3.5', 'gap-1.5', 'text-xs', "[&_svg:not([class*='size-'])]:size-3.5"],
      md: ['h-9', 'px-5', 'py-2'],
      lg: ['h-10', 'px-6', 'text-[15px]'],
      xl: ['h-11', 'px-8', 'text-base font-semibold', 'rounded-2xl'],
      'icon-xs': 'size-6 rounded-lg',
      'icon-sm': 'size-8',
      'icon-md': 'size-9',
      'icon-lg': 'size-10',
      'icon-xl': "size-11 rounded-2xl [&_svg:not([class*='size-'])]:size-5",
    },
    clickEffect: {
      true: 'active:not-aria-[haspopup]:scale-[0.98]',
    },
    pill: {
      true: [
        'rounded-full',
        'has-[>svg]:data-[size=xs]:pe-3',
        'has-[>svg]:data-[size=sm]:pe-3.5',
        'has-[>svg]:data-[size=md]:pe-4',
        'has-[>svg]:data-[size=lg]:pe-4.5',
        'has-[>svg]:data-[size=xl]:pe-5',
      ],
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'md',
    clickEffect: true,
    pill: false,
  },
});

export interface ButtonProps
  extends React.ComponentProps<typeof ark.button>,
    VariantProps<typeof buttonVariants> {
  /**
   * Apply a click effect to the button
   *
   * @default true
   */
  clickEffect?: boolean;
  /**
   * Show a loading indicator
   *
   * @default false
   */
  isLoading?: boolean;
}

export const Button = (props: ButtonProps) => {
  const {
    variant = 'default',
    size = 'md',
    clickEffect = true,
    pill = false,
    isLoading = false,
    className,
    children,
    ...rest
  } = props;

  return (
    <ark.button
      className={cn(buttonVariants({ variant, size, clickEffect, pill }), className)}
      data-size={size}
      data-slot="button"
      data-state={isLoading ? 'loading' : 'idle'}
      data-variant={variant}
      type="button"
      {...rest}
      aria-busy={isLoading}
      aria-disabled={isLoading}
    >
      {isLoading ? (
        <>
          <span aria-hidden className="invisible">
            {children}
          </span>

          <span className="sr-only">{children}</span>

          <span className="absolute inset-0 flex items-center justify-center">
            <Spinner aria-hidden />
          </span>
        </>
      ) : (
        children
      )}
    </ark.button>
  );
};
