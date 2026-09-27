'use client';

import { Splitter as ArkSplitter, useSplitterContext } from '@ark-ui/react/splitter';
import { GripVertical } from 'lucide-react';
import type React from 'react';
import { cn } from '../utils.ts';

export const useResizable = useSplitterContext;

export const Resizable = (props: React.ComponentProps<typeof ArkSplitter.Root>) => {
  const { className, ...rest } = props;

  return (
    <ArkSplitter.Root className={cn('flex size-full', className)} data-slot="resizable" {...rest} />
  );
};

export const ResizablePanel = (props: React.ComponentProps<typeof ArkSplitter.Panel>) => (
  <ArkSplitter.Panel data-slot="resizable-panel" {...props} />
);

interface ResizableResizeTriggerProps
  extends React.ComponentProps<typeof ArkSplitter.ResizeTrigger> {
  /**
   * Whether to show the handle
   *
   * @default false
   */
  withHandle?: boolean;
}

export const ResizableResizeTrigger = (props: ResizableResizeTriggerProps) => {
  const { withHandle = false, className, ...rest } = props;

  return (
    <ArkSplitter.ResizeTrigger
      aria-label="Resize"
      className={cn(
        'relative bg-border/60',
        'flex w-px items-center justify-center',
        'transition-colors hover:bg-primary/40 data-dragging:bg-primary/60 motion-reduce:transition-none',
        'after:-translate-x-1/2 data-[orientation=vertical]:after:-translate-y-1/2',
        'after:absolute after:inset-s-1/2 after:inset-y-0 after:w-1',
        'outline-none focus-visible:bg-primary focus-visible:ring-[3px] focus-visible:ring-ring/32',
        'data-[orientation=vertical]:h-px data-[orientation=vertical]:w-full',
        'data-[orientation=vertical]:after:inset-s-0 data-[orientation=vertical]:after:h-1 data-[orientation=vertical]:after:w-full',
        'data-[orientation=vertical]:after:translate-x-0',
        '[&[data-orientation=vertical]>div]:rotate-90',
        className,
      )}
      data-slot="resizable-resize-trigger"
      {...rest}
    >
      {withHandle && (
        // Aura grip: a small card-colored pill with a hairline border.
        <div
          className={cn(
            'z-10',
            'h-5 w-4',
            'flex items-center justify-center',
            'bg-background',
            'rounded-lg border border-border/60 shadow-xs',
          )}
        >
          <GripVertical className="size-3 text-muted-foreground" />
        </div>
      )}
    </ArkSplitter.ResizeTrigger>
  );
};
