import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PersonalAniListImportPage } from '../library/personal-anilist-import/page';
import { AniListImportPortContext } from '../library/personal-anilist-import/port';
import type {
  AniListApplyCallResult,
  AniListImportPort,
  AniListJson,
  AniListPage,
  AniListQuestion,
  AniListReview,
  AniListRow,
} from '../library/personal-anilist-import/contract';
import { m } from '../paraglide/messages.js';
import { QUESTION } from '../features/pages/subject-ratings';
import { PatternStory } from './page';

const owner = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const importId = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const reviewIds = [
  '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  '0192f3a0-6c1e-7b2a-9d4e-000000000004',
];
const titles = ['Zero means unrated', 'Clear the old vote', 'Guard unavailable', 'Keep by default'];
const sourceScores = [0, 8, 6, 0];
const existingVotes: (number | null)[] = [5, 9, null, null];
let refreshStoryReadback: () => void = () => {};

function makeSource(ordinal: number): AniListRow['source'] {
  return {
    evidence: {
      mediaId: ordinal + 1,
      status: 'CURRENT',
      score: sourceScores[ordinal]!,
      progress: 0,
      media: { id: ordinal + 1, type: 'ANIME', title: { userPreferred: titles[ordinal]! } },
    },
    group: null,
    identifiers: [{ source: 'anilist', externalId: String(ordinal + 1) }],
    fields: [
      { field: 'status', validity: 'valid', reason: 'Current list state.' },
      { field: 'score', validity: 'valid', reason: 'Exact imported score evidence.' },
    ],
  };
}

function row(ordinal: number, score?: AniListJson): AniListRow {
  return {
    ordinal,
    source: makeSource(ordinal),
    ...(ordinal === 0 ? { scoreLexeme: '0.00' } : {}),
    match: { state: 'matched', candidates: [subject], fingerprint: `match-${ordinal}` },
    proposal: {
      subjectId: subject,
      epoch: '1',
      pin: null,
      proposedState: 'active',
      current: { state: 'active', revision: 3, incarnationId: null },
      states: [{ id: 'active', role: 'active' }],
    },
    review: null,
    started: false,
    outcome: null,
    ...(score === undefined ? {} : { currentScore: score }),
  };
}

function question(revision: number): AniListQuestion {
  return {
    id: QUESTION,
    revision,
    label: 'Overall',
    meaning: 'How strong is this work overall?',
    grain: 'work',
    scale: { min: 0, max: 20, displayStep: 1 },
  };
}

function makeJourneyPort() {
  const reviews = new Map<number, AniListReview>();
  const readbacks = new Map<number, AniListJson>();
  let applyAttempts = 0;
  let questionRevision = 17;
  const port: AniListImportPort = {
    async reviewLabels() {
      return { kind: 'unavailable' };
    },
    async applyLabels() {
      return { kind: 'unavailable' };
    },
    async readLabels() {
      return { kind: 'unavailable' };
    },
    async labelTargets() {
      return { kind: 'unavailable' };
    },
    async preview() {
      return { kind: 'previewed', importId, count: titles.length };
    },
    async page(): Promise<{ kind: 'page'; page: AniListPage }> {
      return {
        kind: 'page',
        page: {
          importId,
          header: { document: null, rawUpload: '', scoreFormat: 'POINT_10', count: titles.length, cancelled: false },
          completeness: { wrapper: 'array', hasNextChunk: false, listedGroups: 0 },
          rows: titles.map((_, ordinal) => row(ordinal, readbacks.get(ordinal))),
          next: null,
        },
      };
    },
    async review(command) {
      const existingVote = existingVotes[command.ordinal]!;
      const rawScore = command.score
        ? {
            source: {
              present: true,
              value: sourceScores[command.ordinal]!,
              lexeme: command.ordinal === 0 ? '0.00' : null,
              scale: 'POINT_10',
              validity: 'valid',
              reason: 'Exact imported score evidence.',
            },
            action: command.score.action,
            units: command.score.action === 'vote' ? command.score.units : null,
            conversion: 'owner-selected-native-units',
            native: {
              availability: command.ordinal === 2 ? 'unavailable' : 'available',
              ...(command.ordinal === 2 ? { reason: 'atomic_guard_unavailable' } : { guard: { version: 1 } }),
              question: {
                id: QUESTION,
                revision: questionRevision,
                label: 'Overall',
                meaning: 'How strong is this work overall?',
                grain: 'work',
                minimumUnits: 0,
                maximumUnits: 20,
                stepUnits: 1,
                lifecycleState: 'active',
                lifecycleRevision: 1,
              },
              target: { subjectId: subject, identityEpoch: '1', matchFingerprint: `match-${command.ordinal}` },
              currentVote:
                command.ordinal === 2
                  ? { status: 'unavailable', reason: 'atomic_guard_unavailable' }
                  : {
                      status: 'current',
                      vote: existingVote === null ? null : { units: existingVote, revision: 2 },
                    },
              commandKey: `score-command-${command.ordinal}`,
              consentKey: `score-consent-${command.ordinal}`,
              consented: false,
            },
          }
        : undefined;
      const review: AniListReview = {
        id: reviewIds[command.ordinal]!,
        commandKey: command.key,
        clientId: 'story-client',
        requestedBy: null,
        sourceFingerprint: `source-${command.ordinal}`,
        match: { state: 'matched', candidates: [subject], fingerprint: `match-${command.ordinal}` },
        observation: {
          subjectId: subject,
          epoch: '1',
          pin: null,
          proposedState: 'active',
          current: { state: 'active', revision: 3, incarnationId: null },
          states: [{ id: 'active', role: 'active' }],
        },
        input: {
          fields: command.fields,
          replace: command.replace,
          subjectId: subject,
          ...(command.score ? { score: command.score } : {}),
        },
        ...(rawScore ? { score: rawScore } : {}),
      };
      reviews.set(command.ordinal, review);
      return { kind: 'reviewed', ordinal: command.ordinal, review };
    },
    async apply(command): Promise<AniListApplyCallResult> {
      applyAttempts += 1;
      if (applyAttempts === 1) return { kind: 'unknown', command };
      const outcomes = command.body.confirmations.map(({ ordinal, confirmNativeVoteEffects }) => {
        const reviewed = reviews.get(ordinal);
        const hasScore = !!reviewed?.score;
        const score = reviewed?.score;
        const scoreAction = score?.action;
        const scoreUnits = score?.units;
        const scoreStatus = ordinal === 2 ? 'unavailable' : 'applied';
        if (hasScore && confirmNativeVoteEffects) {
          readbacks.set(
            ordinal,
            ordinal === 2
              ? { status: 'unavailable', reason: 'atomic_guard_unavailable' }
              : {
                  status: 'current',
                  question: { id: QUESTION, revision: questionRevision, label: 'Overall' },
                  vote: scoreAction === 'clear' ? null : { units: scoreUnits!, revision: 4 },
                },
          );
        }
        return {
          ordinal,
          status: ordinal === 1 ? ('failed' as const) : ('applied' as const),
          retained: ['score', 'progress'],
          ...(hasScore
            ? { score: { status: scoreStatus, ...(ordinal === 2 ? { reason: 'atomic_guard_unavailable' } : {}) } }
            : {}),
        };
      });
      return { kind: 'applied', result: { outcomes, complete: true } };
    },
    async admitSource() {
      return { kind: 'admitted' };
    },
    async cancel(command) {
      return { kind: 'cancelled', removed: command.remove };
    },
    async question() {
      return { kind: 'question', question: question(questionRevision) };
    },
  };
  return {
    port,
    refreshReadback() {
      questionRevision = 18;
      readbacks.set(0, {
        status: 'current',
        question: { id: QUESTION, revision: 18, label: 'Overall' },
        vote: { units: 2, revision: 5 },
      });
    },
  };
}

function createJourneyPort() {
  const fixture = makeJourneyPort();
  refreshStoryReadback = fixture.refreshReadback;
  return fixture;
}

function ScoreImportStory() {
  const fixture = useMemo(createJourneyPort, []);
  const visit = useMemo(
    () => ({
      subject: owner,
      csrfToken: 'story-csrf',
      controller: new AbortController(),
      current() {
        return !this.controller.signal.aborted;
      },
      retire() {
        this.controller.abort();
      },
    }),
    [],
  );
  return (
    <PatternStory path="/library/import-anilist" visitor="Signed In">
      <AniListImportPortContext.Provider value={fixture.port}>
        <PersonalAniListImportPage visit={visit} />
      </AniListImportPortContext.Provider>
    </PatternStory>
  );
}

const meta = {
  title: 'Library/AniList import',
  id: 'pages-library-anilist-import',
  component: ScoreImportStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ScoreImportStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ScoreReviewConsentAndReadback: Story = {
  globals: { locale: 'en' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText(m.library_anilist_file_label()) as HTMLInputElement;
    await userEvent.upload(input, new File(['[]'], 'collection.json', { type: 'application/json' }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_anilist_upload() }));
    const rowAt = (ordinal: number) =>
      within(canvasElement.querySelector(`[data-anilist-row="${ordinal}"]`) as HTMLElement);
    const row0 = rowAt(0);

    await expect(row0.getByRole('radio', { name: m.library_anilist_score_keep() })).toBeChecked();
    await userEvent.click(row0.getByRole('radio', { name: m.library_anilist_score_vote() }));
    await userEvent.type(row0.getByRole('spinbutton', { name: m.library_anilist_native_units() }), '0');
    await expect(row0).toHaveTextContent(m.library_anilist_source_zero_unrated());
    await expect(row0).toHaveTextContent(m.library_anilist_native_zero_is_vote());
    await userEvent.click(row0.getByRole('button', { name: m.library_anilist_save_review() }));
    await expect(row0).toHaveTextContent(m.library_anilist_review_vote_present({ units: 5 }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_anilist_continue_confirm() }));
    const confirmAt = (ordinal: number) =>
      within(canvasElement.querySelector(`[data-anilist-confirm="${ordinal}"]`) as HTMLElement);
    let confirm0 = confirmAt(0);
    await userEvent.click(confirm0.getByRole('checkbox', { name: m.library_anilist_confirm_native_vote_effects() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_anilist_return_review() }));
    const review0Again = within(canvasElement.querySelector('[data-anilist-row="0"]') as HTMLElement);
    await userEvent.click(review0Again.getByRole('checkbox', { name: m.library_anilist_replace_vote_and_state() }));
    await userEvent.click(review0Again.getByRole('button', { name: m.library_anilist_save_review() }));
    const row1 = rowAt(1);
    await userEvent.click(row1.getByRole('radio', { name: m.library_anilist_score_clear() }));
    await userEvent.click(row1.getByRole('button', { name: m.library_anilist_save_review() }));
    const row2 = rowAt(2);
    await userEvent.click(row2.getByRole('radio', { name: m.library_anilist_score_vote() }));
    await userEvent.type(row2.getByRole('spinbutton', { name: m.library_anilist_native_units() }), '12');
    await userEvent.click(row2.getByRole('button', { name: m.library_anilist_save_review() }));
    const row3 = rowAt(3);
    await userEvent.click(row3.getByRole('button', { name: m.library_anilist_save_review() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_anilist_continue_confirm() }));

    confirm0 = confirmAt(0);
    const confirm1 = confirmAt(1);
    const confirm2 = confirmAt(2);
    const confirm3 = confirmAt(3);
    await expect(
      confirm0.getByRole('checkbox', { name: m.library_anilist_confirm_native_vote_effects() }),
    ).not.toBeChecked();
    await expect(confirm1).toHaveTextContent(m.library_anilist_confirm_clear());
    await expect(confirm3).toHaveTextContent(m.library_anilist_score_keep());
    for (const card of [confirm0, confirm1, confirm2]) {
      await userEvent.click(card.getByRole('checkbox', { name: m.library_anilist_confirm_native_vote_effects() }));
    }
    await userEvent.click(canvas.getByRole('checkbox', { name: m.library_import_source_privacy_confirm() }));
    await userEvent.click(canvas.getByRole('checkbox', { name: m.library_import_source_timestamps_confirm() }));
    await userEvent.click(canvas.getByRole('button', { name: m.library_anilist_confirm() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.library_anilist_retry_command() }));

    const result0 = rowAt(0);
    const result1 = rowAt(1);
    const result2 = rowAt(2);
    const result3 = rowAt(3);
    await expect(result0).toHaveTextContent(m.library_anilist_score_readback_vote({ units: 0 }));
    await expect(result1).toHaveTextContent(m.library_anilist_result_failed());
    await expect(result1).toHaveTextContent(m.library_anilist_score_outcome_applied());
    await expect(result2).toHaveTextContent('atomic_guard_unavailable');
    await expect(result2).toHaveTextContent(m.library_anilist_score_outcome_unavailable());
    await expect(result3).toHaveTextContent(m.library_anilist_score_no_effect());
    await expect(result0).toHaveTextContent(m.library_anilist_source_score_retained());

    refreshStoryReadback();
    await userEvent.click(canvas.getByRole('button', { name: m.library_anilist_fresh_read() }));
    await expect(rowAt(0)).toHaveTextContent(m.library_anilist_score_readback_vote({ units: 2 }));
    await expect(rowAt(0)).toHaveTextContent(m.library_anilist_question_revision({ revision: 18 }));
  },
};
