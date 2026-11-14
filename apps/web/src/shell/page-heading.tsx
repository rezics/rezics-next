import type { ComponentProps } from 'react';
import { cn } from '@rezics/ui/utils';

const headingClass =
  'min-w-0 scroll-mt-[calc(var(--shell-header-height,4rem)+1rem)] text-3xl font-semibold tracking-tight text-balance wrap-anywhere sm:text-4xl';

export function PageHeading({ className, ...props }: ComponentProps<'h1'>) {
  return <h1 className={cn(headingClass, className)} {...props} />;
}
