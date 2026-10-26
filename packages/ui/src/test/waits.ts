import { expect, screen, waitFor } from 'storybook/test';

/**
 * Waits for the layer with this role to leave the document. A layer leaves after its exit animation and the frame
 * that follows it, so the wait lasts as long as the other waits in stories (`.storybook/preview.tsx`).
 */
export const dismissed = (role: 'dialog' | 'alertdialog' | 'menu' | 'tooltip' | 'status') =>
  waitFor(() => expect(screen.queryByRole(role)).not.toBeInTheDocument());

/** Waits for the menu or list item to take the highlight, which a layer moves on a later frame than it opens. */
export const highlighted = (item: () => HTMLElement) =>
  waitFor(() => expect(item()).toHaveAttribute('data-highlighted'));

/**
 * Waits for a layer to register with the dismissable stack, which installs its Escape and outside-interaction
 * handlers on the frame after it opens; a key pressed earlier is lost. The stack marks the layer, or the element
 * that positions it, with `--layer-index` in the same step.
 */
export const registered = (layer: Element) =>
  waitFor(() => {
    for (let element: Element | null = layer; element; element = element.parentElement) {
      if ((element as HTMLElement).style.getPropertyValue('--layer-index') !== '') return;
    }
    throw new Error('The layer has not registered as dismissable yet');
  });
