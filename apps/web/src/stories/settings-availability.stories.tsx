import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Settings/Availability', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;

async function unavailable(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByText(m.settings_unavailable_text());
  const alert = view.getByRole('alert');
  await expect(alert).toHaveAttribute('data-response-status', '503');
  await expect(view.queryByRole('radio')).toBeNull();
  await expect(view.queryByText(m.settings_preparing_text())).toBeNull();
  return { view, alert };
}

export const GenericServiceFailure: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?notification-state=generic#reading" />,
  play: async (context) => {
    const { view, alert } = await unavailable(context);
    await expect(alert).toHaveAttribute('data-response-code', '');
    await expect(view.getByRole('button', { name: m.settings_retry() })).toBeEnabled();
  },
};

export const DeadlineWithRetryAfter: Story = {
  render: () => <PageStory visitor="Signed In" path="/settings?notification-state=deadline#reading" />,
  play: async (context) => {
    const { view, alert } = await unavailable(context);
    await expect(alert).toHaveAttribute('data-response-code', 'deadline_exceeded');
    await expect(alert).toHaveAttribute('data-retry-after', '30');
    await view.findByText(m.settings_retry_wait());
    await expect(view.getByRole('button', { name: m.settings_retry() })).toBeDisabled();
  },
};
