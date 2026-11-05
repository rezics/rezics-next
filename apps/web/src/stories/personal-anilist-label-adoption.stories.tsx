import { useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AniListLabelAdoption } from '../library/personal-anilist-import/labels';
import type { AniListLabelReview, AniListRow } from '../library/personal-anilist-import/contract';
import { createAniListJourney } from '../library/personal-anilist-import/controller';
import { PatternStory } from './page';
import { m } from '../paraglide/messages.js';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const label = '0192f3a0-6c1e-7b2a-9d4e-00000000dddd';
const review: AniListLabelReview = {
  id: '0192f3a0-6c1e-7b2a-9d4e-00000000cccc',
  subjectId: subject,
  identityEpoch: '1',
  sourceDigest: 'retained-source',
  matchFingerprint: 'canonical-match',
  clientId: 'web',
  requestedBy: null,
  items: [
    {
      key: 'customLists:Private favourites',
      value: 'Private favourites',
      origin: 'customLists',
      target: { name: 'Private favourites', primary: 0 },
      createKey: 'retained-create',
      assignKey: 'retained-assign',
    },
  ],
};
function LabelStory({ state }: { state: 'evidence' | 'review' | 'pending' | 'current' }) {
  const journey = useMemo(() => {
    const row: AniListRow = {
      ordinal: 0,
      source: {
        evidence: { title: 'Retained AniList custom lists' },
        identifiers: [],
        group: { name: 'Completed', isCustomList: false },
        fields: [],
      },
      match: { state: 'matched', candidates: [subject], fingerprint: 'canonical-match' },
      proposal: null,
      review: null,
      started: true,
      outcome: { ordinal: 0, status: 'applied', retained: ['score'] },
      labelEvidence: {
        membership: 'available',
        grouping: 'default',
        values: [
          { key: 'customLists:Private favourites', value: 'Private favourites', origin: 'customLists', member: true },
          { key: 'customLists:Not selected', value: 'Not selected', origin: 'customLists', member: false },
        ],
        selectable: [
          { key: 'customLists:Private favourites', value: 'Private favourites', origin: 'customLists', member: true },
        ],
        tagEvidence: { entry: 'missing', media: 'unsupported', membership: 'unavailable' },
        tags: 'unsupported',
        reason: 'Only supported positive custom-list evidence can be selected.',
      },
      ...(state === 'evidence' ? {} : { labelReview: review }),
      ...(state === 'pending' ? { labelWork: { 0: { createStarted: true, label: { id: label, revision: 1 } } } } : {}),
      ...(state === 'current'
        ? {
            labelWork: {
              0: {
                createStarted: true,
                assignStarted: true,
                label: { id: label, revision: 1 },
                outcome: {
                  key: review.items[0]!.key,
                  status: 'applied',
                  label: { id: label, revision: 1 },
                  assignment: { id: 'native-assignment', revision: 1 },
                },
              },
            },
            currentLabels: [{ id: 'native-assignment', labelId: label, name: 'Private favourites', revision: 1 }],
          }
        : {}),
    };
    const current = createAniListJourney({
      visit: {
        subject: 'story-owner',
        csrfToken: 'story-credential',
        controller: new AbortController(),
        current: () => true,
        retire: () => {},
      },
      port: {
        async page() {
          return {
            kind: 'page',
            page: {
              importId: subject,
              header: { count: 1, document: null, rawUpload: '', scoreFormat: null, cancelled: false },
              completeness: { wrapper: 'array', hasNextChunk: false, listedGroups: 1 },
              rows: [row],
              next: null,
            },
          };
        },
        async preview() {
          return { kind: 'unavailable' };
        },
        async review() {
          return { kind: 'unavailable' };
        },
        async apply() {
          return { kind: 'unavailable' };
        },
        async cancel() {
          return { kind: 'unavailable' };
        },
        async admitSource() {
          return { kind: 'unavailable' };
        },
        async question() {
          return { kind: 'unavailable' };
        },
        async reviewLabels() {
          return { kind: 'labels-reviewed', ordinal: 0, review };
        },
        async applyLabels() {
          return { kind: 'unavailable' };
        },
        async readLabels() {
          return { kind: 'labels-read', labels: [] };
        },
        async labelTargets() {
          return { kind: 'label-targets', labels: [], next: null };
        },
      },
    });
    return { row, current };
  }, [state]);
  const [snap, setSnap] = useState(() => journey.current.snapshot());
  // The retained page read is the same entry point used when reopening an upload.
  useEffect(() => {
    void journey.current.loadPage(subject, -1).then(setSnap);
  }, [journey]);
  const rowMeta = snap.meta[0];
  return (
    <PatternStory path="/library/import-anilist" visitor="Signed In">
      <main className="mx-auto max-w-3xl p-4">
        {rowMeta ? (
          <AniListLabelAdoption
            row={journey.row}
            meta={rowMeta}
            busy={false}
            cancelled={false}
            current={() => true}
            onChoose={(target, selections) => setSnap(journey.current.chooseLabels(0, target, selections))}
            onReview={() => void journey.current.reviewLabels(0).then(setSnap)}
            onConfirm={() => {}}
            onRead={() => {}}
            onSearch={journey.current.labelTargets}
          />
        ) : null}
      </main>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Library/AniList label adoption',
  component: LabelStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof LabelStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RetainedEvidence: Story = {
  args: { state: 'evidence' },
  globals: { locale: 'en', viewport: { value: 'phone390' } },
};
export const NativeReview: Story = {
  args: { state: 'review' },
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(m.library_anilist_labels_reviewed())).toBeVisible();
  },
};
export const CreatedAssignmentPending: Story = {
  args: { state: 'pending' },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone390' } },
};
export const CurrentAssignments: Story = {
  args: { state: 'current' },
  globals: { locale: 'en', viewport: { value: 'desktop1280' } },
};
