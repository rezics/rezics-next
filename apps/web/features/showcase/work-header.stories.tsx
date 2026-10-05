import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { localizedPath } from '../../i18n/locale.ts';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import * as fixture from '../work-page/fixtures.ts';
import { messages as workPageMessages } from '../work-page/messages.ts';
import { WorkCredits } from '../work-page/credits.tsx';
import { workHref } from '../work-page/route.ts';
import { RatingLine } from '../work-page/ratings.tsx';
import { WorkFrame } from '../work-page/work-frame.tsx';
import { WorkAbout } from '../work-page/work-header.tsx';
import { fixtureArt } from './fixtures.ts';
import { messages } from './messages.ts';
import type { WorkShowcaseHeader } from './work-header.tsx';

const work = { ...fixture.work, title: { ...fixture.work.title, value: 'Astral Tide' } };
const t = workPageMessages.en;
const art: WorkShowcaseHeader = {
  art: fixtureArt,
  trailer: { href: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' },
  messages: messages.en,
};

function Page({ showcase }: { showcase: WorkShowcaseHeader | null }) {
  return (
    <WorkFrame
      workRef={fixture.workRef}
      work={work}
      locale="en"
      messages={t}
      showcase={showcase}
      readerActions={memoryReaderActions()}
      credits={
        <WorkCredits
          agentCredits={fixture.agentCredits}
          credits={fixture.credits}
          locale="en"
          messages={t}
        />
      }
      ratingLine={
        <RatingLine ratings={fixture.globalRatings} stats={fixture.workStats} locale="en" messages={t} />
      }
    >
      <WorkAbout work={work} messages={t} />
    </WorkFrame>
  );
}

const meta = {
  title: 'Showcase/Work header',
  component: Page,
  args: { showcase: art },
  parameters: { route: { pathname: localizedPath(workHref(fixture.workRef), 'en') } },
  async afterEach({ id }) {
    // Screenshots for review by eye; the run sets this flag, ordinary runs skip it.
    if (import.meta.env.VITE_SHOWCASE_VISUAL !== '1') return;
    const { page } = await import('vitest/browser');
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
    await page.screenshot({ path: `../../.temp/work-header/${id}.png` });
  },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

async function opensWithArt(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const hero = canvasElement.querySelector('.work-hero')!;
  await expect(hero).not.toBeNull();
  // The title stays the page's heading whether or not the logo has drawn.
  await expect(canvas.getByRole('heading', { level: 1, name: 'Astral Tide' })).toBeInTheDocument();
  // Credits and stats are live text over the art, not part of it.
  await expect(within(hero as HTMLElement).getByText('Chapters')).toBeInTheDocument();
  await expect(within(hero as HTMLElement).getByRole('button', { name: 'Watch trailer' })).toBeVisible();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  play: ({ canvasElement }) => opensWithArt(canvasElement),
};
export const Tablet: Story = {
  globals: { viewport: { value: 'tabletPortrait' } },
  play: ({ canvasElement }) => opensWithArt(canvasElement),
};
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  play: ({ canvasElement }) => opensWithArt(canvasElement),
};
export const LandscapeOnly: Story = {
  args: { showcase: { ...art, art: { ...fixtureArt, portrait: null } } },
  globals: { viewport: { value: 'phone' } },
  play: ({ canvasElement }) => opensWithArt(canvasElement),
};
export const LogoUnavailable: Story = {
  args: {
    showcase: {
      ...art,
      art: {
        ...fixtureArt,
        logos: fixtureArt.logos?.map((logo) => ({
          ...logo,
          candidates: undefined,
          url: '/missing-showcase-logo.svg',
        })),
      },
    },
  },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await waitFor(() =>
      expect(within(canvasElement).getByRole('heading', { level: 1, name: 'Astral Tide' })).toBeVisible(),
    );
  },
};
export const WithoutArt: Story = {
  args: { showcase: null },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await expect(canvasElement.querySelector('.work-hero')).toBeNull();
    await expect(
      within(canvasElement).getByRole('heading', { level: 1, name: 'Astral Tide' }),
    ).toBeVisible();
    await expect(within(canvasElement).queryByRole('button', { name: 'Watch trailer' })).toBeNull();
  },
};
export const WithoutArtTablet: Story = { ...WithoutArt, globals: { viewport: { value: 'tabletPortrait' } } };
export const WithoutArtDesktop: Story = { ...WithoutArt, globals: { viewport: { value: 'desktop' } } };
export const TrailerFacade: Story = {
  globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    await expect(document.querySelector('iframe[src*="youtube-nocookie"]')).toBeNull();
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Watch trailer' }));
    await waitFor(() => expect(within(document.body).getByRole('dialog')).toBeVisible());
    await expect(document.querySelector('iframe[src*="youtube-nocookie"]')).not.toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('iframe[src*="youtube-nocookie"]')).toBeNull());
  },
};
