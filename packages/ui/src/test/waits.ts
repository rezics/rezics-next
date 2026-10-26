import { expect, screen, userEvent, waitFor } from 'storybook/test';
import { waitForFocus } from './focus.ts';

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
export const registered = async <T extends Element>(layer: T): Promise<T> => {
  await waitFor(() => {
    for (let element: Element | null = layer; element; element = element.parentElement) {
      if ((element as HTMLElement).style.getPropertyValue('--layer-index') !== '') return;
    }
    throw new Error('The layer has not registered as dismissable yet');
  });
  return layer;
};

/**
 * Types into a combobox input one character at a time. storybook/test types faster than a real keyboard, and the
 * combobox rewrites the input on the frame after each key (it autofills the highlighted item), so a key typed before
 * that frame runs is lost. The popup must be open, and focus and the rewrite settled, before each next key.
 */
export const typeIntoPopup = async (input: HTMLElement, text: string) => {
  for (const [index, character] of [...text].entries()) {
    await userEvent.type(input, character);
    if (index === 0) await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'true'));
    await waitForFocus(input);
  }
};
