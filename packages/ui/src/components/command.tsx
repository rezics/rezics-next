'use client';

import { Portal } from '@ark-ui/react';
import { Combobox as ArkCombobox } from '@ark-ui/react/combobox';
import { Dialog as ArkDialog } from '@ark-ui/react/dialog';
import { SearchIcon } from 'lucide-react';
import type React from 'react';
import { cn } from '../utils.ts';
import {
  Combobox,
  ComboboxControl,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  type ComboboxItem,
  comboboxItemVariants,
  useCombobox,
} from './combobox.tsx';
import {
  Dialog,
  type DialogContent,
  DialogHeader,
  DialogOverlay,
  DialogPositioner,
  DialogTrigger,
  dialogContentVariants,
  useDialogContentBehavior,
} from './dialog.tsx';
import type { InputProps } from './input.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput } from './input-group.tsx';
import { MenuShortcut } from './menu.tsx';
import { Separator } from './separator.tsx';

export const CommandDialog = Dialog;

export const CommandDialogTrigger = (props: React.ComponentProps<typeof DialogTrigger>) => (
  <DialogTrigger data-slot="command-dialog-trigger" {...props} />
);

interface CommandDialogContentProps extends React.ComponentProps<typeof DialogContent> {
  /**
   * The description of the dialog
   *
   * @default "Search for a command to run..."
   */
  description?: string;
  /**
   * The title of the dialog
   *
   * @default "Command Palette"
   */
  title?: string;
}

export const CommandDialogContent = (props: CommandDialogContentProps) => {
  const {
    size = 'lg',
    title = 'Command Palette',
    description = 'Search for a command to run...',
    className,
    children,
    ref,
    ...rest
  } = props;
  const { ref: mergedRef } = useDialogContentBehavior(ref);

  return (
    <Portal>
      <DialogOverlay />

      <DialogPositioner>
        <ArkDialog.Content
          className={cn(
            'max-sm:row-start-1',
            dialogContentVariants({ size }),
            'border-0 p-0',
            className,
          )}
          data-slot="command-dialog-content"
          ref={mergedRef}
          {...rest}
        >
          <DialogHeader className="sr-only" description={description} title={title} />

          {children}
        </ArkDialog.Content>
      </DialogPositioner>
    </Portal>
  );
};

/**
 * A searchable list of destinations and actions, filtered as the reader types and driven entirely
 * by keyboard. On REZICS it is the ⌘K palette for jumping to a Work, a Realm or an action such as
 * “Create a post”, shown inline or in `CommandDialog`. Build it from an Ark list collection so
 * filtering and grouping stay in one place; for choosing a form value use a combobox instead.
 * The popup dialog is labelled “Command palette” by default; pass `aria-label` to override it.
 */
export const Command: ArkCombobox.RootComponent = (props) => {
  const {
    lazyMount = true,
    unmountOnExit = true,
    className,
    children,
    'aria-label': ariaLabel = 'Command palette',
    ...rest
  } = props;

  return (
    <Combobox
      className={cn(
        'isolate',
        'flex min-h-0 flex-1 flex-col',
        'p-2',
        'bg-popover',
        'text-popover-foreground',
        'rounded-3xl border border-border/60',
        className,
      )}
      closeOnSelect={false}
      disableLayer
      inputBehavior="autohighlight"
      lazyMount={lazyMount}
      loopFocus={false}
      open
      selectionBehavior="clear"
      unmountOnExit={unmountOnExit}
      {...rest}
    >
      <ArkCombobox.Label className="sr-only">{ariaLabel}</ArkCombobox.Label>
      {children}
    </Combobox>
  );
};

interface CommandInputProps extends Omit<React.ComponentProps<typeof ArkCombobox.Input>, 'size'> {
  /**
   * The size of the input
   *
   * @default "md"
   */
  size?: InputProps['size'];
}

export const CommandContent = (props: React.ComponentProps<typeof ArkCombobox.Content>) => {
  const { className, ...rest } = props;

  // An empty listbox is invalid ARIA; hide it and let CommandEmpty, placed beside it, speak.
  const empty = useCombobox().collection.size === 0;

  return (
    <ArkCombobox.Content
      aria-label="Command results"
      hidden={empty || undefined}
      className={cn(
        'flex flex-1 flex-col',
        'max-h-(--available-height) min-h-0',
        '-mr-2',
        'outline-none',
        'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-foreground/20 overflow-auto overscroll-contain',
        '[:not(.has-[+[data-slot=command-footer]])]:rounded-b-3xl [:not(.has-[+[data-slot=command-footer]])]:border-b',
        className,
      )}
      data-slot="command-content"
      {...rest}
    />
  );
};

export const CommandInput = (props: CommandInputProps) => {
  const { size = 'md', className, ...rest } = props;

  return (
    <ComboboxControl className="mb-2">
      <InputGroup className={cn('rounded-2xl bg-input/32', className)} size={size}>
        <InputGroupAddon>
          <SearchIcon aria-hidden className="opacity-64" />
        </InputGroupAddon>
        {/* Input props such as aria-label and placeholder belong on the input, not the group. */}
        <ArkCombobox.Input asChild data-slot="command-input" {...rest}>
          <InputGroupInput autoFocus />
        </ArkCombobox.Input>
      </InputGroup>
    </ComboboxControl>
  );
};

// Ark renders CommandContent as a dialog; the options need a listbox parent.
export const CommandList = (props: React.ComponentProps<'div'>) => {
  const { className, ...rest } = props;

  return (
    <div className="max-h-72 min-h-0 flex-1">
      <div
        className={cn('flex flex-1 flex-col pr-2.5', className)}
        aria-label="Commands"
        data-slot="command-list"
        role="listbox"
        {...rest}
      />
    </div>
  );
};

/**
 * The no-results message. Place it beside CommandContent, which hides while empty.
 * The status region stays mounted so screen readers announce the message when it appears.
 */
export const CommandEmpty = (props: React.ComponentProps<typeof ComboboxEmpty>) => {
  const { className, children, ...rest } = props;

  return (
    <div data-slot="command-empty-status" role="status">
      <ComboboxEmpty
        className={cn('py-6 text-center text-muted-foreground text-sm', className)}
        data-slot="command-empty"
        {...rest}
      >
        {children || 'No results found.'}
      </ComboboxEmpty>
    </div>
  );
};

export const CommandGroup = (props: React.ComponentProps<typeof ComboboxGroup>) => (
  <ComboboxGroup data-slot="command-group" {...props} />
);

export const CommandGroupLabel = (props: React.ComponentProps<typeof ComboboxGroupLabel>) => (
  <ComboboxGroupLabel data-slot="command-group-label" {...props} />
);

export const CommandItem = (props: React.ComponentProps<typeof ComboboxItem>) => {
  const { className, ...rest } = props;

  return (
    <ArkCombobox.Item
      className={cn(comboboxItemVariants({ showIndicator: false }), className)}
      data-slot="command-item"
      persistFocus
      {...rest}
    />
  );
};

export const CommandSeparator = (props: React.ComponentProps<'div'>) => {
  const { className, ...rest } = props;

  return <Separator className={cn('my-2', className)} data-slot="command-separator" {...rest} />;
};

export const CommandShortcut = (props: React.ComponentProps<typeof MenuShortcut>) => (
  <MenuShortcut data-slot="command-shortcut" {...props} />
);

export const CommandFooter = (props: React.ComponentProps<'div'>) => {
  const { className, ...rest } = props;

  return (
    <div
      className={cn(
        'z-10',
        'flex items-center justify-between gap-2',
        '-m-2 mt-2 px-4 py-3',
        'bg-muted/48',
        'text-muted-foreground text-xs',
        'rounded-b-[calc(var(--radius-3xl)-1px)] border-t',
        className,
      )}
      data-slot="command-footer"
      {...rest}
    />
  );
};
