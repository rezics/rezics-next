import { expect, userEvent, waitFor, within } from 'storybook/test';

/** Exercise the visible styled menu, including selects portalled out of the canvas. */
export async function chooseOption(trigger: HTMLElement, value: string) {
  await userEvent.click(trigger);
  const option = await within(document.body).findAllByRole('option');
  const choice = option.find(item => item.getAttribute('data-value') === value);
  await expect(choice).toBeDefined();
  await userEvent.click(choice!);
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled || document.activeElement === trigger).toBe(true));
}
