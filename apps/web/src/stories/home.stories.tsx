import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setHomeContinueStory } from '../kernel/fake/home-continue-stories';
import { PageStory, pagePaths } from './page';

const viewports = {
  phone: { name: '390 phone', styles: { width: '390px', height: '844px' }, type: 'mobile' as const },
  desktop: { name: '1280 desktop', styles: { width: '1280px', height: '900px' }, type: 'desktop' as const },
};
const meta = { title: 'Pages/Home', parameters: { layout: 'fullscreen', viewport: { viewports } } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function home(
  visitor: 'Signed In' | 'Signed Out',
  count: 'one' | 'few' | 'many' | 'none',
  viewport: keyof typeof viewports,
  menu = false,
): Story {
  return {
    name: `${visitor} · ${count} Continue · ${viewports[viewport].name}${menu ? ' · menu open' : ''}`,
    parameters: { viewport: { defaultViewport: viewport } },
    render: () => {
      setHomeContinueStory(count);
      return <PageStory visitor={visitor} path={pagePaths.home} />;
    },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await canvas.findByRole('main');
      if (visitor === 'Signed In' && count !== 'none') {
        await canvas.findByRole('heading', { level: 2 });
        if (menu) {
          await userEvent.click(await canvas.findByRole('button', { name: /more actions/i }));
          await expect(canvasElement.querySelector('[data-slot="drawer-content"]')).toBeTruthy();
        }
      }
    },
  };
}

export const SignedInOnePhone = home('Signed In', 'one', 'phone');
export const SignedInOneDesktop = home('Signed In', 'one', 'desktop');
export const SignedInFewPhone = home('Signed In', 'few', 'phone');
export const SignedInFewDesktop = home('Signed In', 'few', 'desktop');
export const SignedInManyPhone = home('Signed In', 'many', 'phone');
export const SignedInManyDesktop = home('Signed In', 'many', 'desktop');
export const SignedInManyMenuPhone = home('Signed In', 'many', 'phone', true);
export const SignedInNonePhone = home('Signed In', 'none', 'phone');
export const SignedInNoneDesktop = home('Signed In', 'none', 'desktop');
export const SignedOutPhone = home('Signed Out', 'none', 'phone');
export const SignedOutDesktop = home('Signed Out', 'none', 'desktop');
