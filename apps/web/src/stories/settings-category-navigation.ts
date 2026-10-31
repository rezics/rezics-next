import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';

export async function selectSettingsCategory(canvasElement: HTMLElement, label: string) {
  const navigation = within(
    await within(canvasElement).findByRole('navigation', { name: m.settings_sections_label() }),
  );
  const link = navigation.getByRole('link', { name: label });
  await userEvent.click(link);
  await expect(link).toHaveAttribute('aria-current', 'location');
}
