'use client';

import { ark } from '@ark-ui/react/factory';
import { Popover as ArkPopover, usePopoverContext } from '@ark-ui/react/popover';
import { Portal } from '@ark-ui/react/portal';
import { XIcon } from 'lucide-react';
import React from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { ScrollArea } from './scroll-area.tsx';

export const usePopover = usePopoverContext;

/**
 * Names and describes popover content from its rendered title and description.
 * Zag looks for them once, when the machine starts, which is before `lazyMount`
 * renders the content, so a lazily mounted popover would be an unnamed dialog.
 */
export const usePopoverLabelling = (content: React.RefObject<HTMLElement | null>) => {
  const popover = usePopoverContext();
  const [hasTitle, setHasTitle] = React.useState(false);
  const [hasDescription, setHasDescription] = React.useState(false);

  React.useLayoutEffect(() => {
    setHasTitle(!!content.current?.querySelector('[data-scope=popover][data-part=title]'));
    setHasDescription(
      !!content.current?.querySelector('[data-scope=popover][data-part=description]'),
    );
  });

  return {
    'aria-labelledby': hasTitle ? popover.getTitleProps().id : undefined,
    'aria-describedby': hasDescription ? popover.getDescriptionProps().id : undefined,
  };
};

export const Popover = (props: React.ComponentProps<typeof ArkPopover.Root>) => {
  const { lazyMount = true, unmountOnExit = true, modal = true, ...rest } = props;

  return (
    <ArkPopover.Root
      data-slot="popover"
      lazyMount={lazyMount}
      modal={modal}
      unmountOnExit={unmountOnExit}
      {...rest}
    />
  );
};

export const PopoverTrigger = (props: React.ComponentProps<typeof ArkPopover.Trigger>) => (
  <ArkPopover.Trigger data-slot="popover-trigger" {...props} />
);

export const PopoverAnchor = (props: React.ComponentProps<typeof ArkPopover.Anchor>) => (
  <ArkPopover.Anchor data-slot="popover-anchor" {...props} />
);

export const PopoverPositioner = (props: React.ComponentProps<typeof ArkPopover.Positioner>) => (
  <ArkPopover.Positioner data-slot="popover-positioner" {...props} />
);

interface PopoverContentProps extends React.ComponentProps<typeof ArkPopover.Content> {
  /**
   * Show close button at the top right corner
   *
   * @default true
   */
  showCloseButton?: boolean;
}

export const PopoverContent = (props: PopoverContentProps) => {
  const { showCloseButton = false, className, children, ...rest } = props;

  const content = React.useRef<HTMLDivElement>(null);
  const labelling = usePopoverLabelling(content);

  return (
    <Portal>
      <PopoverPositioner>
        <ArkPopover.Content
          {...labelling}
          ref={content}
          className={cn(
            'relative',
            'z-[calc(50+var(--layer-index,0))]',
            '[--space:--spacing(4)]',
            'w-auto min-w-32',
            'flex flex-col',
            'bg-popover',
            'text-popover-foreground',
            'rounded-2xl border border-border/60 shadow-(--aura-shadow-float)',
            'outline-hidden',
            'origin-(--transform-origin)',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-[98%] data-[state=open]:zoom-in-[98%]',
            'data-[state=closed]:animate-out data-[state=open]:animate-in',
            'data-[placement=bottom]:slide-in-from-top-2',
            'data-[placement=left]:slide-in-from-end-2',
            'data-[placement=right]:slide-in-from-start-2',
            'data-[placement=top]:slide-in-from-bottom-2',
            'motion-reduce:animate-none!',
            className,
          )}
          data-slot="popover-content"
          {...rest}
        >
          {children}

          {!!showCloseButton && (
            <PopoverClose asChild>
              <Button
                aria-label="Close"
                className="absolute inset-e-2 top-2 opacity-64 hover:opacity-100"
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </PopoverClose>
          )}
        </ArkPopover.Content>
      </PopoverPositioner>
    </Portal>
  );
};

interface PopoverHeaderProps extends React.ComponentProps<typeof ark.div> {
  /**
   * The description of the popover header
   */
  description?: string;
  /**
   * The title of the popover header
   */
  title?: string;
}

export const PopoverHeader = (props: PopoverHeaderProps) => {
  const { title, description, children, className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'flex flex-col gap-2 p-(--space)',
        'in-[[data-slot=popover-content]:has([data-slot=popover-body])]:pb-3',
        className,
      )}
      data-slot="popover-header"
      {...rest}
    >
      {!!title && <PopoverTitle>{title}</PopoverTitle>}
      {!!description && <PopoverDescription>{description}</PopoverDescription>}
      {!title && typeof children === 'string' ? <PopoverTitle>{children}</PopoverTitle> : children}
    </ark.div>
  );
};

export const PopoverTitle = (props: React.ComponentProps<typeof ArkPopover.Title>) => {
  const { className, ...rest } = props;

  return (
    <ArkPopover.Title
      className={cn('font-semibold text-base leading-none', className)}
      data-slot="popover-title"
      {...rest}
    />
  );
};

export const PopoverDescription = (props: React.ComponentProps<typeof ArkPopover.Description>) => {
  const { className, ...rest } = props;

  return (
    <ArkPopover.Description
      className={cn('text-muted-foreground text-sm', className)}
      data-slot="popover-description"
      {...rest}
    />
  );
};

export const PopoverBody = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ScrollArea>
      <ark.div
        className={cn(
          'flex-1',
          'p-(--space)',
          'overflow-auto',
          'in-[[data-slot=popover-content]:has([data-slot=popover-header])]:pt-1',
          'in-[[data-slot=popover-content]:has([data-slot=popover-footer]:not(.border-t))]:pb-1',
          className,
        )}
        data-slot="popover-body"
        {...rest}
      />
    </ScrollArea>
  );
};

export const PopoverFooter = (props: React.ComponentProps<typeof ark.div>) => {
  const { className, ...rest } = props;

  return (
    <ark.div
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        'sm:rounded-b-[calc(var(--radius-2xl)-1px)]',
        'px-(--space) py-4',
        'bg-muted/64',
        'border-t',
        className,
      )}
      data-slot="popover-footer"
      {...rest}
    />
  );
};

export const PopoverClose = (props: React.ComponentProps<typeof ArkPopover.CloseTrigger>) => (
  <ArkPopover.CloseTrigger data-slot="popover-close-trigger" {...props} />
);

export const PopoverArrow = (props: React.ComponentProps<typeof ArkPopover.Arrow>) => {
  const { style, ...rest } = props;

  return (
    <ArkPopover.Arrow
      data-slot="popover-arrow"
      style={
        {
          '--arrow-background': 'var(--popover)',
          '--arrow-size': 'calc(1.5 * var(--spacing))',
          ...style,
        } as React.CSSProperties
      }
      {...rest}
    >
      <ArkPopover.ArrowTip className="border-s border-t" />
    </ArkPopover.Arrow>
  );
};
