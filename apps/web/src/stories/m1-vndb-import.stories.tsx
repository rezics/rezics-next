import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import { VndbReviewPage } from '../library/personal-list-import/review';
import { VndbResultPage } from '../library/personal-list-import/results';
import { VndbUploadForm } from '../library/personal-list-import/upload';
import { VndbSignedOut } from '../library/personal-list-import/states';
import { ImportLibraryView } from '../library/showcase-import-return/view';
import {
  vndbLifecycleChangedReimportSnapshot,
  vndbLifecycleLibrarySnapshot,
  vndbLifecycleOtherViewerSnapshot,
  vndbLifecyclePartialResultSnapshot,
  vndbLifecyclePreviewSnapshot,
  vndbLifecycleReopenSnapshot,
  vndbLifecycleScoreReviewSnapshot,
} from '../library/personal-list-import/lifecycle';
import { PatternStory } from './page';
import { m } from '../paraglide/messages.js';
import type { VndbJourneySnapshot } from '../library/personal-list-import/controller';
import type { ImportLibrarySnapshot } from '../library/showcase-import-return/browser';

const noop = () => {};
const phone = { viewport: { value: 'phone390', isRotated: false } };
const desktop = { viewport: { value: 'desktop1280', isRotated: false } };

const preview = await vndbLifecyclePreviewSnapshot();
const scoreReview = await vndbLifecycleScoreReviewSnapshot();
const partial = await vndbLifecyclePartialResultSnapshot();
const reopen = await vndbLifecycleReopenSnapshot();
const changed = await vndbLifecycleChangedReimportSnapshot();
const library = vndbLifecycleLibrarySnapshot();
const otherViewer = vndbLifecycleOtherViewerSnapshot();

function ImportShell({
  children,
  visitor = 'Signed In',
}: {
  children: ReactNode;
  visitor?: 'Signed In' | 'Signed Out';
}) {
  return (
    <PatternStory path="/library/import-vndb" visitor={visitor}>
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
        <h1 className="text-2xl font-semibold">{m.library_vndb_title()}</h1>
        {children}
      </main>
    </PatternStory>
  );
}

function ReviewStage({ snap }: { snap: VndbJourneySnapshot }) {
  return (
    <ImportShell>
      <VndbReviewPage
        snap={snap}
        busy={false}
        onReview={noop}
        onNext={noop}
        onPrevious={noop}
        onRefresh={noop}
        onConfirm={noop}
        onSource={noop}
        onHideSource={noop}
      />
    </ImportShell>
  );
}

function ResultStage({
  snap,
  snapshot,
}: {
  snap: VndbJourneySnapshot;
  snapshot: ImportLibrarySnapshot;
}) {
  return (
    <ImportShell>
      <VndbResultPage snap={snap} busy={false} onResume={noop} onReview={noop} onDiscard={noop} />
      <ImportLibraryView result={null} snapshot={snapshot} busy={false} onRead={noop} />
    </ImportShell>
  );
}

const meta = {
  title: 'Pages/Library/VNDB import',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const OwnerPreviewDesktop: Story = {
  name: 'Owner preview',
  globals: desktop,
  render: () => <ReviewStage snap={preview} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText('v123');
    await expect(view.getByText('Private source note', { exact: false })).toBeInTheDocument();
    await expect(canvasElement.querySelector('[data-vndb-source-xml]')).not.toBeNull();
  },
};
export const OwnerPreviewPhone: Story = { ...OwnerPreviewDesktop, globals: phone };

export const ScoreReviewDesktop: Story = {
  name: 'Explicit score review',
  globals: desktop,
  render: () => <ReviewStage snap={scoreReview} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText('Enjoyment');
    await expect(canvasElement.querySelector('[data-vndb-score-review="reviewed"]')).not.toBeNull();
    await expect(view.getByText('14', { exact: false })).toBeInTheDocument();
    await expect(view.getByText('0', { exact: false })).toBeInTheDocument();
  },
};
export const ScoreReviewPhone: Story = { ...ScoreReviewDesktop, globals: phone };

export const PartialResultDesktop: Story = {
  name: 'Partial result',
  globals: desktop,
  render: () => <ResultStage snap={partial} snapshot={library} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-vndb-result="applied"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-result="unavailable"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-library-return]')).not.toBeNull();
  },
};
export const PartialResultPhone: Story = { ...PartialResultDesktop, globals: phone };

export const UnchangedReopenDesktop: Story = {
  name: 'Unchanged reopen',
  globals: desktop,
  render: () => <ReviewStage snap={reopen} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText('v123');
    await expect(canvasElement.querySelector('[data-vndb-stage="review"]')).not.toBeNull();
  },
};
export const UnchangedReopenPhone: Story = { ...UnchangedReopenDesktop, globals: phone };

export const ChangedReimportDesktop: Story = {
  name: 'Changed reimport',
  globals: desktop,
  render: () => <ReviewStage snap={changed} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText('Changed export title');
    await expect(view.queryByText('Private source note')).toBeNull();
  },
};
export const ChangedReimportPhone: Story = { ...ChangedReimportDesktop, globals: phone };

export const LibraryReturnDesktop: Story = {
  name: 'Current Library return',
  globals: desktop,
  render: () => (
    <ImportShell>
      <ImportLibraryView result={null} snapshot={library} busy={false} returned onRead={noop} />
    </ImportShell>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-vndb-native-vote="present"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-native-vote="absent"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-native-vote="unavailable"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-native-vote-zero]')).not.toBeNull();
    await expect(canvasElement.textContent).not.toContain('Private source note');
  },
};
export const LibraryReturnPhone: Story = { ...LibraryReturnDesktop, globals: phone };

export const OtherViewerDesktop: Story = {
  name: 'Other viewer privacy',
  globals: desktop,
  render: () => (
    <ImportShell visitor="Signed Out">
      <VndbSignedOut />
      <ImportLibraryView result={null} snapshot={otherViewer} busy={false} onRead={noop} />
    </ImportShell>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByText('Private source note')).toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-source-xml]')).toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-native-question]')).toBeNull();
    await expect(canvasElement.querySelector('[data-vndb-native-vote="present"]')).toBeNull();
  },
};
export const OtherViewerPhone: Story = { ...OtherViewerDesktop, globals: phone };

export const UploadDesktop: Story = {
  name: 'Private upload',
  globals: desktop,
  render: () => (
    <ImportShell>
      <VndbUploadForm busy={false} onUpload={noop} onReadFailure={noop} />
    </ImportShell>
  ),
};
export const UploadPhone: Story = { ...UploadDesktop, globals: phone };

/** Kept for existing catalogue references; the named owner preview is OwnerPreviewDesktop. */
export const Review: Story = OwnerPreviewDesktop;
export const Results: Story = PartialResultDesktop;
