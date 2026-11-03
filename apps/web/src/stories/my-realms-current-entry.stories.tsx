import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { MyRealmsPageView } from '../community/my-realms-page';
import { formatMyRealmsInventory, type MyRealmsNativePage } from '../community/my-realms-native';
import recording from '../kernel/recorded/my-realms.json';
import { m } from '../paraglide/messages.js';

// These stories use only installed native inventory; they do not establish expanded native admission.
const inventory: MyRealmsNativePage = {
  items: recording.items.map(({ realmId, name }) => ({ realmId, name, role: 'member' })),
  next: null,
};
const meta = {
  title: 'Pages/Community/My Realms Current Entry',
  component: MyRealmsPageView,
  parameters: { layout: 'padded' },
  args: { page: { signedIn: true, ...formatMyRealmsInventory(inventory) } },
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
      ...formatMyRealmsInventory({
        ...inventory,
        items: inventory.items.map((item) => ({
          ...item,
          name: `${item.name} ${'Readers across languages 共讀社群 '.repeat(12)}`,
        })),
      }),
    },
  },
  globals: { viewport: { value: 'desktop1280' } },
};
