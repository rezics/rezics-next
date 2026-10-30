import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PageStory } from './page';
import { appearancePath } from '../kernel/fake/community';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Pages/Community/Realm Appearance', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Management: Story = {
  render: () => <PageStory visitor="Signed In" path={appearancePath} />,
  play: async ({ canvasElement }) => {
    const main = await within(canvasElement).findByRole('main');
    await expect(await within(main).findByRole('heading', { name: m.realm_appearance_heading() })).toBeVisible();
    await expect(await within(main).findByRole('button', { name: m.realm_appearance_save() })).toBeEnabled();
  },
};
