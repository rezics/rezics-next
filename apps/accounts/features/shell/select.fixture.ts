import { expect, userEvent, waitFor, within } from 'storybook/test';

/** Exercise the visible styled menu, including selects portalled out of the canvas. */
export async function chooseOption(trigger: HTMLElement, value: string) {
  await userEvent.click(trigger);
  const document = trigger.ownerDocument;
  // Options are portalled; wait for this select's scheduled initial focus and
  // scope the choice to its popup rather than any listbox in the document.
  const popupId = trigger.getAttribute('aria-controls');
  await expect(popupId).toBeTruthy();
  await waitFor(() => expect(document.getElementById(popupId!)).toHaveFocus());
  const popup = document.getElementById(popupId!)!;
  const option = await within(popup).findAllByRole('option');
  const choice = option.find(item => item.getAttribute('data-value') === value);
  await expect(choice).toBeDefined();
  await userEvent.click(choice!);
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  // Saving can disable the trigger during focus restoration. The fixture waits
  // for the menu to close; callers assert their own saved/ready state.
  await waitFor(() => expect(document.getElementById(popupId!)).toBeNull());
}
