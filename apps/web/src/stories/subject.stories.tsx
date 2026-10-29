import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import subjectPageRecording from '../kernel/recorded/subject-page.json';
import { getLocale } from '../paraglide/runtime';
import { subjectTabs } from '../features/pages/views';
import { PageStory, pagePaths, pageReady } from './page';
import { ratingsFixtures } from '../kernel/fake/ratings';

function countUnavailablePage(): SubjectPageData {
  const page = structuredClone(subjectPageRecording) as unknown as SubjectPageData;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    account: page.account ?? null,
  });
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind !== 'links' || read.property !== 'schema:exampleOfWork') continue;
    const result = page.reads[key];
    if (
      result?.status === 200 &&
      typeof result.body === 'object' &&
      result.body !== null &&
      !Array.isArray(result.body)
    ) {
      delete (result.body as Record<string, unknown>).count;
    }
  }
  return page;
}

function CountUnavailablePageStory() {
  const page = countUnavailablePage();
  return (
    <SubjectPage
      page={page}
      locale={getLocale()}
      messages={subjectPageMessages()}
      tabs={subjectTabs(page)}
      tabLabels={viewTabLabels()}
    />
  );
}

const meta = { title: 'Pages/Subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function subjectReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  await canvas.findByRole('heading', { level: 1, name: 'The Little Prince' });
  const covers = context.canvasElement.querySelectorAll('[data-slot="subject-header"] [data-slot="cover"]');
  if (covers.length === 0) throw new Error('The recorded subject header cover did not render.');
  for (const cover of covers) await expect(cover).toHaveAttribute('data-state', 'placeholder');
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: subjectReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: subjectReady,
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

export const CountUnavailable: Story = {
  name: 'Count Unavailable',
  play: pageReady,
  render: () => <CountUnavailablePageStory />,
};
