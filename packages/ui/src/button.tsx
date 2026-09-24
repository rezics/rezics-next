import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from './utils.ts';

export const buttonVariants = tv({
  base: 'inline-flex min-h-11 items-center justify-center gap-2 rounded-[3px] border px-5 text-[15px] font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-50',
  variants: {
    variant: {
      primary: 'border-blue-700 bg-blue-700 text-white hover:bg-blue-800',
      outline: 'border-slate-300 bg-white text-slate-900 hover:border-blue-700 hover:text-blue-700',
      text: 'border-transparent bg-transparent text-blue-700 hover:underline',
    },
    size: { normal: 'min-h-11 px-5', compact: 'min-h-9 px-3' },
  },
  defaultVariants: { variant: 'primary', size: 'normal' },
});

export interface ButtonProps extends React.ComponentProps<typeof ark.button>,
  VariantProps<typeof buttonVariants> {}

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <ark.button {...props} type={type} className={cn(buttonVariants({ variant, size }), className)} />;
}
