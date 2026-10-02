'use client';

import { Menu as ArkMenu, useMenuContext } from '@ark-ui/react/menu';
import type React from 'react';
import { cn } from '../utils.ts';
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from './menu.tsx';

export const useContextMenu = useMenuContext;

/**
 * A menu opened by right-click or long-press on an object, such as a Work cover on a shelf, a
 * chapter in a reading list or a row in a moderation queue. It is a shortcut only: every action in
 * it must also be reachable from a visible button or overflow menu, because touch and keyboard
 * readers may never open it. It opens with its top-left corner at the pointer, as the browser's own
 * menu does, and moves to another corner only where the view runs out.
 */
export const ContextMenu = ({ positioning, ...props }: React.ComponentProps<typeof Menu>) => (
  <Menu
    data-slot="context-menu"
    positioning={{
      placement: 'bottom-start',
      gutter: 2,
      flip: ['top-start', 'bottom-end', 'top-end'],
      ...positioning,
    }}
    {...props}
  />
);

export const ContextMenuTrigger = (props: React.ComponentProps<typeof ArkMenu.ContextTrigger>) => {
  const { className, ...rest } = props;

  return (
    <ArkMenu.ContextTrigger
      className={cn('cursor-default', className)}
      data-slot="context-menu-trigger"
      {...rest}
    />
  );
};

export const ContextMenuContent = (props: React.ComponentProps<typeof MenuContent>) => (
  <MenuContent data-slot="context-menu-content" {...props} />
);

export const ContextMenuGroup = (props: React.ComponentProps<typeof MenuGroup>) => (
  <MenuGroup data-slot="context-menu-group" {...props} />
);

export const ContextMenuSeparator = (props: React.ComponentProps<typeof MenuSeparator>) => (
  <MenuSeparator data-slot="context-menu-separator" {...props} />
);

export const ContextMenuItem = (props: React.ComponentProps<typeof MenuItem>) => (
  <MenuItem data-slot="context-menu-item" {...props} />
);

export const ContextMenuSub = (props: React.ComponentProps<typeof MenuSub>) => (
  <MenuSub data-slot="context-menu-sub" {...props} />
);

export const ContextMenuSubContent = (props: React.ComponentProps<typeof MenuContent>) => (
  <MenuSubContent data-slot="context-menu-sub-content" {...props} />
);

export const ContextMenuSubTrigger = (props: React.ComponentProps<typeof MenuSubTrigger>) => (
  <MenuSubTrigger data-slot="context-menu-sub-trigger" {...props} />
);

export const ContextMenuShortcut = (props: React.ComponentProps<typeof MenuShortcut>) => (
  <MenuShortcut data-slot="context-menu-shortcut" {...props} />
);
