import type { Meta, StoryObj } from '@storybook/react-vite';
import type { BangumiRowMeta, BangumiScoreReview } from '../library/personal-bangumi-import/contract';
import { BangumiScoreConfirmation, BangumiScoreReviewPanel } from '../library/personal-bangumi-import/score';

const questionId = '0192f3a0-6c1e-7b2a-9d4e-00000000eeee';
const score: BangumiScoreReview = {
  source: {
    state: 'unrated',
    value: 0,
    scale: { minimum: 1, maximum: 10 },
    reason: 'Bangumi rate 0 means unrated',
  },
  native: {
    questionId,
    question: {
      id: questionId,
      revision: 7,
      meaning: 'Community rating',
      label: 'Quality',
      grain: 'work',
      lifecycleState: 'active',
      scale: { minimum: 0, maximum: 20, step: 2 },
    },
    currentVote: { state: 'set', units: 0, revision: 3, at: '2026-10-10T12:00:00Z' },
    selection: { action: 'set', units: 8 },
    admission: { status: 'reviewed', reason: 'native_review_observed' },
  },
};

const row: BangumiRowMeta = {
  ordinal: 0,
  title: 'Prepared score review',
  medium: 'anime',
  stateRole: 'active',
  match: 'chosen',
  target: '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb',
  proposedState: 'active',
  current: null,
  conflict: false,
  reviewToken: '0192f3a0-6c1e-7b2a-9d4e-00000000cccc',
  choice: { state: 'preserve', skip: false },
  scoreReview: score,
  scoreConsent: false,
  outcome: null,
  entryReadback: null,
  voteReadback: null,
  sourcePreview: {
    provider: 'bangumi',
    recordId: '12345',
    privacy: { kind: 'unsupported', reason: 'No source privacy setting was supplied.' },
    sourceCreated: { kind: 'unsupported', reason: 'No source timestamp was supplied.' },
    sourceUpdated: { kind: 'unsupported', reason: 'No source timestamp was supplied.' },
  },
  sourceAdmission: null,
};

function Example() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4">
      <h2 className="text-lg font-semibold">Bangumi score review and separate consent</h2>
      <BangumiScoreReviewPanel
        review={score}
        hasTarget
        draft={{ action: 'set', units: '8' }}
        base="story-bangumi"
        disabled
        onChange={() => {}}
      />
      <section className="space-y-2 rounded-md border p-3" aria-label="Confirmation">
        <BangumiScoreConfirmation row={row} disabled onConsent={() => {}} />
      </section>
    </main>
  );
}

const meta = {
  title: 'Library/Personal Bangumi import',
  id: 'personal-bangumi-import',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Uses the production score review and confirmation components. Fixtures show Bangumi zero as unrated, a real native zero vote, the supplied question scale and distinct per-row consent; they are not native admission or write evidence.',
      },
    },
  },
} satisfies Meta<typeof Example>;

export default meta;
type Story = StoryObj<typeof meta>;
export const ReviewedSetNeedsConsent: Story = {};
