import type { Decorator } from '@storybook/react-vite';
import { expect, screen, waitFor } from 'storybook/test';
import { cn } from '../utils.ts';

/** Story-specific layout; the global Storybook toolbar owns theme and locale. */
export interface SurfaceParameters {
  /** Pad the page ground; turn off for full-bleed layouts such as a sidebar. */
  padded?: boolean;
}

export const withSurface: Decorator = (Story, context) => {
  const { padded = true } = context.parameters as SurfaceParameters;

  return (
    <div className={cn('min-h-svh bg-background font-sans text-foreground', padded && 'p-6')}>
      <Story />
    </div>
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
  // Cap the wait: an animation that never plays (for example in a hidden frame) must not hang a test.
  const cap = new Promise((resolve) => setTimeout(resolve, 2000));
  await Promise.race([Promise.allSettled(finite.map((animation) => animation.finished)), cap]);
  return element;
};

/**
 * Waits for the layer with this role to leave the document. Exit animations can outlast
 * waitFor's one-second default when the whole suite runs in parallel.
 */
export const dismissed = (role: 'dialog' | 'alertdialog' | 'menu' | 'tooltip' | 'status') =>
  waitFor(() => expect(screen.queryByRole(role)).not.toBeInTheDocument(), { timeout: 3000 });
