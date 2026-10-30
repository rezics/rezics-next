import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import subjectPageRecording from '../kernel/recorded/subject-page.json';
import { getLocale } from '../paraglide/runtime';
import { subjectTabs } from '../features/pages/views';
import { PageStory, exposureStory, pagePaths, pageReady } from './page';
import { ratingsFixtures } from '../kernel/fake/ratings';
import { selectEntryUndoOutcome } from '../kernel/fake/library-entry-undo';

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

const meta = { title: 'Pages/Subjects/Subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
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
  name: 'Member',
  play: subjectReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
};
export const SignedOut: Story = {
  name: 'Signed out',
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
  tags: ['!dev'],
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
  tags: ['!dev'],
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
  tags: ['!dev'],
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
  tags: ['!dev'],
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
  tags: ['!dev'],
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
  tags: ['!dev'],
  name: 'Count Unavailable',
  play: pageReady,
  render: () => <CountUnavailablePageStory />,
};
export const ExposureOpen: Story = exposureStory(pagePaths.subject);
export const ExposureClosed: Story = exposureStory(pagePaths.subject, true);

function SubjectUndoStory({ outcome = 'ok' }: { outcome?: 'ok' | 'occupied' | 'stale' | 'expired' }) {
  selectEntryUndoOutcome(outcome);
  useEffect(() => () => selectEntryUndoOutcome(), []);
  return <PageStory visitor="Signed In" path={pagePaths.subject} />;
}

async function removeSubjectEntry(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(context.canvasElement);
  const state = await view.findByRole('combobox', { name: m.library_subject_entry() });
  await waitFor(() => expect(state).toBeEnabled());
  await userEvent.click(state);
  await userEvent.click(await within(document.body).findByRole('option', { name: m.library_subject_remove() }));
  await expect(await within(document.body).findByRole('button', { name: m.editor_undo() })).toBeVisible();
}

export const UndoAfterLibraryRemoval: Story = {
  tags: ['!dev'],
  name: 'Member, entry removed',
  play: removeSubjectEntry,
  render: () => <SubjectUndoStory />,
};

export const UndoRestored: Story = {
  tags: ['!dev'],
  name: 'Member, entry restored',
  play: async (context) => {
    await removeSubjectEntry(context);
    await userEvent.click(await within(document.body).findByRole('button', { name: m.editor_undo() }));
    await waitFor(() =>
      expect(
        within(context.canvasElement).getByRole('combobox', { name: m.library_subject_entry() }),
      ).toHaveTextContent(m.library_subject_state_planned()),
    );
  },
  render: () => <SubjectUndoStory />,
};

function refusedSubjectRestore(reason: 'occupied' | 'stale' | 'expired') {
  return async (context: { canvasElement: HTMLElement }) => {
    await removeSubjectEntry(context);
    await userEvent.click(await within(document.body).findByRole('button', { name: m.editor_undo() }));
    const view = within(context.canvasElement);
    await expect(await view.findByText(m[`library_restore_${reason}`]())).toBeVisible();
    if (reason === 'occupied')
      await waitFor(() =>
        expect(view.getByRole('combobox', { name: m.library_subject_entry() })).toHaveTextContent(
          m.library_subject_state_completed(),
        ),
      );
  };
}

export const RestoreOccupied: Story = {
  tags: ['!dev'],
  name: 'Restore blocked by existing entry',
  play: refusedSubjectRestore('occupied'),
  render: () => <SubjectUndoStory outcome="occupied" />,
};

export const RestoreStale: Story = {
  tags: ['!dev'],
  name: 'Restore blocked by changed entry',
  play: refusedSubjectRestore('stale'),
  render: () => <SubjectUndoStory outcome="stale" />,
};

export const RestoreExpired: Story = {
  tags: ['!dev'],
  name: 'Restore window expired',
  play: refusedSubjectRestore('expired'),
  render: () => <SubjectUndoStory outcome="expired" />,
};
