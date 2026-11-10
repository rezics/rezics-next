import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import type { MalPreviewRow, MalQuestion } from '../library/personal-mal-import/contract';
import { MalConfirmPage } from '../library/personal-mal-import/confirm';
import { PatternStory } from './page';

const meta = {
  title: 'Library/Personal MAL import',
  id: 'families-library-personal-mal-import',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'One production confirmation component with an admitted native score review. The consent checkbox is separate from state confirmation and source privacy/timestamp admission.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const target = '0192f3a0-6c1e-7b2a-9d4e-000000000091';
const questionId = '0192f3a0-6c1e-7b2a-9d4e-000000000092';
const question = {
  id: questionId,
  meaning: 'A personal rating for this work.',
  revision: 1,
  lifecycle: { state: 'active', revision: 1 },
  label: 'Personal rating',
  canonicalLabel: 'Personal rating',
  labelRevision: 1,
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
} satisfies MalQuestion;

const row = {
  index: 0,
  kind: 'anime',
  title: 'Example series',
  identifier: { namespace: 'https://myanimelist.net/anime', source: 'mal_anime', value: '42' },
  status: { kind: 'value', value: 'Completed', raw: 'Completed' },
  role: 'active',
  score: { kind: 'value', value: 8, raw: '8', scale: { min: 1, max: 10, step: 1 } },
  progress: null,
  dates: {},
  notes: { kind: 'missing' },
  tags: { kind: 'missing' },
  repeats: { kind: 'missing' },
  privacy: { kind: 'missing' },
  timestamps: {},
  fields: { my_score: '8' },
  retained: [{ field: 'my_score', reason: 'no-native-vote-admission' }],
  target,
  candidates: [{ subjectId: target }],
  match: 'matched',
  state: 'active',
  current: null,
  binding: null,
  source: { release: 'r1', epoch: '1', acceptingType: 'ex:Child' },
  review: {
    version: 'review-1',
    target,
    skip: false,
    replace: false,
    state: 'active',
    current: null,
    binding: null,
    source: { release: 'r1', epoch: '1', acceptingType: 'ex:Child' },
    conflict: false,
    unsupported: null,
    fingerprint: 'native-review-fingerprint',
    score: {
      action: 'adopt',
      source: { kind: 'value', value: 8, raw: '8', scale: { min: 1, max: 10, step: 1 } },
      sourceSupport: { status: 'owner-selection-required', reason: 'native-units-require-explicit-selection' },
      conversion: 'owner-selected-not-exact',
      question: {
        id: questionId,
        revision: 1,
        label: 'Personal rating',
        meaning: question.meaning,
        grain: 'work',
        lifecycleState: 'active',
        scale: { minimumUnits: 0, maximumUnits: 20, stepUnits: 1 },
      },
      units: 16,
      replaceCurrent: true,
      support: { status: 'supported', reason: null },
      baseline: { state: 'present', units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' },
      admission: { status: 'conditional', reason: null },
      guard: {
        version: 1,
        question: { revision: 1, lifecycleRevision: 1 },
        subject: { canonicalId: target, epochs: [] },
        ownVote: { state: 'present', observation: 'observed-vote-revision-3' },
      },
    },
  },
  outcome: null,
  tagEvidence: { grammar: 'mal-comma-v1', kind: 'missing', values: [], reason: null },
  dateReview: null,
  dateOutcome: null,
  labelOutcomes: [],
  progressMeasures: [],
  scoreReviewState: 'observations-match',
  currentScoreVote: { units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' },
} as unknown as MalPreviewRow;

export const ScoreConsent: Story = {
  render: () => (
    <PatternStory visitor="Signed In">
      <main className="mx-auto w-full min-w-0 max-w-3xl space-y-5 p-4 sm:p-8">
        <h1 className="text-xl font-semibold">{m.library_mal_title()}</h1>
        <MalConfirmPage
          rows={[row]}
          drafts={{ 0: { row: 0, target, skip: false, replace: false, fields: ['status'] } }}
          busy={false}
          confirmPrivacy
          confirmTimestamps
          question={question}
          voteReadbacks={new Map()}
          onBack={() => undefined}
          onConfirm={() => undefined}
          onConfirmSource={() => undefined}
        />
      </main>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const consent = await canvas.findByRole('checkbox', { name: m.library_mal_score_consent() });
    const confirm = await canvas.findByRole('button', { name: m.library_mal_confirm() });
    await expect(confirm).toBeDisabled();
    await userEvent.click(consent);
    await expect(confirm).toBeEnabled();
    await expect(
      canvas.getByText(m.library_mal_vote_present({ units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' })),
    ).toBeVisible();
  },
};
