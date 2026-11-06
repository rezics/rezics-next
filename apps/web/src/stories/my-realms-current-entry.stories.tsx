import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { MyRealmsPageView } from '../community/my-realms-page';
import recording from '../kernel/recorded/my-realms.json';
import { m } from '../paraglide/messages.js';

// These stories use only installed native inventory labels; they do not establish expanded native admission.
const realms = recording.items.map(({ realmId, name }) => ({ realmId, name }));
const meta = {
  title: 'Pages/Community/My Realms Current Entry',
  component: MyRealmsPageView,
  parameters: { layout: 'padded' },
  args: { page: { signedIn: true, realms, next: null } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: m.realms_heading() })).toBeVisible();
    await expect(canvas.getAllByText(m.realms_entry_unavailable())).toHaveLength(args.page.realms.length);
    await expect(canvas.queryByRole('link')).toBeNull();
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.queryByRole('img')).toBeNull();
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
  },
} satisfies Meta<typeof MyRealmsPageView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnavailableEntry: Story = {
  globals: { viewport: { value: 'phone390' } },
};
export const LongInventory: Story = {
  args: {
    page: {
      signedIn: true,
      realms: realms.map((realm) => ({
        ...realm,
        name: `${realm.name} ${'Readers across languages 共讀社群 '.repeat(12)}`,
      })),
      next: null,
    },
  },
  globals: { viewport: { value: 'desktop1280' } },
};
