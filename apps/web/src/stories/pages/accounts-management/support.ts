import { expect, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
export const reviewParameters = {
  layout: 'fullscreen',
  admitted: ['organizations'],
  viewport: {
    viewports: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' }, type: 'desktop' as const },
    },
  },
};
export async function ready({ canvasElement }: { canvasElement: HTMLElement }) {
  const main = within(await within(canvasElement).findByRole('main'));
  await expect(await main.findByRole('button', { name: m.managed_refresh() })).toBeVisible();
}
