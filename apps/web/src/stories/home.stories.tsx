import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setContinueStorySize } from '../kernel/fake/library-continue';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Discovery/Home',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const homeAdmissions = [
  'selling',
  'purchases',
  'agent_verification',
  'personal_library',
  'library_continue.list',
  'reading_progress',
  'collections',
];

function home(visitor: 'Signed In' | 'Signed Out', size: number, menu = false): Story {
  return {
    parameters: {
      ...(visitor === 'Signed In' ? { admitted: homeAdmissions } : {}),
    },
    render: () => {
      setContinueStorySize(size);
      return <PageStory visitor={visitor} path={pagePaths.home} />;
    },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await canvas.findByRole('main');
      if (visitor === 'Signed In' && size > 0) {
        await canvas.findByRole('heading', { level: 2 });
        if (menu) {
          await userEvent.click(await canvas.findByRole('button', { name: /more actions/i }));
          await expect(canvasElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
        }
      }
    },
  };
}

export const SignedInOnePhone: Story = {
  name: 'Member, one in-progress title',
  ...home('Signed In', 1),
};
export const SignedInTwoPhone: Story = {
  name: 'Member, two in-progress titles',
  ...home('Signed In', 2),
};
export const SignedInSixPhone: Story = {
  name: 'Member, six in-progress titles',
  ...home('Signed In', 6),
};
export const SignedInSixMenuPhone: Story = {
  name: 'Member, item actions open',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone' } },
  ...home('Signed In', 6, true),
};
export const SignedInNonePhone: Story = {
  name: 'Member, no in-progress titles',
  ...home('Signed In', 0),
};
export const SignedOutPhone: Story = {
  name: 'Signed out',
  ...home('Signed Out', 0),
};
