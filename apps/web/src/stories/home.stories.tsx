import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setContinueStorySize } from '../kernel/fake/library-continue';
import { PageStory, pagePaths, pageReady } from './page';

const viewports = {
  phone: { name: '390 phone', styles: { width: '390px', height: '844px' }, type: 'mobile' as const },
  desktop: { name: '1280 desktop', styles: { width: '1280px', height: '900px' }, type: 'desktop' as const },
};
const meta = { title: 'Pages/Home', parameters: { layout: 'fullscreen', viewport: { viewports } } } satisfies Meta;
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

function home(visitor: 'Signed In' | 'Signed Out', size: number, viewport: keyof typeof viewports, menu = false): Story {
  return {
    name: `${visitor} · ${size} Continue · ${viewports[viewport].name}${menu ? ' · menu open' : ''}`,
    parameters: {
      viewport: { defaultViewport: viewport },
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

export const SignedInOnePhone = home('Signed In', 1, 'phone');
export const SignedInOneDesktop = home('Signed In', 1, 'desktop');
export const SignedInTwoPhone = home('Signed In', 2, 'phone');
export const SignedInTwoDesktop = home('Signed In', 2, 'desktop');
export const SignedInSixPhone = home('Signed In', 6, 'phone');
export const SignedInSixDesktop = home('Signed In', 6, 'desktop');
export const SignedInSixMenuPhone = home('Signed In', 6, 'phone', true);
export const SignedInNonePhone = home('Signed In', 0, 'phone');
export const SignedInNoneDesktop = home('Signed In', 0, 'desktop');
export const SignedOutPhone = home('Signed Out', 0, 'phone');
export const SignedOutDesktop = home('Signed Out', 0, 'desktop');
