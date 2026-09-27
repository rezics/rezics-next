'use client';

import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { cn } from '../utils.ts';

interface AspectRatioProps extends React.ComponentProps<typeof ark.div> {
  /**
   * Width divided by height, such as `2 / 3` for a Work cover.
   *
   * @default 1
   */
  ratio?: number;
}

export const AspectRatio = (props: AspectRatioProps) => {
  const { ratio, className, style, ...rest } = props;

  return (
    <ark.div
      className={cn(
        '[--ratio:1]',
        'relative',
        'w-full',
        'aspect-(--ratio)',
        'overflow-hidden',
        className,
      )}
      data-slot="aspect-ratio"
      style={ratio === undefined ? style : ({ '--ratio': ratio, ...style } as React.CSSProperties)}
      {...rest}
    />
  );
};
