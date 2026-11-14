import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PersonalMalImportPage } from '../library/personal-mal-import/page';
import { MalImportPortContext } from '../library/personal-mal-import/port';
import { labelReviewRow } from '../library/personal-mal-import/labels.fixture';
import {
  MAL_STANDARD_QUESTION_ID,
  type MalDeliveryCustody,
  type MalImportPort,
  type MalPreviewRow,
  type MalQuestion,
} from '../library/personal-mal-import/contract';
import type { MalVisit } from '../library/personal-mal-import/visit';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

type NavigationState = 'observed' | 'failed-previous' | 'retained-edge';

const id = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const target = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const question: MalQuestion = {
  id: MAL_STANDARD_QUESTION_ID,
  realmId: target,
  revision: 1,
  meaning: 'Personal enjoyment of this work.',
  lifecycle: { state: 'active', revision: 1 },
  label: 'Enjoyment',
  canonicalLabel: 'Enjoyment',
  labelRevision: 1,
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
};
const xml =
  '<myanimelist><anime><series_animedb_id>42</series_animedb_id><series_title>Illustrative matched series</series_title><my_status>Watching</my_status><my_score>8</my_score><my_tags>A &amp; B,second</my_tags></anime><anime><series_animedb_id>43</series_animedb_id><series_title>Unmatched source title</series_title><my_status>Completed</my_status><my_score>0</my_score></anime></myanimelist>';

function makePort(navigation?: NavigationState): MalImportPort {
  let lastAfter = 0;
  let failPrevious = navigation === 'failed-previous';
  let firstApply = true;
  let cancelled = false;
  const rows: MalPreviewRow[] = [
    {
      ...structuredClone(labelReviewRow),
      title: 'Illustrative matched series',
      identifier: { namespace: 'mal_anime', source: 'mal_anime', value: '42' },
      score: { kind: 'value', raw: '8', value: 8, scale: { min: 1, max: 10, step: 1 } },
      role: 'active',
      state: 'active',
      current: { state: 'planned', revision: 3, incarnationId: null },
      review: null,
    },
    {
      ...structuredClone(labelReviewRow),
      index: 1,
      title: 'Unmatched source title',
      identifier: { namespace: 'mal_anime', source: 'mal_anime', value: '43' },
      target: null,
      candidates: [],
      match: 'unmatched',
      review: null,
      tagEvidence: { grammar: 'mal-comma-v1', kind: 'missing', values: [], reason: null },
    },
  ];
  if (navigation === 'retained-edge') {
    for (let index = rows.length; index < 11; index += 1) rows.push({
      ...structuredClone(rows[0]!), index, title: `Illustrative item ${index + 1}`,
      identifier: { namespace: 'mal_anime', source: 'mal_anime', value: String(42 + index) },
    });
  }
  return {
    async preview() {
      return { kind: 'previewed', id };
    },
    async page(command) {
      if (failPrevious && command.after < lastAfter) {
        failPrevious = false;
        return { kind: 'unavailable' };
      }
      lastAfter = command.after;
      const current = navigation ? rows.filter((row) => row.index >= command.after).slice(0, 1) : rows;
      const last = current.at(-1)?.index;
      return {
        kind: 'page',
        page: {
          id,
          canceled: cancelled,
          total: rows.length,
          rows: structuredClone(current),
          next: navigation && last !== undefined && last < rows.length - 1 ? last + 1 : null,
          sourcePath: `/v1/libraryImports/mal/${id}/source`,
          limits: {
            bytes: 2097152,
            wireBytes: 4194304,
            evidenceBytes: 50331648,
            rows: 500,
            page: 20,
            depth: 16,
            uploads: 3,
          },
          labelLimits: {
            rows: 20,
            values: 32,
            newLabels: 32,
            sourceBytes: 8192,
            selectionBytes: 16384,
            outputBytes: 524288,
          },
        },
      };
    },
    async readQuestion() {
      return { kind: 'question', question };
    },
    async readVote() {
      return { kind: 'vote', value: { kind: 'current', units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' } };
    },
    async review(command) {
      const input = command.input;
      const row = rows[input.row]!;
      row.review = {
        version: command.key,
        fingerprint: `illustrative-review-${input.row}`,
        target: input.target,
        skip: input.skip,
        replace: input.replace,
        state: row.state,
        current: row.current,
        binding: row.binding,
        source: row.source,
        conflict: !!row.current,
        unsupported: null,
        ...(input.score
          ? {
              score: {
                action: input.score.action,
                source: row.score,
                sourceSupport: {
                  status: 'owner-selection-required',
                  reason: 'native-units-require-explicit-selection',
                },
                conversion: 'owner-selected-not-exact',
                question: {
                  id: question.id,
                  revision: 1,
                  label: question.label,
                  meaning: question.meaning ?? null,
                  grain: 'work',
                  lifecycleState: 'active',
                  scale: { minimumUnits: 0, maximumUnits: 20, stepUnits: 1 },
                },
                units: input.score.action === 'adopt' ? input.score.units : null,
                replaceCurrent: input.score.action === 'adopt' && input.score.replaceCurrent === true,
                support: { status: 'supported', reason: null },
                baseline: { state: 'present', units: 0, revision: 3, at: '2026-10-01T12:00:00.000Z' },
                admission: { status: 'conditional', reason: null },
                guard: {
                  version: 1,
                  question: { revision: 1, lifecycleRevision: 1 },
                  subject: { canonicalId: input.target, epochs: [] },
                  ownVote: { state: 'present', observation: 'illustrative-revision-3' },
                },
              },
            }
          : {}),
        ...(input.labels
          ? {
              labels: {
                ...labelReviewRow.review!.labels!,
                selections: input.labels.map((selection) => ({
                  ...selection,
                  sourceValue: row.tagEvidence!.values[selection.value]!.value,
                  status: 'ready' as const,
                  reason: null,
                })),
              },
            }
          : {}),
      };
      row.scoreReviewState = input.score ? 'observations-match' : null;
      return { kind: 'reviewed', id };
    },
    async apply(command) {
      if (firstApply) {
        firstApply = false;
        return { kind: 'unknown', command };
      }
      const outcomes = command.body.rows.map((choice) => ({
        row: choice.row,
        status: choice.row === 1 ? ('failed' as const) : ('applied' as const),
        applied: choice.row === 1 ? [] : choice.fields.filter((field) => field !== 'score'),
        retained: ['my_score', 'my_tags'],
        reason: choice.row === 1 ? 'illustrative-target-conflict' : null,
        ...(choice.fields.includes('score') && rows[choice.row]!.review?.score
          ? {
              score: {
                action: rows[choice.row]!.review!.score!.action,
                status: 'unavailable' as const,
                reason: 'illustrative-conditional-admission',
                vote: null,
              },
            }
          : {}),
        ...(choice.row === 0 && choice.fields.includes('tags')
          ? {
              labels: (rows[choice.row]!.review?.labels?.selections ?? []).map((selection) => ({
                value: selection.value,
                status: 'accepted' as const,
                labelId: target,
                assignment: { id, revision: 1 },
                reason: null,
              })),
            }
          : {}),
      }));
      for (const outcome of outcomes) rows[outcome.row]!.outcome = outcome;
      return { kind: 'applied', result: { id, stopped: false, remaining: [], outcomes } };
    },
    async admitSource() {
      return { kind: 'admitted' };
    },
    async cancel() {
      cancelled = true;
      return { kind: 'done', id };
    },
    async delete() {
      return { kind: 'done', id };
    },
    async source() {
      return { kind: 'source', xml };
    },
    async assignments(subjectId) {
      return { kind: 'assignments', assignments: [{ id, labelId: target, subjectId, revision: 1 }] };
    },
  };
}

function MalImportStory({ navigation }: { navigation?: NavigationState } = {}) {
  const port = useMemo(() => makePort(navigation), [navigation]);
  const sample = navigation === 'retained-edge'
    ? `<myanimelist>${Array.from({ length: 11 }, (_, index) => `<anime><series_animedb_id>${42 + index}</series_animedb_id><series_title>Illustrative item ${index + 1}</series_title><my_status>Watching</my_status><my_score>8</my_score></anime>`).join('')}</myanimelist>`
    : xml;
  const visit = useMemo<MalVisit>(() => {
    const controller = new AbortController();
    let custody: MalDeliveryCustody | null = null;
    return {
      subject: target,
      csrfToken: 'story-csrf',
      locale: getLocale(),
      controller,
      current: () => !controller.signal.aborted,
      retire: () => controller.abort(),
      delivery: () => custody,
      retainDelivery: (value) => {
        custody = value;
      },
      resolveDelivery: () => {
        custody = null;
      },
    };
  }, [navigation]);
  return (
    <PatternStory path="/library/import-mal" visitor="Signed In">
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
          Illustrative contract-shaped fixtures. Upload the sample, inspect matched and unmatched items, choose a target
          and review state, labels and score independently. Replacement needs consent. The first apply loses its
          acknowledgement; retry shows mixed results. Readback is a separate action. Opening is still; change locale and
          viewport manually.
        </p>
        <a
          className="underline"
          download="mal-illustrative.xml"
          href={`data:application/xml,${encodeURIComponent(sample)}`}
        >
          Download illustrative export
        </a>
      </aside>
      <MalImportPortContext.Provider value={port}>
        <PersonalMalImportPage key={navigation} visit={visit} />
      </MalImportPortContext.Provider>
    </PatternStory>
  );
}
const meta = {
  title: 'Library/Personal MAL import',
  id: 'families-library-personal-mal-import',
  component: MalImportStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MalImportStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ScoreConsent: Story = {};

export const ObservedPreviousAndFirst: Story = { args: { navigation: 'observed' } };
export const FailedPreviousExactRetry: Story = { args: { navigation: 'failed-previous' } };
export const RetainedEdgeFirst: Story = { args: { navigation: 'retained-edge' } };
