import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';
import { ratingsFixtures } from '../kernel/fake/ratings';

const meta = { title: 'Pages/Subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths.subject} />,
};

async function heroReady(context: { canvasElement: HTMLElement }, reveal: boolean) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: /The Little Prince/ });
  const spoiler = await view.findByRole('button', { name: m.subject_spoiler_show() });
  await expect(spoiler).toBeVisible();
  const value = view.queryByText('the prince returns to his asteroid');
  if (reveal) {
    await expect(value).not.toBeInTheDocument();
    await userEvent.click(spoiler);
    await expect(await view.findByText('the prince returns to his asteroid')).toBeVisible();
  } else {
    await expect(value).not.toBeInTheDocument();
  }
}

export const HeroSignedInSpoilersHidden: Story = {
  name: 'Hero / Signed In / Spoilers Hidden',
  play: (context) => heroReady(context, false),
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
};
export const HeroSignedInSpoilersShown: Story = {
  name: 'Hero / Signed In / Spoilers Shown',
  play: (context) => heroReady(context, true),
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
};
export const HeroSignedOutSpoilersHidden: Story = {
  name: 'Hero / Signed Out / Spoilers Hidden',
  play: (context) => heroReady(context, false),
  render: () => <PageStory visitor="Signed Out" path={pagePaths.subject} />,
};
export const HeroSignedOutSpoilersShown: Story = {
  name: 'Hero / Signed Out / Spoilers Shown',
  play: (context) => heroReady(context, true),
  render: () => <PageStory visitor="Signed Out" path={pagePaths.subject} />,
};

export const GlobalScore: Story = {
  name: 'Global score',
  play: pageReady,
  render: () => (
    <PageStory
      visitor="Signed Out"
      path={pagePaths.subject}
      ratings={ratingsFixtures['subject-ratings-global'].preview}
      ratingsFixture="subject-ratings-global"
    />
  ),
};

export const RealmsAndOwnVote: Story = {
  name: 'Realms and own vote',
  play: pageReady,
  render: () => (
    <PageStory
      visitor="Signed In"
      path={pagePaths.subject}
      ratings={ratingsFixtures['subject-ratings-realms'].preview}
      ratingsFixture="subject-ratings-realms"
    />
  ),
};

export const BelowThreshold: Story = {
  name: 'Below threshold',
  play: pageReady,
  render: () => (
    <PageStory
      visitor="Signed Out"
      path={pagePaths.subject}
      ratings={ratingsFixtures['subject-ratings-below-threshold'].preview}
      ratingsFixture="subject-ratings-below-threshold"
    />
  ),
};

export const ImportedScores: Story = {
  name: 'Imported scores',
  play: pageReady,
  render: () => (
    <PageStory
      visitor="Signed Out"
      path={pagePaths.subject}
      ratings={ratingsFixtures['subject-ratings-imported'].preview}
      ratingsFixture="subject-ratings-imported"
    />
  ),
};

export const OwnVoteForbidden: Story = {
  name: 'Own vote forbidden',
  play: pageReady,
  render: () => (
    <PageStory
      visitor="Signed In"
      path={pagePaths.subject}
      ratings={ratingsFixtures['subject-ratings-own-forbidden'].preview}
      ratingsFixture="subject-ratings-own-forbidden"
    />
  ),
};
