import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import recordedPage from '../kernel/recorded/subject-page.json';
import type { SubjectPageData } from '../features/pages/subject';
import { projectShareCardPage } from '../media/share-card-page';
import { ShareCardView } from '../media/share-card-view';
import { locales } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = { title: 'Content/Share Card', id: 'patterns-media-share-card', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {
  render: (_, context) => {
    const locale = locales.find((locale) => locale === context.globals.locale) ?? 'en';
    const page = recordedPage as SubjectPageData;
    const result = projectShareCardPage({ kind: 'page', page }, { id: page.subject!, locale });
    if (result.kind !== 'ready') throw new Error('Recorded public page projection unavailable');
    return (
      <PatternStory>
        <div
          role="img"
          aria-label={result.page.title}
          style={{ width: '100%', aspectRatio: '1200 / 630', overflow: 'hidden', containerType: 'inline-size' }}
        >
          <div
            style={{ width: 1200, height: 630, transform: 'scale(calc(100cqw / 1200px))', transformOrigin: 'top left' }}
          >
            <ShareCardView page={result.page} fontFamily="var(--font-work-title)" />
          </div>
        </div>
      </PatternStory>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img')).toHaveAccessibleName();
    await expect(canvas.getByText('REZICS')).toBeVisible();
  },
};
