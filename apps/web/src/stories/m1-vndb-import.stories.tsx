import type { Meta, StoryObj } from '@storybook/react-vite';
import { createVndbJourney } from '../library/personal-list-import/controller';
import type { VndbPort, VndbRow } from '../library/personal-list-import/contract';
import { VndbReviewPage } from '../library/personal-list-import/review';
import { VndbResultPage } from '../library/personal-list-import/results';
import { ImportLibraryView } from '../library/showcase-import-return/view';
import { PatternStory } from './page';
import { m } from '../paraglide/messages.js';

// Illustrative native-format states; these do not claim a seeded running-product pass.
const noop = () => {};
const uploadId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const row: VndbRow = {
  ordinal: 0,
  kind: 'vn',
  title: 'とても長い原題 — 繁體中文與日本語を含む物語のタイトル',
  identifier: { provider: 'vndb', kind: 'vn', value: 'v123' },
  labels: ['Playing'],
  suggestedRole: 'active',
  fields: { score: { kind: 'value', raw: '07.3', value: 7.3, scale: { min: 1, max: 10, step: 0.1 } } },
  retainedReason: '',
  evidence: { releases: [{ id: 'r456' }] },
  match: { status: 'matched', candidates: [targetId] },
  target: {
    targetId,
    states: [{ id: 'playing', labels: { en: 'Playing', ja: 'プレイ中', 'zh-Hant': '遊玩中' } }],
    baseline: null,
  },
  decision: null,
  scoreDecision: null,
  consumptionDateReview: null,
  consumptionDateOutcome: null,
  nativeScore: {
    question: null,
    currentVote: { state: 'unavailable' },
    sourceReason: 'private source',
    exactUnits: null,
    admission: { status: 'unavailable', reason: 'native-question-unavailable' },
  },
  fieldsTreatment: { state: 'review', score: 'private source', other: 'retain' },
};
async function snapshot(results: boolean) {
  const unavailable = async () => ({ kind: 'unavailable' as const, status: 503 });
  const port: VndbPort = {
    preview: async () => ({
      kind: 'previewed',
      value: {
        uploadId,
        rows: 1,
        limits: {
          bytes: 2097152,
          wireBytes: 12582976,
          depth: 32,
          rows: 5000,
          evidenceBytes: 16777216,
          page: 8,
          uploads: 4,
          lifetimeMs: 86400000,
          applyMs: 5000,
        },
      },
    }),
    page: async () => ({
      kind: 'page',
      value: { uploadId, state: 'active', expiresAt: '2099-01-01T00:00:00Z', total: 1, next: null, rows: [row] },
    }),
    review: async () => ({
      kind: 'reviewed',
      value: {
        reviewId: uploadId,
        status: 'reviewed',
        targetId,
        state: 'playing',
        baseline: null,
        replace: false,
        action: 'state' as const,
      },
    }),
    apply: async () => ({
      kind: 'applied',
      value: { uploadId, outcomes: [{ ordinal: 0, reviewId: uploadId, status: 'applied' }], stopped: null },
    }),
    source: unavailable,
    cancel: unavailable,
    delete: unavailable,
  };
  const journey = createVndbJourney({
    port,
    visit: {
      subject: targetId,
      csrfToken: 'illustrative',
      controller: new AbortController(),
      current: () => true,
      retire: noop,
    },
  });
  await journey.preview('<vndb-export version="1.0"/>');
  if (results) {
    await journey.review({ ordinal: 0, action: 'state', targetId, state: 'playing', replace: false });
    journey.openConfirm();
    await journey.confirm();
  }
  return journey.snapshot();
}
const review = await snapshot(false);
const results = await snapshot(true);
function Example({ completed = false }: { completed?: boolean }) {
  return (
    <PatternStory>
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
        <h1 className="text-2xl font-semibold">{m.library_vndb_title()}</h1>
        {completed ? (
          <>
            <VndbResultPage snap={results} busy={false} onResume={noop} onReview={noop} onDiscard={noop} />
            <ImportLibraryView result={null} busy={false} onRead={noop} />
          </>
        ) : (
          <VndbReviewPage
            snap={review}
            busy={false}
            onReview={noop}
            onNext={noop}
            onPrevious={noop}
            onRefresh={noop}
            onConfirm={noop}
            onSource={noop}
            onHideSource={noop}
          />
        )}
      </main>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Library/VNDB import',
  component: Example,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Review: Story = {};
export const Results: Story = { args: { completed: true } };
