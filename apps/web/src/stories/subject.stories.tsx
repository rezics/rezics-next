import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { m } from '../paraglide/messages.js';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, type SubjectPageData } from '../features/pages/subject';
import { RatingsView } from '../features/pages/subject-ratings-view';
import { subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import subjectPageRecording from '../kernel/recorded/subject-page.json';
import { getLocale } from '../paraglide/runtime';
import { subjectTabs } from '../features/pages/views';
import { PageStory, exposureStory, pagePaths, pageReady } from './page';
import { ratingsFixtures } from '../kernel/fake/ratings';
import { selectEntryUndoOutcome } from '../kernel/fake/library-entry-undo';
import { IMPORTED_VN_SUBJECT_ID } from '../kernel/fake/ratings';
import { storySubjects } from '../kernel/story-subjects';
import { subjectHref } from '../subject/subject-href';
import { Cover, type CoverSubject, type CoverSummary } from '@rezics/ui/cover';
import { CoverViewer } from '@rezics/ui/cover-viewer';

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

const phone390 = {
  viewports: {
    phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' },
  },
  defaultViewport: 'phone390',
};
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

export const OverviewReactionsEnglishPhone: Story = {
  name: 'Overview / Full Reactions / English / Phone 390',
  globals: { locale: 'en' },
  parameters: { viewport: phone390 },
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
};

export const OverviewReactionsChinesePhone: Story = {
  name: 'Overview / Full Reactions / Chinese / Phone 390',
  globals: { locale: 'zh-Hans' },
  parameters: { viewport: phone390 },
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
};

/** The signed-out subject page with its cover viewer open, for review of the original image and credit. */
export const CoverViewerOpen: Story = {
  name: 'Cover Viewer Open',
  render: () => <PageStory visitor="Signed Out" path={pagePaths.subject} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const heading = await canvas.findByRole('heading', { level: 1 });
    const title = heading.textContent?.trim() ?? '';
    const trigger = canvas.getByRole('button', { name: m.subject_cover_open({ title }) });
    await userEvent.click(trigger);
    const dialog = await within(document.body).findByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
  },
};

const viewerSubject: CoverSubject = { id: 'story-cover', title: 'The Little Prince', types: ['schema:Book'] };
const viewerCover: CoverSummary = {
  media: 'story-cover',
  width: 1200,
  height: 1800,
  placeholder: { thumbhash: '', color: '#526879' },
  variants: [
    { format: 'webp', width: 320 },
    { format: 'webp', width: 640 },
  ],
  focalPoint: null,
  credit: {
    rightsHolder: 'Story cover artist',
    via: { name: 'Story archive', url: 'https://archive.example.test/covers' },
    license: 'CC-BY-4.0',
  },
};
const viewerImage = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="960"><rect width="640" height="960" fill="#526879"/><circle cx="430" cy="270" r="120" fill="#f4d58d"/><path d="M0 740 Q320 620 640 760 V960 H0Z" fill="#223843"/></svg>')}`;
const viewerSource = () => viewerImage;
const failedViewerSource = () => 'data:image/png;base64,AAAA';

function CoverViewerInteractionStory() {
  const [open, setOpen] = useState(false);
  const withheld = { ...viewerCover, media: 'withheld-story-cover', withheld: 'suitability' as const };
  return (
    <div className="flex flex-wrap items-start gap-6 p-6">
      <div data-testid="missing-cover">
        <Cover
          subject={{ ...viewerSubject, id: 'missing-cover', title: 'Missing cover' }}
          cover={null}
          size="lg"
          src={viewerSource}
          action={{ label: 'Open missing', onActivate: () => setOpen(true) }}
        />
      </div>
      <div data-testid="cjk-missing-cover">
        <Cover
          subject={{ ...viewerSubject, id: 'cjk-missing-cover', title: '星を追う図書館：迷子の夜' }}
          cover={null}
          size="lg"
          src={viewerSource}
          action={{ label: 'Open missing CJK cover', onActivate: () => setOpen(true) }}
        />
      </div>
      <div data-testid="failed-cover">
        <Cover
          subject={{ ...viewerSubject, id: 'failed-cover', title: 'Failed cover' }}
          cover={{ ...viewerCover, media: 'failed-story-cover' }}
          size="lg"
          src={failedViewerSource}
          action={{ label: 'Open failed', onActivate: () => setOpen(true) }}
        />
      </div>
      <div data-testid="withheld-cover">
        <Cover
          subject={viewerSubject}
          cover={withheld}
          size="lg"
          src={viewerSource}
          action={{ label: 'Open withheld', onActivate: () => setOpen(true) }}
        />
      </div>
      <CoverViewer
        subject={viewerSubject}
        cover={withheld}
        src={viewerSource}
        labels={{ title: viewerSubject.title, via: 'via', close: 'Close cover' }}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

export const CoverViewerInteraction: Story = {
  name: 'Cover Viewer Interaction',
  render: () => <CoverViewerInteractionStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const missing = canvas.getByTestId('missing-cover');
    const cjkMissing = canvas.getByTestId('cjk-missing-cover');
    const failed = canvas.getByTestId('failed-cover');
    const withheld = canvas.getByTestId('withheld-cover');
    await waitFor(() =>
      expect(failed.querySelector('[data-slot="cover"]')).toHaveAttribute('data-state', 'placeholder'),
    );
    await expect(within(missing).queryByRole('button', { name: 'Open missing' })).toBeNull();
    await expect(within(cjkMissing).queryByRole('button', { name: 'Open missing CJK cover' })).toBeNull();
    await expect(within(failed).queryByRole('button', { name: 'Open failed' })).toBeNull();
    await expect(within(withheld).queryByRole('button', { name: 'Open withheld' })).toBeNull();
    await expect(within(withheld).getByRole('button', { name: 'Show cover' })).toBeVisible();
    await expect(within(document.body).queryByRole('dialog')).toBeNull();
  },
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
  render: () => {
    const subject = storySubjects.find(({ id }) => id === IMPORTED_VN_SUBJECT_ID);
    if (!subject) throw new Error('The admitted visual-novel story subject is missing.');
    const locale = getLocale();
    const label = (subject.labels as Record<string, string>)[locale] ?? subject.labels.en;
    return (
      <main className="mx-auto w-full max-w-5xl space-y-8 p-6">
        <header className="space-y-2">
          <h1 className="font-serif text-3xl font-semibold tracking-tight">{label}</h1>
          <p className="text-muted-foreground">Visual novel.</p>
        </header>
        <RatingsView
          control={{
            subjectId: IMPORTED_VN_SUBJECT_ID,
            locale,
            returnTo: subjectHref({ id: IMPORTED_VN_SUBJECT_ID, label }, locale).href,
            session: 'signed-out',
            own: { kind: 'ready', units: null },
          }}
          data={ratingsFixtures['subject-ratings-imported'].preview}
          id="clannad-ratings"
          locale={locale}
          subject={IMPORTED_VN_SUBJECT_ID}
        />
      </main>
    );
  },
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
