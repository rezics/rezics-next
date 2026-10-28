import type { Meta, StoryObj } from '@storybook/react-vite';
import { waitFor, within } from 'storybook/test';
import { PageStory, pagePaths, pageReady } from './page';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Pages/Exposure', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const page = (path: string, admitted?: string[]): Story => ({
  ...(admitted ? { parameters: { admitted } } : {}),
  play: async (context) => {
    await pageReady(context);
    // The page's personal data and the session/exposure queries settle independently.
    const canvas = within(context.canvasElement);
    await canvas.findByRole('button', { name: m.account_menu() });
    if (admitted) {
      await waitFor(() => {
        const controls = context.canvasElement.querySelector('main');
        if (
          !controls ||
          controls.querySelector('[data-library-entry],button[type="submit"],button[aria-label^="Actions for"]') ||
          canvas.queryByRole('button', { name: m.offer_buy() })
        ) {
          throw new Error('Closed operations still have controls');
        }
      });
    } else if (path === pagePaths.subject) {
      await waitFor(() => {
        if (!context.canvasElement.querySelector('[data-library-entry]'))
          throw new Error('Waiting for admitted controls');
      });
    } else if (path === pagePaths.offer) {
      await canvas.findByRole('button', { name: m.offer_buy() });
    } else {
      await waitFor(() => {
        if (!context.canvasElement.querySelector('main button')) throw new Error('Waiting for admitted controls');
      });
    }
  },
  render: () => <PageStory visitor="Signed In" path={path} />,
});
export const SubjectOpen = page(pagePaths.subject);
export const SubjectClosed = page(pagePaths.subject, []);
export const LibraryOpen = page(pagePaths['library-entries']);
export const LibraryClosed = page(pagePaths['library-entries'], []);
export const ProgressOpen = page(pagePaths['library-progress']);
export const ProgressClosed = page(pagePaths['library-progress'], []);
export const OfferOpen = page(pagePaths.offer);
export const OfferClosed = page(pagePaths.offer, []);
