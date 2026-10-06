'use client';

import { Checkbox as ArkCheckbox, useCheckboxContext } from '@ark-ui/react/checkbox';
import { ark } from '@ark-ui/react/factory';
import { CheckIcon, MinusIcon } from 'lucide-react';
import React from 'react';
import { tv } from 'tailwind-variants';
import { cn } from '../utils.ts';

export const useCheckbox = useCheckboxContext;

export const CheckboxGroup = (props: React.ComponentProps<typeof ArkCheckbox.Group>) => {
  const { className, ...rest } = props;

  return (
    <ArkCheckbox.Group
      className={cn('flex flex-col gap-2', className)}
      data-slot="checkbox-group"
      {...rest}
    />
  );
};

// Aura's 20px control with a 2px border. The radius is 6px rather than the rounded-sm the
// radius table lists, because at this size 12px reads as a radio button. The unchecked
// border uses 75% muted-foreground to reach WCAG's 3:1 for control edges; --border is ~1.3:1.
export const checkboxVariants = tv({
  base: [
    'relative',
    'inline-flex shrink-0 items-center justify-center',
    'size-5',
    'bg-primary/5',
    'rounded-[6px] border-2 border-muted-foreground/75 shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)]',
    'transition-[border-color,background-color,box-shadow]',
    'hover:border-primary/50 hover:bg-accent/40',
    // The native input lies over the control, so the pointer is never over the control itself.
    'group-hover/checkbox:border-primary/50 group-hover/checkbox:bg-accent/40',
    'data-focus-visible:ring-2 data-focus-visible:ring-ring data-focus-visible:ring-offset-2 data-focus-visible:ring-offset-background',
    'data-disabled:pointer-events-none data-disabled:opacity-64',
    'data-[state=checked]:border-primary data-[state=checked]:shadow-[0_2px_8px_-2px] data-[state=checked]:shadow-primary/30',
    'data-[state=indeterminate]:border-primary',
    'data-invalid:border-destructive data-invalid:ring-[3px] data-invalid:ring-destructive/24',
    'dark:data-invalid:border-destructive-foreground dark:data-invalid:ring-destructive-foreground/24',
    'motion-reduce:transition-none!',
  ],
});

export const Checkbox = (props: React.ComponentProps<typeof ArkCheckbox.Root>) => {
  // The native input owns the checkbox role. A role forwarded to Ark's label
  // creates a second checkbox and is invalid on a label.
  const { className, tabIndex, children, role: _role, ...rest } = props;

  return (
    <ArkCheckbox.Root
      className={cn(
        'group/checkbox',
        children ? 'inline-flex items-center gap-2' : checkboxVariants(),
        className,
      )}
      data-slot="checkbox"
      {...rest}
    >
      <ArkCheckbox.Control
        className={children ? checkboxVariants() : undefined}
        data-slot="checkbox-control"
      >
        <CheckboxIndicator>
          <CheckIcon />
        </CheckboxIndicator>

        <CheckboxIndicator indeterminate>
          <MinusIcon />
        </CheckboxIndicator>
      </ArkCheckbox.Control>

      {children ? <ArkCheckbox.Label>{children}</ArkCheckbox.Label> : null}

      <CheckboxHiddenInput tabIndex={tabIndex} />
    </ArkCheckbox.Root>
  );
};

// Zag syncs `indeterminate` onto the hidden input only when the state changes, so a
// checkbox that starts indeterminate would be announced as unchecked.
const CheckboxHiddenInput = (props: React.ComponentProps<typeof ArkCheckbox.HiddenInput>) => {
  const { indeterminate, checked, setChecked } = useCheckboxContext();
  const ref = React.useRef<HTMLInputElement>(null);
  const adopted = React.useRef(false);

  React.useLayoutEffect(() => {
    if (adopted.current || !ref.current) return;
    adopted.current = true;
    // HiddenInput uses defaultChecked. A native click before hydration must
    // also become the machine's value before its next state change syncs it.
    if (!indeterminate && ref.current.checked !== checked) setChecked(ref.current.checked);
  }, [checked, indeterminate, setChecked]);

  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return <ArkCheckbox.HiddenInput ref={ref} style={nativeControl} {...props} />;
};

// The native input is what pointers and automation reach: unpainted and the size of the control, at the
// control's place (the first item of the root, or the root itself). A clipped, 1px input could only be
// activated through its label, which pointer-driven tools such as Playwright's `check()` refuse to do.
// It is not made transparent with opacity, so it still counts as visible to testing-library.
const nativeControl = {
  appearance: 'none',
  background: 'transparent',
  outline: 'none',
  clip: 'auto',
  margin: 0,
  width: '1.25rem',
  height: '1.25rem',
  overflow: 'visible',
  cursor: 'inherit',
} satisfies React.CSSProperties;

export const CheckboxIndicator = (props: React.ComponentProps<typeof ArkCheckbox.Indicator>) => {
  const { className, indeterminate, ...rest } = props;
  const context = useCheckboxContext();
  const classes = cn(
    'absolute -inset-0.5',
    'flex items-center justify-center',
    'rounded-[6px]',
    '[&_svg]:size-3.5 [&_svg]:stroke-3',
    'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
    'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
    'data-[state=unchecked]:hidden',
    // Native label clicks work before hydration; show their actual value.
    !indeterminate && [
      'data-[state=indeterminate]:hidden',
      'group-has-checked/checkbox:data-[state=unchecked]:flex!',
      'group-has-checked/checkbox:data-[state=indeterminate]:flex!',
      'group-has-checked/checkbox:bg-primary group-has-checked/checkbox:text-primary-foreground',
      'group-has-[input:not(:checked)]/checkbox:data-[state=checked]:hidden!',
    ],
    indeterminate && 'group-has-checked/checkbox:data-[state=indeterminate]:hidden!',
    'data-[state=checked]:zoom-in-50 data-[state=checked]:animate-in data-[state=checked]:duration-200',
    'motion-reduce:animate-none!',
    className,
  );
  if (indeterminate)
    return (
      <ArkCheckbox.Indicator
        indeterminate
        className={classes}
        data-slot="checkbox-indicator"
        {...rest}
      />
    );
  // Ark's hidden attribute is tied to machine state. Native :checked must be
  // able to reveal this indicator even before that machine has hydrated.
  const { hidden: _hidden, ...native } = context.getIndicatorProps();
  return <ark.div {...native} className={classes} data-slot="checkbox-indicator" {...rest} />;
};
