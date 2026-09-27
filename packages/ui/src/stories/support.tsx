import type { Decorator } from '@storybook/react-vite';
import React from 'react';
import { cn } from '../utils.ts';

/** Story parameters read by {@link withTheme}. */
export interface ThemeParameters {
  /** Render the story in Rezics Aura dark mode. */
  theme?: 'light' | 'dark';
  /** Pad the page ground; turn off for full-bleed layouts such as a sidebar. */
  padded?: boolean;
}

const ThemeFrame = (props: Required<ThemeParameters> & { children: React.ReactNode }) => {
  const { theme, padded, children } = props;

  // The class goes on <html>, not only on the frame, so portaled layers such as
  // dialogs, menus and toasts pick up the dark tokens too.
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    // The web app's unlayered legacy `body` rule sets a serif face that beats any
    // layered utility, and portaled layers inherit it; only an inline style wins.
    document.body.style.fontFamily = 'var(--font-sans)';

    return () => {
      root.classList.remove('dark');
      root.style.colorScheme = '';
      document.body.style.fontFamily = '';
    };
  }, [theme]);

  return (
    <div className={cn('min-h-svh bg-background font-sans text-foreground', padded && 'p-6')}>
      {children}
    </div>
  );
};

/**
 * Paints the Rezics page ground around a Rezics UI story, in light or dark mode,
 * until the Storybook config gains a global theme toolbar. Set
 * `parameters: { theme: 'dark' }` on a story to render it dark.
 */
export const withTheme: Decorator = (Story, context) => {
  const { theme = 'light', padded = true } = context.parameters as ThemeParameters;

  return (
    <ThemeFrame padded={padded} theme={theme}>
      <Story />
    </ThemeFrame>
  );
};

/**
 * Resolves once the finite animations of the element's layer finish, and returns the element,
 * so play functions assert on, and screenshots capture, a settled layer rather
 * than a mid-fade frame. Spinners and other infinite animations are ignored.
 */
export const settled = async <T extends Element>(element: T): Promise<T> => {
  // Settle the whole layer: portaled content animates on its positioner and ancestors too.
  let layer: Element = element;
  while (layer.parentElement && layer.parentElement !== layer.ownerDocument.body) {
    layer = layer.parentElement;
  }
  const finite = layer
    .getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
  await Promise.allSettled(finite.map((animation) => animation.finished));
  return element;
};
