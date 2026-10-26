import type { ComponentProps } from 'react';

const headingClass = 'text-4xl font-semibold tracking-tight text-balance';

export function PageHeading({ className, ...props }: ComponentProps<'h1'>) {
  return <h1 className={className ? `${headingClass} ${className}` : headingClass} {...props} />;
}
