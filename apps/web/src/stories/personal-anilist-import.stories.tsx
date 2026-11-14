import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PersonalAniListImportPage } from '../library/personal-anilist-import/page';
import { AniListImportPortContext } from '../library/personal-anilist-import/port';
import type {
  AniListApplyCallResult,
  AniListImportPort,
  AniListJson,
  AniListLabelReview,
  AniListPage,
  AniListQuestion,
  AniListReview,
  AniListRow,
} from '../library/personal-anilist-import/contract';
import { QUESTION } from '../features/pages/subject-ratings';
import { PatternStory } from './page';

type NavigationState = 'observed' | 'failed-previous' | 'retained-edge';

const owner = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const importId = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const reviewIds = Array.from({ length: 11 }, (_, index) => `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`);
const titles = ['Zero means unrated', 'Clear the old vote', 'Guard unavailable', 'Unmatched source title'];
const sourceScores = [0, 8, 6, 0];
const existingVotes: (number | null)[] = [5, 9, null, null];

function makeSource(ordinal: number): AniListRow['source'] {
  return {
    evidence: {
      mediaId: ordinal + 1,
      status: 'CURRENT',
      score: sourceScores[ordinal % sourceScores.length]!,
      progress: 0,
      customLists: { 'Private favourites': true },
      media: { id: ordinal + 1, type: 'ANIME', title: { userPreferred: titles[ordinal % titles.length]! } },
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
    match: {
      state: ordinal === 3 ? 'unmatched' : 'matched',
      candidates: ordinal === 3 ? [] : [subject],
      fingerprint: `match-${ordinal}`,
    },
    proposal:
      ordinal === 3
        ? null
        : {
            subjectId: subject,
            epoch: '1',
            pin: null,
            proposedState: 'active',
            current: { state: 'active', revision: 3, incarnationId: null },
            states: [{ id: 'active', role: 'active' }],
          },
    labelEvidence: {
      membership: 'available',
      grouping: 'custom',
      tags: 'missing',
      values: [{ key: 'customLists:Private', value: 'Private favourites', member: true, origin: 'customLists' }],
      selectable: [{ key: 'customLists:Private', value: 'Private favourites', member: true, origin: 'customLists' }],
      tagEvidence: { entry: 'missing', media: 'missing', membership: 'unavailable' },
      reason: 'Illustrative retained native label evidence',
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

function makeJourneyPort(navigation?: NavigationState) {
  const count = navigation === 'retained-edge' ? 11 : titles.length;
  let lastAfter = -1;
  let failPrevious = navigation === 'failed-previous';
  const reviews = new Map<number, AniListReview>();
  const readbacks = new Map<number, AniListJson>();
  let applyAttempts = 0;
  const questionRevision = 17;
  const labelReviews = new Map<number, AniListLabelReview>();
  const port: AniListImportPort = {
    async reviewLabels(command) {
      const ordinal = command.body.ordinal;
      const review: AniListLabelReview = {
        id: reviewIds[ordinal]!,
        subjectId: command.body.subjectId!,
        identityEpoch: '1',
        sourceDigest: 'illustrative-digest',
        matchFingerprint: `match-${ordinal}`,
        clientId: 'story-client',
        requestedBy: null,
        items: command.body.selections.map((selection, index) => ({
          key: selection.key,
          value: 'Private favourites',
          origin: 'customLists',
          createKey: `create-${index}`,
          assignKey: `assign-${index}`,
          target:
            'name' in selection.target
              ? { name: selection.target.name, primary: 0 }
              : { label: { id: selection.target.labelId, revision: 1 } },
        })),
      };
      labelReviews.set(ordinal, review);
      return { kind: 'labels-reviewed', ordinal, review };
    },
    async applyLabels(command) {
      return {
        kind: 'labels-applied',
        result: {
          complete: true,
          outcomes: command.body.confirmations.map(({ ordinal, reviewId }) => ({
            ordinal,
            reviewId,
            complete: true,
            items: labelReviews.get(ordinal)!.items.map((item) => ({
              key: item.key,
              status: 'applied' as const,
              label: { id: subject, revision: 1 },
              assignment: { id: importId, revision: 1 },
            })),
          })),
        },
      };
    },
    async readLabels() {
      return { kind: 'labels-read', labels: [] };
    },
    async labelTargets() {
      return { kind: 'label-targets', labels: [{ id: subject, name: 'Private favourites', revision: 1 }], next: null };
    },
    async preview() {
      return { kind: 'previewed', importId, count };
    },
    async page(command) {
      if (failPrevious && command.after < lastAfter) {
        failPrevious = false;
        return { kind: 'unavailable' };
      }
      lastAfter = command.after;
      const ordinals = Array.from({ length: count }, (_, index) => index)
        .filter((ordinal) => !navigation || ordinal > command.after)
        .slice(0, navigation === 'retained-edge' ? 1 : navigation ? 2 : count);
      const last = ordinals.at(-1);
      const page: AniListPage = {
        importId,
        header: { document: null, rawUpload: '', scoreFormat: 'POINT_10', count, cancelled: false },
        completeness: { wrapper: 'array', hasNextChunk: false, listedGroups: 0 },
        rows: ordinals.map((ordinal) => ({
          ...row(ordinal, readbacks.get(ordinal)),
          review: reviews.get(ordinal) ?? null,
          ...(labelReviews.has(ordinal) ? { labelReview: labelReviews.get(ordinal)! } : {}),
        })),
        next: navigation && last !== undefined && last < count - 1 ? last : null,
      };
      return { kind: 'page', page };
    },
    async review(command) {
      const selectedSubject = command.subjectId ?? subject;
      const existingVote = existingVotes[command.ordinal % existingVotes.length]!;
      const rawScore = command.score
        ? {
            source: {
              present: true,
              value: sourceScores[command.ordinal % sourceScores.length]!,
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
              target: { subjectId: selectedSubject, identityEpoch: '1', matchFingerprint: `match-${command.ordinal}` },
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
        match: { state: 'matched', candidates: [selectedSubject], fingerprint: `match-${command.ordinal}` },
        observation: {
          subjectId: selectedSubject,
          epoch: '1',
          pin: null,
          proposedState: 'active',
          current: { state: 'active', revision: 3, incarnationId: null },
          states: [{ id: 'active', role: 'active' }],
        },
        input: {
          fields: command.fields,
          replace: command.replace,
          subjectId: selectedSubject,
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
  return { port };
}

function ScoreImportStory({ navigation }: { navigation?: NavigationState } = {}) {
  const fixture = useMemo(() => makeJourneyPort(navigation), [navigation]);
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
    [navigation],
  );
  return (
    <PatternStory path="/library/import-anilist" visitor="Signed In">
      <aside className="mx-auto max-w-5xl space-y-2 border-b p-4 text-sm">
        {navigation ? (
          <p>
            {navigation === 'retained-edge'
              ? 'Upload or reopen, move Next ten times, then Previous eight times. At the retained edge, choose First explicitly.'
              : navigation === 'failed-previous'
                ? 'Upload or reopen, choose Next, then Previous. The first return read fails; retry the requested page or deliberately choose First.'
                : 'Upload or reopen, review an item, then choose Next, Previous and First. Navigation sends page reads and preserves independent confirmation.'}
          </p>
        ) : null}
        <p>
          Illustrative contract-shaped fixtures. Upload the sample, review a matched item or choose a target for the
          unmatched title, and review labels independently. The first confirmation loses its acknowledgement; retry
          preserves the original command and shows mixed results. Current readback is separate.
        </p>
        <a
          className="underline"
          download="anilist-illustrative.json"
          href={`data:application/json,${encodeURIComponent(JSON.stringify(Array.from({ length: navigation === 'retained-edge' ? 11 : titles.length }, (_, ordinal) => makeSource(ordinal).evidence)))}`}
        >
          Download illustrative export
        </a>
      </aside>
      <AniListImportPortContext.Provider value={fixture.port}>
        <PersonalAniListImportPage key={navigation} visit={visit} />
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

export const ScoreReviewConsentAndReadback: Story = {};

export const ObservedPreviousAndFirst: Story = { args: { navigation: 'observed' } };
export const FailedPreviousExactRetry: Story = { args: { navigation: 'failed-previous' } };
export const RetainedEdgeFirst: Story = { args: { navigation: 'retained-edge' } };
