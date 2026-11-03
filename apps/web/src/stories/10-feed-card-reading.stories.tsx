import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { FeedResults } from '../features/feed/feed-results';
import { homeFeedItemPresentation } from '../features/feed/home-feed-item';
import { preparedFeedCardReading } from '../kernel/fake/feed-card-reading';
import { getLocale } from '../paraglide/runtime.js';

function Reading({ long = false }: { long?: boolean }) {
  const [retired, setRetired] = useState(false);
  const items = retired ? [] : preparedFeedCardReading(long);
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">Prepared mixed-feed reading</h1>
      <p className="my-3 text-sm text-muted-foreground">
        Prepared native-shaped examples. Not native eligibility or coverage evidence.
      </p>
      <button type="button" className="mb-4 min-h-11 rounded border px-3" onClick={() => setRetired(!retired)}>
        {retired ? 'Restore prepared source' : 'Retire prepared source'}
      </button>
      <FeedResults
        regionLabel="Prepared feed"
        itemHeadingLevel={2}
        listAs="ol"
        result={{ state: 'ready', items, hasNext: false, availability: { state: 'complete' } }}
        messages={{
          loading: 'Loading',
          partial: 'Partial',
          empty: 'Prepared source retired',
          sparse: 'No rows',
          retry: 'Retry',
          restart: 'Restart',
          failure: {
            request: 'Invalid',
            auth: 'Sign in',
            denied: 'Denied',
            closed: 'Closed',
            cursor: 'Expired',
            deadline: 'Timeout',
            unavailable: 'Unavailable',
          },
        }}
        getItemKey={(item) => item.id}
        itemPresentation={(item) => {
          const presentation = homeFeedItemPresentation(item, getLocale());
          return {
            ...presentation,
            actions: (
              <>
                {presentation.actions}
                <button
                  type="button"
                  className="min-h-11 min-w-11 rounded border px-3"
                  aria-label={`Prepared action: ${item.id}`}
                >
                  Prepared action
                </button>
              </>
            ),
          };
        }}
      />
    </main>
  );
}

const meta = {
  title: 'Patterns/Feed/Card reading',
  component: Reading,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof Reading>;
export default meta;
type Story = StoryObj<typeof meta>;

const journey: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByRole('listitem')).toHaveLength(8);
  const work = canvas.getAllByRole('listitem')[0]!;
  const links = within(work).getAllByRole('link');
  links[0]!.focus();
  await userEvent.tab();
  await expect(links[1]).toHaveFocus();
  await userEvent.tab();
  await expect(within(work).getByRole('button')).toHaveFocus();
  const discussion = canvas.getAllByRole('listitem')[1]!;
  const discussionLinks = within(discussion).getAllByRole('link');
  discussionLinks[0]!.focus();
  await userEvent.tab();
  await expect(discussionLinks[1]).toHaveFocus();
  await expect(discussionLinks[1]).toHaveAttribute('href', `/${getLocale()}/@prepared_reader`);
  await userEvent.tab();
  await expect(within(discussion).getByRole('button')).toHaveFocus();
  await expect(
    canvasElement.querySelector('[data-feed-source="continue"] [data-content-item-slot="actions"] a'),
  ).toHaveAttribute('href', expect.stringContaining('/library/progress/'));
  await expect(canvasElement.querySelector('a a, a button, button a')).toBeNull();
  await expect(canvasElement.querySelector('[data-feed-card-reviewed-subject] a')).toHaveAttribute(
    'href',
    expect.stringContaining('/subjects/'),
  );
  await expect(canvasElement.querySelector('[data-feed-card-carrier] a')).toBeNull();
  for (const element of canvasElement.querySelectorAll('a, button')) {
    await expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  await userEvent.click(canvas.getByRole('button', { name: 'Retire prepared source' }));
  await expect(canvas.queryAllByRole('listitem')).toHaveLength(0);
  await expect(canvas.queryAllByRole('link')).toHaveLength(0);
  await userEvent.click(canvas.getByRole('button', { name: 'Restore prepared source' }));
  await expect(canvas.getAllByRole('listitem')).toHaveLength(8);
};

export const PhoneLight: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light' }, play: journey };
export const PhoneDark: Story = { globals: { viewport: { value: 'phone390' }, theme: 'dark' }, play: journey };
export const DesktopLight: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'light' }, play: journey };
export const DesktopDark: Story = { globals: { viewport: { value: 'desktop1280' }, theme: 'dark' }, play: journey };
export const LongKeyboardPhone: Story = {
  args: { long: true },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
  play: journey,
};
export const LongKeyboardDesktop: Story = {
  args: { long: true },
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  play: journey,
};
