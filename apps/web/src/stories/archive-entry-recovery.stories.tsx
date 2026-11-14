import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { ArchiveEntryRecoveryJourney } from '../library/archive-entry-recovery/controller';
import { ArchiveEntryRecoveryView } from '../library/archive-entry-recovery/page';
import type {
  ArchiveRecoveryPort,
  ArchiveReviewItem,
  ArchiveRow,
  NativeArchiveStatus,
} from '../library/archive-entry-recovery/native';
import { m } from '../paraglide/messages.js';
import { PageStory, PatternStory } from './page';

const meta = {
  title: 'Library/Archive recovery',
  id: 'pages-library-archive-recovery',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const UploadReady: Story = {
  render: () => <PageStory visitor="Signed In" path="/library/recover-archive" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.library_archive_title() })).toBeVisible();
    const main = within(canvas.getByRole('main'));
    await expect(main.getByLabelText(m.library_archive_choose_file())).toBeEnabled();
    await expect(main.getByText(m.library_archive_entry_upload_help())).toBeVisible();
    await expect(main.getByRole('link', { name: m.library_archive_return() })).toBeVisible();
    await expect(main.getByRole('link', { name: m.library_archive_export() })).toBeVisible();
  },
};

// Contract-shaped replies are presentation fixtures, separate from native restore proof.
const uploadId = '00000000-0000-4000-8000-000000000041';
const subjectId = '00000000-0000-4000-8000-000000000042';
const labelId = '00000000-0000-4000-8000-000000000043';
type EntryStage = 'review' | 'unsupported' | 'sparse' | 'unknown' | 'complete';
function EntryStory({ stage }: { stage: EntryStage }) {
  const [journey, setJourney] = useState<ArchiveEntryRecoveryJourney | null>(null);
  useEffect(() => {
    let active = true;
    let reviewRevision = 0;
    let attempts = 0;
    let choices: ArchiveReviewItem[] = [];
    const status: NativeArchiveStatus = {
      uploadId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      state: 'ready',
      rows: 4,
      recordBytes: 1500,
      coverage: [
        { section: 'labels', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
        { section: 'annotations', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
        { section: 'journals', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
        { section: 'holdings', rows: 1, capture: 'present', treatment: 'retained-unsupported' },
      ],
    };
    const rows: ArchiveRow[] = [
      {
        ordinal: 2,
        section: 'labels',
        evidence: { label_id: labelId, normalized_name: 'Weekend reading' },
        status: 'unresolved',
        review: null,
        reviewRevision: 0,
      },
      {
        ordinal: 5,
        section: 'annotations',
        evidence: { subjectId, note: 'Keep this private note', priority: 0 },
        status: 'unresolved',
        review: null,
        reviewRevision: 0,
      },
      {
        ordinal: 8,
        section: 'journals',
        evidence: {
          subjectId,
          journal: {
            startDate: null,
            finishDate: null,
            reflection: 'A second reading',
            assessment: { meaningRevision: 1, units: 0 },
          },
        },
        status: 'unresolved',
        review: null,
        reviewRevision: 0,
      },
      {
        ordinal: 12,
        section: 'holdings',
        evidence: { copy_id: labelId, note: 'Retained physical copy evidence' },
        status: 'unsupported',
        review: null,
        reviewRevision: 0,
      },
    ];
    const port: ArchiveRecoveryPort = {
      upload: async () => ({ kind: 'ok', value: status }),
      status: async () => ({ kind: 'ok', value: status }),
      preview: async (_id, after) => ({
        kind: 'ok',
        value: {
          uploadId,
          state: 'ready',
          coverage: status.coverage,
          records: stage === 'sparse' && (after ?? -1) === -1 ? [] : rows,
          next: stage === 'sparse' && (after ?? -1) === -1 ? 12 : null,
        },
      }),
      review: async (_id, selected) => {
        choices = selected;
        reviewRevision++;
        for (const choice of selected) {
          const row = rows.find((item) => item.ordinal === choice.ordinal)!;
          row.reviewRevision = reviewRevision;
          row.status = choice.kind === 'label' ? 'create' : 'mapped';
          row.review =
            choice.kind === 'label'
              ? { mode: 'create', name: 'Weekend reading' }
              : {
                  fields: 'fields' in choice ? choice.fields : {},
                  current:
                    choice.kind === 'annotation'
                      ? { note: 'Current note to replace', priority: 9, annotationRevision: 3 }
                      : {
                          startDate: null,
                          finishDate: null,
                          reflection: 'Current reflection',
                          assessment: { meaningRevision: 1, units: 0 },
                          journalRevision: 2,
                        },
                };
        }
        return {
          kind: 'ok',
          value: {
            uploadId,
            reviewed: selected.map(({ ordinal }) => ({
              ordinal,
              status: rows.find((row) => row.ordinal === ordinal)!.status,
              reviewRevision,
            })),
          },
        };
      },
      apply: async () =>
        stage === 'unknown' && attempts++ === 0
          ? { kind: 'uncertain' }
          : {
              kind: 'ok',
              value: {
                uploadId,
                applied: choices.map((choice) => ({
                  ordinal: choice.ordinal,
                  status: 'acknowledged',
                  result:
                    choice.kind === 'label'
                      ? { effect: 'label.create', labelId, revision: 1 }
                      : choice.kind === 'journal'
                        ? { effect: 'progress_session.journal', sessionId: choice.sessionId, journalRevision: 3 }
                        : {
                            effect: 'entry.annotations.save',
                            subjectId,
                            incarnationId: labelId,
                            annotationRevision: 4,
                            visibility: 'private',
                          },
                })),
              },
            },
      results: async () => ({ kind: 'ok', value: { uploadId, state: 'ready', results: [], next: null } }),
      cancel: async () => ({ kind: 'ok', value: { ...status, state: 'cancelled' } }),
      prune: async () => ({ kind: 'ok', value: { uploadId, removed: 4, complete: true } }),
      entry: async () => ({ kind: 'refused', status: 404, code: 'not_found' }),
      personal: async () => ({ kind: 'refused', status: 404, code: 'not_found' }),
      journal: async () => ({ kind: 'refused', status: 404, code: 'not_found' }),
      label: async () => ({ kind: 'refused', status: 404, code: 'not_found' }),
    };
    const mounted = new ArchiveEntryRecoveryJourney(
      port,
      () =>
        active
          ? {
              viewer: uploadId,
              credentialEpoch: 'story-credential',
              csrfEpoch: 'story-credential',
              admission: 'story-admission',
              source: 'synthetic-archive',
              route: '/library/recover-archive',
              locale: getLocale(),
              exposure: 'story-exposure',
            }
          : null,
      Date.now() + 3_600_000,
    );
    setJourney(mounted);
    void (async () => {
      await mounted.upload(new File(['synthetic completed archive'], 'library.json'));
      if (stage === 'sparse' || stage === 'unsupported') return;
      mounted.choose({ ordinal: 2, kind: 'label', target: { mode: 'create' } });
      mounted.choose({
        ordinal: 5,
        kind: 'annotation',
        subjectId,
        incarnationId: labelId,
        fields: { note: 'set', priority: 'clear' },
      });
      mounted.choose({
        ordinal: 8,
        kind: 'journal',
        subjectId,
        sessionId: labelId,
        fields: { startDate: 'preserve', finishDate: 'preserve', reflection: 'set', assessment: 'preserve' },
      });
      await mounted.review();
      if (stage === 'unknown' || stage === 'complete') await mounted.apply();
    })();
    return () => {
      active = false;
      mounted.retire();
    };
  }, [stage]);
  return (
    <PatternStory visitor="Signed In" path="/library/recover-archive">
      <ArchiveEntryRecoveryView journey={journey} />
    </PatternStory>
  );
}
export const PopulatedReview: Story = {
  render: () => <EntryStory stage="review" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const apply = await canvas.findByRole('button', { name: m.library_archive_entry_apply() });
    await expect(apply).toBeDisabled();
    await expect(canvas.getByText(m.library_archive_present_clear_warning())).toBeVisible();
    await userEvent.click(canvas.getByRole('checkbox', { name: m.library_archive_entry_confirm() }));
    await expect(apply).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.library_archive_entry_review() }));
    await expect(canvas.getByRole('button', { name: m.library_archive_entry_apply() })).toBeDisabled();
  },
};
export const UnsupportedEvidence: Story = {
  render: () => <EntryStory stage="unsupported" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        m.library_export_section_holdings() + ' · ' + m.library_archive_recovery_effect_unsupported(),
      ),
    ).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.library_archive_entry_select({ ordinal: 12 }) })).toBeNull();
  },
};
export const SparseContinuation: Story = {
  render: () => <EntryStory stage="sparse" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.library_archive_entry_empty())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.library_archive_entry_next() })).toBeEnabled();
  },
};
export const UnknownApplicationRecovery: Story = {
  render: () => <EntryStory stage="unknown" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('button', { name: m.library_archive_recovery_retry_original() }),
    ).toBeEnabled();
    await expect(canvas.queryByRole('link', { name: m.library_archive_entry_subject() })).toBeNull();
  },
};
export const CompletedResult: Story = {
  render: () => <EntryStory stage="complete" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.library_archive_recovery_complete_title())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_archive_progress_open_session() })).toHaveAttribute(
      'href',
      expect.stringContaining(labelId),
    );
  },
};
