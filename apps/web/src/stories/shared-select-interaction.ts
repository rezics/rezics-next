import { userEvent, within } from 'storybook/test';

export async function selectSharedOption(trigger: HTMLElement, name: string | RegExp) {
  await userEvent.click(trigger);
  await userEvent.click(await within(trigger.ownerDocument.body).findByRole('option', { name }));
}
