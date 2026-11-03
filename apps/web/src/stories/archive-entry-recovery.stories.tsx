import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory } from './page';

const meta = {
  title: 'Pages/Library/Archive recovery',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const UploadUnavailable: Story = {
  render: () => <PageStory visitor="Signed In" path="/library/recover-archive" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.library_archive_title() })).toBeVisible();
    const main = within(canvas.getByRole('main'));
    await expect(main.getByLabelText(m.library_archive_choose_file())).toBeDisabled();
    await expect(main.getByText(m.library_archive_inventory())).toBeVisible();
    await expect(main.getByRole('link', { name: m.library_archive_return() })).toBeVisible();
    await expect(main.getByRole('link', { name: m.library_archive_export() })).toBeVisible();
  },
};
