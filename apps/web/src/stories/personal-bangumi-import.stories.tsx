import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PersonalBangumiImportPage } from '../library/personal-bangumi-import/page';
import { BangumiImportPortContext } from '../library/personal-bangumi-import/port';
import {
  BANGUMI_FORMAT,
  type BangumiImportPort,
  type BangumiLabelState,
  type BangumiRow,
  type BangumiScoreReview,
} from '../library/personal-bangumi-import/contract';
import type { BangumiVisit } from '../library/personal-bangumi-import/visit';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

type NavigationState = 'observed' | 'failed-previous' | 'retained-edge';

const uploadId = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const token = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const questionId = '0192f3a0-6c1e-7b2a-9d4e-00000000eeee';
const score: BangumiScoreReview = {
  source: { state: 'unrated', value: 0, scale: { minimum: 1, maximum: 10 }, reason: 'Bangumi rate 0 means unrated' },
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
    selection: { action: 'preserve' },
    admission: { status: 'reviewed', reason: 'native_review_observed' },
  },
};
const collections = [
  {
    subject_id: 12345,
    subject_type: 2,
    type: 3,
    rate: 0,
    tags: ['café'],
    subject: { name: 'Illustrative matched series' },
  },
  { subject_id: 12346, subject_type: 2, type: 2, rate: 8, tags: [], subject: { name: 'Unmatched source title' } },
];
function makePort(navigation?: NavigationState): BangumiImportPort {
  let lastAfter = -1;
  let failPrevious = navigation === 'failed-previous';
  let firstApply = true;
  let cancelled = false;
  let labelState: BangumiLabelState | null = null;
  const supplied = navigation === 'retained-edge'
    ? Array.from({ length: 11 }, (_, ordinal) => ({ ...collections[ordinal % collections.length]!, subject_id: 12345 + ordinal }))
    : collections;
  const rows: BangumiRow[] = supplied.map((source, ordinal) => ({
    ordinal,
    evidence: {
      source,
      medium: 'anime',
      stateRole: 'active',
      fields: [
        { field: 'rate', value: source.rate, meaning: 'known', reason: 'Original 1–10 source scale; zero is unrated' },
        { field: 'tags', value: source.tags, meaning: 'known', reason: 'Private source tags' },
      ],
    },
    review: {
      token,
      match: ordinal === 0 ? 'matched' : 'unmatched',
      candidates: ordinal === 0 ? [subjectId] : [],
      target: ordinal === 0 ? subjectId : null,
      guard: null,
      proposedState: 'active',
      current: ordinal === 0 ? { state: 'planned', revision: 3 } : null,
      conflict: ordinal === 0,
      score:
        ordinal === 0
          ? score
          : {
              ...score,
              source: {
                state: 'score',
                value: 8,
                scale: { minimum: 1, maximum: 10 },
                reason: 'Original Bangumi score',
              },
            },
    },
    outcome: null,
  }));
  return {
    async preview() {
      return { kind: 'previewed', uploadId, count: rows.length };
    },
    async page(command) {
      if (failPrevious && command.after < lastAfter) {
        failPrevious = false;
        return { kind: 'unavailable' };
      }
      lastAfter = command.after;
      const current = navigation ? rows.filter((row) => row.ordinal > command.after).slice(0, 1) : rows;
      const last = current.at(-1)?.ordinal;
      return { kind: 'page', page: {
        uploadId, cancelled, rows: structuredClone(current),
        next: navigation && last !== undefined && last < rows.length - 1 ? last : null,
      } };
    },
    async review(command) {
      const row = rows[command.ordinal]!;
      row.review = {
        ...row.review!,
        token: command.key,
        target: command.target ?? row.review!.target,
        match: command.target ? 'chosen' : row.review!.match,
        score: {
          ...row.review!.score!,
          native: { ...row.review!.score!.native, selection: command.score ?? { action: 'preserve' } },
        },
      };
      return { kind: 'reviewed', ordinal: command.ordinal, review: row.review };
    },
    async apply(command) {
      if (firstApply) {
        firstApply = false;
        return { kind: 'unknown', command };
      }
      const outcomes = command.body.rows.map((choice) => ({
        ordinal: choice.ordinal,
        status: choice.ordinal === 1 ? ('failed' as const) : ('applied' as const),
        applied: choice.skip ? [] : ['type'],
        retained: ['rate', 'tags'],
        score:
          choice.score && choice.score.action !== 'preserve'
            ? {
                action: choice.score.action,
                status: 'unavailable' as const,
                reason: 'illustrative-conditional-admission',
              }
            : { action: 'preserve' as const, status: 'skipped' as const },
      }));
      for (const outcome of outcomes) rows[outcome.ordinal]!.outcome = outcome;
      return { kind: 'applied', result: { uploadId, outcomes, remaining: [] } };
    },
    async admitSource() {
      return { kind: 'admitted' };
    },
    async inspect() {
      return {
        entry: { status: 'present', state: 'active', revision: 4 },
        vote: { status: 'current', vote: { state: 'set', units: 0, revision: 3, at: '2026-10-10T12:00:00Z' } },
      };
    },
    async cancel() {
      cancelled = true;
      return { kind: 'cancelled', uploadId };
    },
    async delete() {
      return { kind: 'deleted' };
    },
    async tags(command) {
      return {
        kind: 'tags',
        page: {
          ordinal: command.ordinal,
          rowRevision: rows[command.ordinal]!.review!.token,
          evidence: command.ordinal === 0 ? 'known' : 'empty',
          tags: command.ordinal === 0 ? [{ index: 0, value: 'café', status: 'supported', proposedName: 'café' }] : [],
          next: null,
          labels: labelState,
        },
        custody: command.custody ?? {
          viewer: subjectId,
          csrfToken: 'story-csrf',
          credential: 'illustrative-encrypted-sender',
        },
      };
    },
    async searchLabels() {
      return { kind: 'label-options', labels: [{ id: subjectId, name: 'café', revision: 3 }] };
    },
    async reviewLabels(command) {
      labelState = {
        review: {
          token,
          rowRevision: command.rowRevision,
          subject: { subjectId, identityEpoch: '1', acceptingType: 'ex:Anime', releaseDigest: 'a'.repeat(64) },
          evidence: 'known',
          items: command.mappings.map((mapping) => ({
            index: mapping.index,
            source: 'café',
            status: 'ready',
            duplicateOf: null,
            target: 'labelId' in mapping.target ? { ...mapping.target, revision: 3 } : mapping.target,
          })),
        },
        confirmed: false,
        outcomes: [],
      };
      return { kind: 'labels-reviewed', ordinal: command.ordinal, labels: labelState };
    },
    async applyLabels(command) {
      return {
        kind: 'labels-applied',
        result: {
          uploadId,
          ordinal: command.ordinal,
          outcomes: [
            {
              index: 0,
              status: 'assigned',
              label: { id: subjectId, revision: 3 },
              assignment: { id: uploadId, revision: 1 },
              created: false,
            },
          ],
          remaining: [],
        },
      };
    },
    async readAssignments(subjectId) {
      return {
        kind: 'assignments',
        subjectId,
        assignments: [{ id: uploadId, labelId: subjectId, name: 'café', revision: 1 }],
      };
    },
  };
}
function BangumiImportStory({ navigation }: { navigation?: NavigationState } = {}) {
  const port = useMemo(() => makePort(navigation), [navigation]);
  const visit = useMemo<BangumiVisit>(() => {
    const controller = new AbortController();
    return {
      identity: 1,
      subject: subjectId,
      csrfToken: 'story-csrf',
      locale: getLocale(),
      controller,
      current: () => !controller.signal.aborted,
      retire: () => controller.abort(),
    };
  }, [navigation]);
  return (
    <PatternStory path="/library/import-bangumi" visitor="Signed In">
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
          Illustrative contract-shaped fixtures. Upload the sample or reopen upload {uploadId}. Review the matched item,
          replace its Library state deliberately, and choose a target for the unmatched item. Source zero stays unrated;
          a native zero vote is distinct. Labels have their own review and consent. First confirmation loses its
          acknowledgement; exact retry shows mixed results. Inspect current facts separately and return to Library.
          Opening is still; locale and viewport changes are manual.
        </p>
        <a
          className="underline"
          download="bangumi-illustrative.json"
          href={`data:application/json,${encodeURIComponent(JSON.stringify({ format: BANGUMI_FORMAT, collections: navigation === 'retained-edge' ? Array.from({ length: 11 }, (_, ordinal) => ({ ...collections[ordinal % collections.length]!, subject_id: 12345 + ordinal })) : collections }))}`}
        >
          Download illustrative export
        </a>
      </aside>
      <BangumiImportPortContext.Provider value={port}>
        <PersonalBangumiImportPage key={navigation} visit={visit} />
      </BangumiImportPortContext.Provider>
    </PatternStory>
  );
}
const meta = {
  title: 'Library/Personal Bangumi import',
  id: 'personal-bangumi-import',
  component: BangumiImportStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof BangumiImportStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReviewedSetNeedsConsent: Story = {};

export const ObservedPreviousAndFirst: Story = { args: { navigation: 'observed' } };
export const FailedPreviousExactRetry: Story = { args: { navigation: 'failed-previous' } };
export const RetainedEdgeFirst: Story = { args: { navigation: 'retained-edge' } };
