'use client';

import {
  ToggleGroup as ArkToggleGroup,
  useToggleGroupContext as useArkToggleGroupContext,
} from '@ark-ui/react/toggle-group';
import React from 'react';
import { tv } from 'tailwind-variants';
import { cn } from '../utils.ts';
import { buttonVariants } from './button.tsx';
import { type ToggleProps, toggleVariants } from './toggle.tsx';

export const useToggleGroup = useArkToggleGroupContext;

type ToggleGroupContextProps = Pick<ToggleProps, 'variant' | 'size'> & {
  /**
   * Gap between items.
   *
   * @default 0
   */
  spacing?: number;
};

const ToggleGroupContext = React.createContext({} as ToggleGroupContextProps);

interface ToggleGroupProps
  extends React.ComponentProps<typeof ArkToggleGroup.Root>,
    ToggleGroupContextProps {}

// Aura: items keep their own rounding. With no spacing, an outline group becomes one
// bordered tray and its items drop their borders, like a segmented control.
const toggleGroupVariants = tv({
  base: [
    'w-fit',
    'flex items-center gap-[--spacing(var(--gap))]',
    'rounded-2xl',
    'data-[spacing=0]:data-[variant=outline]:gap-1 data-[spacing=0]:data-[variant=outline]:border',
    'data-[spacing=0]:data-[variant=outline]:border-border/60 data-[spacing=0]:data-[variant=outline]:bg-card data-[spacing=0]:data-[variant=outline]:p-1',
  ],
  variants: {
    orientation: {
      horizontal: 'flex-row pointer-coarse:*:after:min-w-auto',
      vertical: 'flex-col items-stretch pointer-coarse:*:after:min-h-auto',
    },
  },
  defaultVariants: {
    orientation: 'horizontal',
  },
});

export const ToggleGroup = (props: ToggleGroupProps) => {
  const {
    multiple = true,
    orientation = 'horizontal',
    variant = 'ghost',
    size = 'md',
    spacing = 0,
    className,
    style,
    ...rest
  } = props;

  return (
    <ToggleGroupContext.Provider value={{ variant, size, spacing }}>
      <ArkToggleGroup.Root
        className={cn(toggleGroupVariants({ orientation }), className)}
        data-slot="toggle-group"
        data-spacing={spacing}
        data-variant={variant}
        multiple={multiple}
        orientation={orientation}
        style={
          {
            ...style,
            '--gap': spacing,
          } as React.CSSProperties
        }
        {...rest}
      />
    </ToggleGroupContext.Provider>
  );
};

interface ToggleGroupItemProps extends React.ComponentProps<typeof ArkToggleGroup.Item> {}

// The item carries the toggle styles itself: wrapping Ark's standalone Toggle would add a
// second state machine, a stale aria-pressed on role="radio" items and broken roving focus.
export const ToggleGroupItem = (props: ToggleGroupItemProps) => {
  const { className, ...rest } = props;

  const { variant = 'ghost', size = 'md', spacing } = _useToggleGroup();

  return (
    <ArkToggleGroup.Item
      className={cn(
        buttonVariants({ variant, clickEffect: false }),
        toggleVariants({ variant, size }),
        'shrink-0 focus:z-10 focus-visible:z-10',
        'data-[spacing=0]:data-[variant=outline]:border-transparent',
        'data-[spacing=0]:data-[variant=outline]:data-[state=off]:bg-transparent',
        'dark:data-[spacing=0]:data-[variant=outline]:data-[state=off]:bg-transparent',
        className,
      )}
      data-slot="toggle-group-item"
      data-spacing={spacing}
      data-variant={variant}
      {...rest}
    />
  );
};

const _useToggleGroup = () => {
  const context = React.useContext(ToggleGroupContext);

  if (!context) {
    throw new Error('useToggleGroupContext must be used within a ToggleGroup');
  }

  return context;
};
