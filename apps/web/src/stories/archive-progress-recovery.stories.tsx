import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useReducer, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory } from './page';
import { RecoveryJourney } from '../library/archive-progress-recovery/page';
import { ProgressRecoveryJourney } from '../library/archive-progress-recovery/controller';
import type { ProgressChoices } from '../library/progress-profile';
import type { Application, Holdings, Occurrences, ProgressRecoveryPort, Result, Review, ReviewInput } from '../library/archive-progress-recovery/native';

const id = '00000000-0000-4000-8000-000000000031';
const subjectId = '00000000-0000-4000-8000-000000000032';
const sourceId = '00000000-0000-4000-8000-000000000033';
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const manifest: Holdings['manifest'] = {
  format: 'https://rezics.com/formats/library-export', version: 1, exportId: id,
  capturedAt: '2024-02-01T00:00:00.000Z', expiresAt, privacy: 'private',
  completeness: 'supported-native-facts', sections: ['sessions'], omissions: {}, fullExport: false, rows: 1, recordBytes: 500,
};
const operands: ReviewInput = { sessionId: sourceId, subjectId, mode: 'scalar_amount', unit: 'page', additionalMeasures: [], unitIds: [] };
const occurrence: Occurrences['occurrences'][number]['evidence'] = {
  section: 'sessions', session_id: sourceId, subject_id: subjectId,
  subject_id_reference: { id: subjectId, href: `/subjects/${subjectId}` }, version_subject_id: null,
  mode: 'scalar_amount', unit: 'page', total: '300', amount: '0', additional_measures: [],
  locator: null, position: null, completed_unit_count: 0, state: 'active', revision: 4,
  library_profile_pin: null, started_at: '2024-02-01T00:00:00.000Z', completed_at: null,
  last_changed_at: '2024-03-01T00:00:00.000Z',
};
const review: Review = {
  uploadId: id, reviewId: '00000000-0000-4000-8000-000000000034', sourceSessionId: sourceId,
  sourceSubjectId: subjectId, subjectId,
  historical: {
    mode: 'scalar_amount', unit: 'page', total: '300', amount: '0', additionalMeasures: [],
    completedUnitCount: 0, state: 'active', sourceRevision: 4, versionSubjectId: null,
    profilePin: null, sourceTimes: { startedAt: occurrence.started_at, completedAt: null, lastChangedAt: occurrence.last_changed_at },
  },
  current: { profile: { kind: 'supported', subjectId, acceptingType: 'schema:Book' }, mode: 'scalar_amount', unit: 'page' },
  measures: [{ sourceUnit: 'page', sourceAmount: '0', sourceTotal: '300', currentUnit: 'page',
    currentMeaning: { id: 'page', labels: { en: 'Pages', de: 'Seiten', es: 'Páginas', fr: 'Pages', ja: 'ページ', ko: '쪽', 'zh-Hans': '页', 'zh-Hant': '頁' }, identity: { kind: 'none' }, structure: { kind: 'none' } },
    amount: 'supported', total: 'supported' }],
  completedUnits: [], unsupportedHistoricalDates: ['started_at', 'completed_at', 'last_changed_at'],
  unsupported: [], applicable: true, recovery: 'complete', expiresAt,
};
const application: Application = { uploadId: id, reviewId: review.reviewId, state: 'applied', sessionId: id, acceptedSteps: 2, totalSteps: 2, error: null };
const result: Result = {
  uploadId: id, review, application,
  progressSession: { id, accountId: id, subjectId, versionSubjectId: null, mode: 'scalar_amount', unit: 'page', total: '300', amount: '0', locator: null, position: null, completedUnitCount: 0, state: 'active', revision: 2, startedAt: '2026-11-14T00:00:00.000Z', completedAt: null, transactionId: id },
  completedEpisodes: null, expiresAt,
};
type Stage = 'review' | 'unsupported' | 'sparse' | 'unknown' | 'complete';

/** Synthetic contract-shaped replies exercise the real visit; native export-to-restore proof is separate. */
function ProgressStory({ stage }: { stage: Stage }) {
  const [, update] = useReducer((n) => n + 1, 0);
  const [journey, setJourney] = useState<ProgressRecoveryJourney<ProgressChoices> | null>(null);
  useEffect(() => {
    let active = true;
    let applies = 0;
    const shownReview: Review = stage === 'unsupported' ? { ...review, recovery: 'partial',
      unsupported: ['amount:page', 'version-subject-mapping-not-supported'],
      measures: [{ ...review.measures[0]!, amount: 'unsupported', sourceAmount: '999' }] } : review;
    const port: ProgressRecoveryPort<ProgressChoices> = {
      upload: async () => ({ kind: 'ok', value: { uploadId: id, holdings: 0, progressRecords: 1, expiresAt } }),
      holdings: async () => ({ kind: 'ok', value: { uploadId: id, state: 'inspecting', expiresAt,
        fullRestoration: false, effectsSupported: false, holdings: 0, rows: [], next: null, coverage: [],
        manifest } }),
      occurrences: async (_id, after) => ({ kind: 'ok', value: { uploadId: id, state: 'inspecting', expiresAt,
        manifest,
        coverage: [], occurrences: stage === 'sparse' && (after ?? -1) === -1 ? [] : [{ ordinal: 7, evidence: occurrence }], next: stage === 'sparse' && (after ?? -1) === -1 ? 7 : null } }),
      units: async () => ({ kind: 'ok', value: { uploadId: id, sourceSessionId: sourceId, state: 'inspecting', units: [], next: null } }),
      choices: async () => ({ kind: 'ok', value: { subjectId, choices: [{ mode: 'scalar_amount', units: [{ id: 'page', label: '' }] }] } }),
      review: async () => ({ kind: 'ok', value: shownReview }),
      apply: async () => stage === 'unknown' && applies++ === 0 ? { kind: 'uncertain' } : { kind: 'ok', value: application },
      result: async () => ({ kind: 'ok', value: { ...result, review: shownReview } }),
      cancel: async () => ({ kind: 'ok', value: { uploadId: id, cancelled: true } }),
      remove: async () => ({ kind: 'ok', value: { uploadId: id, removed: 1, complete: true } }),
    };
    const mounted = new ProgressRecoveryJourney(port, crypto.randomUUID(), () => active, update);
    setJourney(mounted);
    void (async () => {
      await mounted.upload(new File(['synthetic story archive'], 'library.json'));
      if (stage === 'sparse') return;
      await mounted.select(occurrence);
      await mounted.mapSubject(subjectId);
      await mounted.review(operands);
      if (stage === 'complete' || stage === 'unknown') await mounted.confirm(review.reviewId);
    })();
    return () => { active = false; mounted.retire(); };
  }, [stage]);
  return journey ? <RecoveryJourney journey={journey} snap={journey.snapshot()} owner={id} /> : null;
}
const meta = { title: 'Library/Archive progress recovery', id: 'pages-library-archive-progress-recovery', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const UploadReady: Story = { render: () => <PageStory visitor="Signed In" path="/library/recover-progress" /> };
export const PopulatedReview: Story = {
  render: () => <ProgressStory stage="review" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.library_archive_present_review_complete())).toBeVisible();
    const confirm = canvas.getByRole('button', { name: m.library_archive_progress_confirm() });
    await expect(confirm).toBeDisabled();
    const exact = canvas.getByText(m.library_archive_progress_exact());
    await expect(exact.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(canvas.getByRole('checkbox', { name: m.library_archive_progress_consent() }));
    await expect(confirm).toBeEnabled();
  },
};
export const UnsupportedEvidence: Story = { render: () => <ProgressStory stage="unsupported" /> };
export const SparseContinuation: Story = {
  render: () => <ProgressStory stage="sparse" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.library_archive_progress_empty())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.buyer_history_next() })).toBeEnabled();
  },
};
export const UnknownApplicationRecovery: Story = { render: () => <ProgressStory stage="unknown" /> };
export const CompletedResult: Story = { render: () => <ProgressStory stage="complete" /> };
