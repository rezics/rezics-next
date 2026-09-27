'use client';

import {
  Highlight as ArkHighlight,
  useHighlight as useArkHighlight,
} from '@ark-ui/react/highlight';
import type React from 'react';
import { cn } from '../utils.ts';

export const useHighlight = useArkHighlight;

export const Highlight = (props: React.ComponentProps<typeof ArkHighlight>) => {
  const { className, ...rest } = props;

  return (
    <ArkHighlight
      className={cn(
        'px-0.5',
        // Accent surface with its text-safe tone; ink blue on a blue tint falls
        // under 4.5:1.
        'bg-accent',
        'text-accent-foreground',
        'rounded-sm',
        'box-decoration-clone',
        className,
      )}
      data-slot="highlight"
      {...rest}
    />
  );
};
