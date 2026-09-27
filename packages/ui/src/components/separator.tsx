'use client';

import { ark } from '@ark-ui/react/factory';
import { cn } from '../utils.ts';

interface SeparatorProps extends React.ComponentProps<typeof ark.div> {
  /**
   * Whether the separator is purely visual. A decorative separator is hidden
   * from assistive technology, as inside a list where only list items belong.
   *
   * @default false
   */
  decorative?: boolean;
  /**
   * The orientation of the separator.
   *
   * @default "horizontal"
   */
  orientation?: 'horizontal' | 'vertical';
}

export const Separator = (props: SeparatorProps) => {
  const { orientation = 'horizontal', decorative = false, className, ...rest } = props;

  return (
    <ark.div
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        'shrink-0',
        'bg-border/60',
        'data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full',
        "data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-orientation={orientation}
      data-slot="separator"
      role={decorative ? 'none' : 'separator'}
      {...rest}
    />
  );
};
